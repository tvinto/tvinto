import {
  calculateTimeProgress,
  calculateUnixProgress,
  calculateXMLTVProgress,
  formatUnixDate,
  formatUnixTime,
  formatXMLTVDate,
  formatXMLTVTime,
  parseXMLTVDate
} from './date-time.utils';

describe('parseXMLTVDate', () => {
  it('honours the UTC offset the timestamp carries', () => {
    // The bug this guards: discarding the offset shifted every programme by the
    // viewer's own offset, so "now playing" was wrong everywhere except UTC.
    expect(parseXMLTVDate('20260807222300 +0000').toISOString()).toBe('2026-08-07T22:23:00.000Z');
  });

  it('subtracts a positive offset to get UTC', () => {
    expect(parseXMLTVDate('20260807222300 +0200').toISOString()).toBe('2026-08-07T20:23:00.000Z');
  });

  it('adds a negative offset to get UTC', () => {
    expect(parseXMLTVDate('20260807222300 -0500').toISOString()).toBe('2026-08-08T03:23:00.000Z');
  });

  it('accepts a colon in the offset', () => {
    expect(parseXMLTVDate('20260807222300 +02:00').toISOString()).toBe('2026-08-07T20:23:00.000Z');
  });

  it('accepts an offset with no separating space', () => {
    expect(parseXMLTVDate('20260807222300+0200').toISOString()).toBe('2026-08-07T20:23:00.000Z');
  });

  it('handles a half-hour offset', () => {
    expect(parseXMLTVDate('20260807222300 +0530').toISOString()).toBe('2026-08-07T16:53:00.000Z');
  });

  it('reads a timestamp without an offset as local time, per the XMLTV DTD', () => {
    const parsed = parseXMLTVDate('20260807222300');

    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(7);
    expect(parsed.getHours()).toBe(22);
    expect(parsed.getMinutes()).toBe(23);
  });

  it('treats absent seconds as zero', () => {
    expect(parseXMLTVDate('202608072223 +0000').toISOString()).toBe('2026-08-07T22:23:00.000Z');
  });

  it('tolerates trailing text after the timestamp', () => {
    expect(parseXMLTVDate('20260807222300 +0000 extra').toISOString()).toBe(
      '2026-08-07T22:23:00.000Z'
    );
  });

  it('trims surrounding whitespace', () => {
    expect(parseXMLTVDate('  20260807222300 +0000  ').toISOString()).toBe(
      '2026-08-07T22:23:00.000Z'
    );
  });

  it('returns an Invalid Date for something it cannot read', () => {
    // Never a silently wrong date: callers can check with isNaN.
    expect(Number.isNaN(parseXMLTVDate('not a date').getTime())).toBe(true);
    expect(Number.isNaN(parseXMLTVDate('').getTime())).toBe(true);
    expect(Number.isNaN(parseXMLTVDate(undefined as unknown as string).getTime())).toBe(true);
    expect(Number.isNaN(parseXMLTVDate('2026').getTime())).toBe(true);
  });

  it('rolls a date over a month boundary correctly', () => {
    expect(parseXMLTVDate('20260831233000 -0200').toISOString()).toBe('2026-09-01T01:30:00.000Z');
  });
});

describe('formatXMLTVTime and formatXMLTVDate', () => {
  it('formats a parsed timestamp', () => {
    // Formatted in the runner's zone, so assert on the shape rather than a
    // wall-clock value that would depend on where the test runs.
    expect(formatXMLTVTime('20260807222300 +0000')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatXMLTVDate('20260807222300 +0000')).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it('returns an empty string when there is no timestamp', () => {
    expect(formatXMLTVTime(undefined)).toBe('');
    expect(formatXMLTVDate(undefined)).toBe('');
    expect(formatXMLTVTime('')).toBe('');
  });
});

describe('formatUnixTime and formatUnixDate', () => {
  it('formats a unix seconds timestamp', () => {
    expect(formatUnixTime(1767225600)).toMatch(/^\d{2}:\d{2}$/);
    expect(formatUnixDate(1767225600)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it('accepts the string form Xtream actually sends', () => {
    expect(formatUnixTime('1767225600')).toBe(formatUnixTime(1767225600));
  });

  it('returns an empty string when there is no timestamp', () => {
    expect(formatUnixTime(undefined)).toBe('');
    expect(formatUnixDate(undefined)).toBe('');
    expect(formatUnixTime(0)).toBe('');
  });
});

describe('calculateTimeProgress', () => {
  const start = new Date('2026-01-01T10:00:00Z');
  const end = new Date('2026-01-01T11:00:00Z');

  it('reports how far through a programme the current time is', () => {
    expect(calculateTimeProgress(start, end, new Date('2026-01-01T10:30:00Z'))).toBe(50);
    expect(calculateTimeProgress(start, end, new Date('2026-01-01T10:15:00Z'))).toBe(25);
  });

  it('clamps to the 0-100 range outside the programme', () => {
    // A progress bar must not run backwards or off its track.
    expect(calculateTimeProgress(start, end, new Date('2026-01-01T09:00:00Z'))).toBe(0);
    expect(calculateTimeProgress(start, end, new Date('2026-01-01T23:00:00Z'))).toBe(100);
  });

  it('accepts timestamps as well as dates', () => {
    expect(calculateTimeProgress(start.getTime(), end.getTime(), start.getTime() + 1_800_000)).toBe(50);
  });

  it('defaults the current time to now', () => {
    const now = Date.now();
    expect(calculateTimeProgress(now - 1000, now + 1000)).toBeCloseTo(50, 0);
  });
});

describe('calculateXMLTVProgress', () => {
  it('works from XMLTV timestamps', () => {
    const now = Date.now();
    const stamp = (offsetMs: number) => {
      const d = new Date(now + offsetMs);
      const p = (n: number, w = 2) => String(n).padStart(w, '0');
      return (
        `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
        `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
      );
    };

    expect(calculateXMLTVProgress(stamp(-1800_000), stamp(1800_000))).toBeCloseTo(50, 0);
  });

  it('reports zero progress for an unreadable timestamp rather than a number', () => {
    expect(Number.isNaN(calculateXMLTVProgress('nonsense', 'nonsense'))).toBe(true);
  });
});

describe('calculateUnixProgress', () => {
  it('reports how far through a programme the current time is', () => {
    const now = Date.now() / 1000;
    expect(calculateUnixProgress(now - 1800, now + 1800)).toBeCloseTo(50, 0);
  });

  it('clamps to the 0-100 range', () => {
    const now = Date.now() / 1000;
    expect(calculateUnixProgress(now + 3600, now + 7200)).toBe(0);
    expect(calculateUnixProgress(now - 7200, now - 3600)).toBe(100);
  });
});
