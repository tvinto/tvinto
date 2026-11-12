import { asEpgPrograms, millisecondsOf, onNow } from './guide.utils';

/**
 * Reading a guide that arrives in three different spellings.
 *
 * Worth testing because getting it wrong is silent. A programme whose start is
 * read in the wrong unit does not throw -- it lands in 1970 or in the year
 * fifty thousand, and the row it belongs to simply draws empty.
 */

const SECONDS = 1_757_000_000;
const MILLISECONDS = SECONDS * 1000;

/** The same moment as the constants above, spelled the way the backend did. */
const AS_WRITTEN_OUT = new Date(MILLISECONDS).toISOString();

describe('millisecondsOf', () => {
  it('takes seconds as seconds', () => {
    expect(millisecondsOf(SECONDS)).toBe(MILLISECONDS);
  });

  it('takes milliseconds as milliseconds', () => {
    expect(millisecondsOf(MILLISECONDS)).toBe(MILLISECONDS);
  });

  it('takes either of them written as a string', () => {
    expect(millisecondsOf(String(SECONDS))).toBe(MILLISECONDS);
    expect(millisecondsOf(String(MILLISECONDS))).toBe(MILLISECONDS);
  });

  it('takes a date the backend wrote out in full', () => {
    expect(millisecondsOf(AS_WRITTEN_OUT)).toBe(MILLISECONDS);
  });

  it('says nothing usable rather than the epoch', () => {
    // A programme at the epoch is drawn, and drawn wrongly. One that is not a
    // number at all should be droppable by whoever asked.
    expect(Number.isNaN(millisecondsOf('not a time'))).toBe(true);
    expect(Number.isNaN(millisecondsOf(undefined))).toBe(true);
    expect(Number.isNaN(millisecondsOf(null))).toBe(true);
  });
});

describe('asEpgPrograms', () => {
  it('reads the device guide, which counts in milliseconds', () => {
    const [programme] = asEpgPrograms([
      { channel: 'HRT1.hr', start: MILLISECONDS, stop: MILLISECONDS + 3_600_000, title: 'Dnevnik' }
    ]);

    expect(programme.start_timestamp).toBe(SECONDS);
    expect(programme.stop_timestamp).toBe(SECONDS + 3600);
    expect(programme.title).toBe('Dnevnik');
  });

  it("reads Xtream's own listing, which counts in seconds", () => {
    const [programme] = asEpgPrograms([
      { start_timestamp: SECONDS, stop_timestamp: SECONDS + 1800, title: 'Vijesti' }
    ]);

    expect(programme.start_timestamp).toBe(SECONDS);
    expect(programme.stop_timestamp).toBe(SECONDS + 1800);
  });

  it('reads the backend rows, which wrote the dates out', () => {
    const [programme] = asEpgPrograms([
      { start: AS_WRITTEN_OUT, stop: new Date(MILLISECONDS + 3_600_000).toISOString(), title: 'Ritam Srca' }
    ]);

    expect(programme.start_timestamp).toBe(SECONDS);
  });

  it('puts them in the order they are on, whatever order they came in', () => {
    const titles = asEpgPrograms([
      { start: MILLISECONDS + 7_200_000, title: 'Third' },
      { start: MILLISECONDS, title: 'First' },
      { start: MILLISECONDS + 3_600_000, title: 'Second' }
    ]).map(programme => programme.title);

    expect(titles).toEqual(['First', 'Second', 'Third']);
  });

  it('drops what it cannot place rather than putting it in 1970', () => {
    expect(asEpgPrograms([{ title: 'No time at all' }])).toEqual([]);
  });
});

describe('onNow', () => {
  const programmes = asEpgPrograms([
    { start: MILLISECONDS, stop: MILLISECONDS + 3_600_000, title: 'Now' },
    { start: MILLISECONDS + 3_600_000, stop: MILLISECONDS + 7_200_000, title: 'Next' },
    { start: MILLISECONDS + 7_200_000, stop: MILLISECONDS + 10_800_000, title: 'After that' }
  ]);

  it('finds the one running and the one after it', () => {
    const { current, next } = onNow(programmes, MILLISECONDS + 600_000);

    expect(current?.title).toBe('Now');
    expect(next?.title).toBe('Next');
  });

  it('has nothing on when the guide has run out', () => {
    const { current, next } = onNow(programmes, MILLISECONDS + 100_000_000);

    expect(current).toBeNull();
    expect(next).toBeNull();
  });

  it('has a next but nothing on, before the guide starts', () => {
    const { current, next } = onNow(programmes, MILLISECONDS - 600_000);

    expect(current).toBeNull();
    expect(next?.title).toBe('Now');
  });
});
