import { XmltvChannel, XmltvProgramme } from './xmltv';
import { collectXmltv, readXmltv } from './xmltvReader';

/** Feeds text in fixed-size pieces, so element boundaries fall anywhere. */
const inPieces = async function* (text: string, size: number): AsyncIterable<string> {
  for (let index = 0; index < text.length; index += size) {
    yield text.slice(index, index + size);
  }
};

const whole = async function* (text: string): AsyncIterable<string> {
  yield text;
};

const programme = (channel: string, title: string) =>
  `<programme channel="${channel}" start="1" stop="2"><title>${title}</title></programme>`;

const document = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><tv>${inner}</tv>`;

describe('readXmltv', () => {
  it('finds channels and programmes in a whole document', async () => {
    const guide = await collectXmltv(
      whole(
        document(
          '<channel id="a"><display-name>A</display-name></channel>' + programme('a', 'Dnevnik')
        )
      )
    );

    expect(guide.channels).toEqual([{ id: 'a', name: 'A' }]);
    expect(guide.programmes[0]).toMatchObject({ channel: 'a', title: 'Dnevnik' });
  });

  // The entire point of the reader: on the desktop this arrives as a stream,
  // and an element split across two chunks must not be lost or halved.
  it('reads elements split across chunk boundaries, at every boundary', async () => {
    const xml = document(
      '<channel id="a"><display-name>A</display-name></channel>' +
        programme('a', 'Dnevnik') +
        programme('a', 'Vijesti')
    );

    for (const size of [1, 2, 3, 7, 13, 64, 4096]) {
      const guide = await collectXmltv(inPieces(xml, size));

      expect(guide.channels).toHaveLength(1);
      expect(guide.programmes.map(p => p.title)).toEqual(['Dnevnik', 'Vijesti']);
    }
  });

  // A CDATA section may contain anything, including a closing tag. Cutting the
  // element there would truncate the guide from that point on.
  it('does not end an element on a closing tag hidden inside CDATA', async () => {
    const xml = document(
      '<programme channel="a" start="1" stop="2">' +
        '<desc><![CDATA[Ends with </programme> in the text]]></desc>' +
        '<title>Real title</title>' +
        '</programme>'
    );

    const guide = await collectXmltv(inPieces(xml, 5));

    expect(guide.programmes).toHaveLength(1);
    expect(guide.programmes[0].title).toBe('Real title');
    expect(guide.programmes[0].description).toBe('Ends with </programme> in the text');
  });

  // `>` is legal inside an attribute value, and scanning for the first one
  // would cut the start tag in half.
  it('does not end a start tag on a > inside an attribute', async () => {
    const xml = document('<programme channel="a>b" start="1" stop="2"><title>T</title></programme>');

    const guide = await collectXmltv(inPieces(xml, 3));

    expect(guide.programmes[0].channel).toBe('a>b');
    expect(guide.programmes[0].title).toBe('T');
  });

  it('reads a self-closing programme, which carries everything in attributes', async () => {
    const guide = await collectXmltv(
      whole(document('<programme channel="a" start="1" stop="2"/>'))
    );

    expect(guide.programmes).toHaveLength(1);
    expect(guide.programmes[0]).toMatchObject({ channel: 'a', start: '1', title: '' });
  });

  it('ignores elements that merely start like the ones it wants', async () => {
    const guide = await collectXmltv(
      whole(document('<channels-count>3</channels-count>' + programme('a', 'T')))
    );

    expect(guide.channels).toHaveLength(0);
    expect(guide.programmes).toHaveLength(1);
  });

  it('hands elements over in batches rather than all at once', async () => {
    const xml = document(
      Array.from({ length: 10 }, (_unused, index) => programme('a', `P${index}`)).join('')
    );

    const batches: number[] = [];
    const totals = await readXmltv(
      inPieces(xml, 32),
      {
        channels: () => undefined,
        programmes: (batch: XmltvProgramme[]) => {
          batches.push(batch.length);
        }
      },
      { batchSize: 4 }
    );

    expect(totals.programmes).toBe(10);
    expect(batches).toEqual([4, 4, 2]);
  });

  it('counts channels and programmes separately', async () => {
    const xml = document(
      '<channel id="a"><display-name>A</display-name></channel>' +
        '<channel id="b"><display-name>B</display-name></channel>' +
        programme('a', 'One') +
        programme('b', 'Two') +
        programme('b', 'Three')
    );

    const seen: XmltvChannel[] = [];
    const totals = await readXmltv(inPieces(xml, 9), {
      channels: batch => {
        seen.push(...batch);
      },
      programmes: () => undefined
    });

    expect(totals).toEqual({ channels: 2, programmes: 3 });
    expect(seen.map(c => c.id)).toEqual(['a', 'b']);
  });

  // Without a cap, a response that never closes an element is accumulated
  // until the device runs out of memory -- and an HTML error page is exactly
  // that.
  it('gives up rather than growing without limit on something that is not XMLTV', async () => {
    const notAGuide = '<html><body>' + 'x'.repeat(5000) + '</body></html>';

    await expect(
      collectXmltv(inPieces(notAGuide, 100), { maxPendingChars: 1000 })
    ).rejects.toThrow(/not readable/);
  });

  it('keeps only the unread tail, so the buffer is not the document', async () => {
    // Twenty thousand programmes, fed in small pieces, with a pending cap far
    // below the document size. It can only pass if the buffer is being trimmed.
    const xml = document(
      Array.from({ length: 20_000 }, (_unused, index) => programme('a', `P${index}`)).join('')
    );

    const totals = await readXmltv(
      inPieces(xml, 512),
      { channels: () => undefined, programmes: () => undefined },
      { maxPendingChars: 8 * 1024 }
    );

    expect(totals.programmes).toBe(20_000);
  });

  it('waits for the sink before reading on, so a slow writer is not outrun', async () => {
    const xml = document(
      Array.from({ length: 6 }, (_unused, index) => programme('a', `P${index}`)).join('')
    );

    let inFlight = 0;
    let overlapped = false;

    await readXmltv(
      inPieces(xml, 16),
      {
        channels: () => undefined,
        programmes: async () => {
          inFlight += 1;
          if (inFlight > 1) {
            overlapped = true;
          }
          await new Promise(resolve => setTimeout(resolve, 1));
          inFlight -= 1;
        }
      },
      { batchSize: 2 }
    );

    expect(overlapped).toBe(false);
  });

  it('reads Croatian titles unchanged when the split falls inside one', async () => {
    const xml = document(programme('a', 'Čudnovate zgode šegrta Hlapića'));

    const guide = await collectXmltv(inPieces(xml, 1));

    expect(guide.programmes[0].title).toBe('Čudnovate zgode šegrta Hlapića');
  });

  it('returns nothing for an empty document rather than failing', async () => {
    expect(await collectXmltv(whole(document('')))).toEqual({ channels: [], programmes: [] });
  });
});
