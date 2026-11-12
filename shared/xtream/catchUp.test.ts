import { archiveDays, catchUpKind, catchUpStretch, providerClockFrom, providerClockTime } from './catchUp';
import { buildCatchUpUrl, normaliseStreams } from './protocol';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Saturday 26 September 2026, 21:00 UTC: 23:00 in Amsterdam, summer time.
const NOW = Date.UTC(2026, 8, 26, 21, 0);
const ARCHIVED = { tv_archive: 1, tv_archive_duration: 3 };

describe('archiveDays', () => {
  it('reads the days a channel keeps', () => {
    expect(archiveDays(ARCHIVED)).toBe(3);
  });

  it('is nothing for a channel without catch-up, or one that says so oddly', () => {
    expect(archiveDays({ tv_archive: 0, tv_archive_duration: 3 })).toBe(0);
    expect(archiveDays({ tv_archive: 1, tv_archive_duration: 0 })).toBe(0);
    expect(archiveDays({})).toBe(0);
    expect(archiveDays(null)).toBe(0);
  });

  it('takes the provider sending them as text', () => {
    expect(archiveDays({ tv_archive: '1', tv_archive_duration: '2' } as never)).toBe(2);
  });
});

describe('catchUpKind', () => {
  it('replays a programme that has finished', () => {
    expect(catchUpKind(ARCHIVED, { start: NOW - 2 * HOUR, stop: NOW - HOUR }, NOW)).toBe('replay');
  });

  it('starts over the programme on air', () => {
    expect(catchUpKind(ARCHIVED, { start: NOW - HOUR / 2, stop: NOW + HOUR / 2 }, NOW)).toBe('startOver');
  });

  it('offers nothing for what has not started, or has only just', () => {
    expect(catchUpKind(ARCHIVED, { start: NOW + HOUR, stop: NOW + 2 * HOUR }, NOW)).toBeNull();
    expect(catchUpKind(ARCHIVED, { start: NOW - 2 * 60_000, stop: NOW + HOUR }, NOW)).toBeNull();
    expect(catchUpKind(ARCHIVED, { start: NOW - 3 * 60_000, stop: NOW + HOUR }, NOW)).toBe('startOver');
  });

  it('offers nothing older than the channel keeps, nor right at its edge', () => {
    expect(catchUpKind(ARCHIVED, { start: NOW - 4 * DAY, stop: NOW - 4 * DAY + HOUR }, NOW)).toBeNull();
    expect(catchUpKind(ARCHIVED, { start: NOW - 3 * DAY + 60_000, stop: NOW - 3 * DAY + HOUR }, NOW)).toBeNull();
    expect(catchUpKind(ARCHIVED, { start: NOW - 3 * DAY + HOUR, stop: NOW - 3 * DAY + 2 * HOUR }, NOW)).toBe('replay');
  });

  it('offers nothing on a channel without catch-up, or for a programme without times', () => {
    expect(catchUpKind({ tv_archive: 0 }, { start: NOW - 2 * HOUR, stop: NOW - HOUR }, NOW)).toBeNull();
    expect(catchUpKind(ARCHIVED, { start: Number.NaN, stop: NOW - HOUR }, NOW)).toBeNull();
    expect(catchUpKind(ARCHIVED, { start: NOW - HOUR, stop: NOW - 2 * HOUR }, NOW)).toBeNull();
  });
});

