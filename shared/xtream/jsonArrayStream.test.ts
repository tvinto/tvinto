import { jsonArrayObjects } from './jsonArrayStream';

/** Splits text into byte chunks of a given size, cutting through characters and strings. */
async function* chunked(text: string, size: number): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.slice(i, i + size);
  }
}

const collect = async (text: string, size = 7) => {
  const out: Record<string, unknown>[] = [];
  for await (const item of jsonArrayObjects(chunked(text, size))) {
    out.push(item);
  }
  return out;
};

describe('jsonArrayObjects', () => {
  const LIST = [
    { stream_id: 1, name: 'Sjeverni pol', category_id: '10' },
    { stream_id: 2, name: 'Braces } and ] and "quotes" \\ in a name', tags: ['a', { b: 1 }] },
    { stream_id: 3, name: 'Šapat — Čiro ⱽᴵᴾ', category_id: '20' }
  ];

  it('yields every object, however the bytes are cut', async () => {
    const text = JSON.stringify(LIST);
    for (const size of [1, 2, 3, 7, 64, 4096]) {
      expect(await collect(text, size)).toEqual(LIST);
    }
  });

  it('copes with whitespace and pretty printing', async () => {
    expect(await collect(JSON.stringify(LIST, null, 2), 5)).toEqual(LIST);
  });

  it('yields nothing for an empty array', async () => {
    expect(await collect('[]')).toEqual([]);
    expect(await collect('  [ ]  ')).toEqual([]);
  });

  it('reads a list keyed by id as its values', async () => {
    const keyed = { a: LIST[0], b: LIST[2] };
    expect(await collect(JSON.stringify(keyed), 4)).toEqual([LIST[0], LIST[2]]);
  });

  it('throws on a broken object rather than skipping it', async () => {
    await expect(collect('[{"stream_id": 1, "name": }]')).rejects.toThrow();
  });
});
