import { guideTextFromBytes } from './guideBytes';
import { collectXmltv } from './xmltvReader';

const encode = (text: string) => new TextEncoder().encode(text);

/** Yields bytes in fixed-size pieces, so characters straddle the boundaries. */
const inPieces = async function* (bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let index = 0; index < bytes.length; index += size) {
    yield bytes.slice(index, index + size);
  }
};

const once = async function* (bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
};

/** Compresses with the same web API the module decompresses with. */
const gzip = async (text: string): Promise<Uint8Array> => {
  const stream = new Blob([encode(text)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const collect = async (chunks: AsyncIterable<string>): Promise<string> => {
  let text = '';
  for await (const chunk of chunks) {
    text += chunk;
  }
  return text;
};

describe('guideTextFromBytes', () => {
  it('passes plain text through', async () => {
    expect(await collect(guideTextFromBytes(once(encode('<tv></tv>'))))).toBe('<tv></tv>');
  });

  it('decompresses a gzipped guide', async () => {
    const compressed = await gzip('<tv><channel id="a"/></tv>');

    expect(await collect(guideTextFromBytes(once(compressed)))).toBe('<tv><channel id="a"/></tv>');
  });

  // The name is only a hint: servers compress without saying so and say so
  // without doing it. The first two bytes are the only dependable signal.
  it('recognises gzip by its magic number rather than by the file name', async () => {
    const compressed = await gzip('<tv>compressed</tv>');

    // Fed with no filename and no headers at all.
    expect(await collect(guideTextFromBytes(inPieces(compressed, 7)))).toBe('<tv>compressed</tv>');
  });

  it('decompresses when the gzip stream is split across chunks', async () => {
    const compressed = await gzip('<tv>' + 'x'.repeat(5000) + '</tv>');

    for (const size of [1, 2, 13, 512]) {
      expect(await collect(guideTextFromBytes(inPieces(compressed, size)))).toHaveLength(5009);
    }
  });

  // The same failure as decoding Base64 without a TextDecoder, arriving by a
  // different route: a two-byte character split between chunks becomes two
  // wrong ones unless the decoder carries the partial character across.
  it('reassembles a multi-byte character split across two chunks', async () => {
    const text = 'Čudnovate zgode šegrta Hlapića — Đuro i Žarko';
    const bytes = encode(text);

    for (const size of [1, 2, 3, 5, 8]) {
      expect(await collect(guideTextFromBytes(inPieces(bytes, size)))).toBe(text);
    }
  });

  it('reassembles multi-byte characters split inside a gzipped stream too', async () => {
    const text = '<tv><title>Čudnovate zgode šegrta Hlapića</title></tv>';
    const compressed = await gzip(text);

    expect(await collect(guideTextFromBytes(inPieces(compressed, 3)))).toBe(text);
  });

  it('reports progress as the text arrives', async () => {
    const seen: number[] = [];
    await collect(
      guideTextFromBytes(inPieces(encode('a'.repeat(100)), 25), {
        onProgress: chars => seen.push(chars)
      })
    );

    expect(seen).toEqual([25, 50, 75, 100]);
  });

  it('refuses a guide larger than it was told to accept', async () => {
    await expect(
      collect(guideTextFromBytes(inPieces(encode('x'.repeat(5000)), 100), { maxChars: 1000 }))
    ).rejects.toThrow(/larger than/);
  });

  it('yields nothing at all for an empty response', async () => {
    expect(await collect(guideTextFromBytes(once(new Uint8Array())))).toBe('');
  });

  // The two halves are meant to be used together, and neither ever holds the
  // whole guide.
  it('feeds the reader directly, gzip and all', async () => {
    const xml =
      '<tv><channel id="hrt1"><display-name>HRT 1</display-name></channel>' +
      '<programme channel="hrt1" start="1" stop="2"><title>Čudnovate zgode</title></programme></tv>';
    const compressed = await gzip(xml);

    const guide = await collectXmltv(guideTextFromBytes(inPieces(compressed, 4)));

    expect(guide.channels).toEqual([{ id: 'hrt1', name: 'HRT 1' }]);
    expect(guide.programmes[0].title).toBe('Čudnovate zgode');
  });
});