describe('catchUpStretch', () => {
  it('runs from the start to the end, with a few minutes over', () => {
    expect(catchUpStretch({ start: NOW - 3 * HOUR, stop: NOW - 2 * HOUR }, NOW)).toEqual({ startMs: NOW - 3 * HOUR, minutes: 65 });
  });

  it('starts on a whole minute, a little early rather than late', () => {
    const start = NOW - 3 * HOUR + 40_000;
    expect(catchUpStretch({ start, stop: NOW - 2 * HOUR }, NOW).startMs).toBe(NOW - 3 * HOUR);
  });

  it('continues from partway through', () => {
    expect(catchUpStretch({ start: NOW - 3 * HOUR, stop: NOW - 2 * HOUR }, NOW, NOW - 2.5 * HOUR)).toEqual({
      startMs: NOW - 2.5 * HOUR,
      minutes: 35
    });
  });

  it('stops short of the minute still being recorded', () => {
    // On air since half an hour ago: 28 whole minutes are safely recorded.
    expect(catchUpStretch({ start: NOW - HOUR / 2, stop: NOW + HOUR / 2 }, NOW)).toEqual({ startMs: NOW - HOUR / 2, minutes: 28 });
    // Finished a minute ago: its overrun would reach past the present too.
    expect(catchUpStretch({ start: NOW - HOUR, stop: NOW - 60_000 }, NOW).minutes).toBe(58);
  });
});

describe('the provider clock', () => {
  it('is read from what signing in returns', () => {
    // As a user's provider answered on 26 September.
    expect(
      providerClockFrom({ timezone: 'Europe/Amsterdam', time_now: '2026-09-26 23:07:55', timestamp_now: 1790456875 })
    ).toEqual({ timezone: 'Europe/Amsterdam', offsetMinutes: 120 });
  });

  it('keeps the offset when the timezone is not one this device knows', () => {
    expect(providerClockFrom({ timezone: 'Mars/Olympus', time_now: '2026-09-26 23:07:55', timestamp_now: 1790456875 })).toEqual({
      offsetMinutes: 120
    });
  });

  it('is nothing when the provider says nothing', () => {
    expect(providerClockFrom({})).toBeNull();
    expect(providerClockFrom(undefined)).toBeNull();
  });

  it('writes a moment as the address wants it, in the provider timezone', () => {
    expect(providerClockTime(Date.UTC(2026, 8, 26, 19, 9), { timezone: 'Europe/Amsterdam' })).toBe('2026-09-26:21-09');
    // Winter time: one hour ahead of UTC, not two.
    expect(providerClockTime(Date.UTC(2026, 11, 1, 19, 9), { timezone: 'Europe/Amsterdam' })).toBe('2026-12-01:20-09');
  });

  it('falls back to the offset, across midnight', () => {
    expect(providerClockTime(Date.UTC(2026, 8, 26, 23, 30), { offsetMinutes: 120 })).toBe('2026-09-27:01-30');
  });
});

describe('the catch-up address', () => {
  it('is spelled the way the provider serves it', () => {
    expect(
      buildCatchUpUrl('http://provider.example:8080/player_api.php', { username: 'joe', password: 'hunter2' }, '110721', '2026-09-26:21-09', 65)
    ).toBe('http://provider.example:8080/timeshift/joe/hunter2/65/2026-09-26:21-09/110721.m3u8');
  });

  it('can ask for the stream form instead', () => {
    expect(buildCatchUpUrl('http://provider.example', { username: 'joe', password: 'hunter2' }, '7', '2026-09-26:21-09', 30, 'ts')).toBe(
      'http://provider.example/timeshift/joe/hunter2/30/2026-09-26:21-09/7.ts'
    );
  });
});

describe('a live channel from the provider', () => {
  it('always says whether it has catch-up, as numbers', () => {
    const [kept, plain] = normaliseStreams(
      [
        { stream_id: 1, name: 'HRT 1 HD', tv_archive: '1', tv_archive_duration: '3' },
        { stream_id: 2, name: 'HRT 1' }
      ],
      'live'
    );
    expect([kept.tv_archive, kept.tv_archive_duration]).toEqual([1, 3]);
    expect([plain.tv_archive, plain.tv_archive_duration]).toEqual([0, 0]);
  });

  it('leaves films as they came', () => {
    const [film] = normaliseStreams([{ stream_id: 1, name: 'Dune' }], 'vod');
    expect(film.tv_archive).toBeUndefined();
  });
});
