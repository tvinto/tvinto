import { Stream } from '../types';

/**
 * Catch-up: playing a programme that has already been on.
 *
 * Xtream keeps a few days of some channels (`tv_archive` in the channel list,
 * with the number of days in `tv_archive_duration`) and serves any stretch of
 * them from an address naming where it starts and how many minutes it runs.
 * The start is written in the *provider's* clock, not the viewer's -- which is
 * the whole difficulty, and why the provider's timezone is carried about.
 *
 * Found against a user's provider (26 September): the channels that have it
 * are the main HD copy of each (HRT 1-4 HD, Nova, RTL, BBC, ITV, Arena Sport),
 * two or three days back, while the plain and HEVC copies of the same channel
 * have none. Asked for as .m3u8 it answers with a finished HLS playlist of
 * one-minute segments, which every player here can seek in; asked for as .ts
 * it sends one long stream whose byte ranges are a pretence -- a request from
 * 5 MB in returned the first bytes again -- so a seek there would show the
 * wrong minute. And a stretch reaching past the present is cut off at the
 * present: the playlist ends where the programme has got to -- with the minute
 * still being recorded as its last segment, which the provider refuses when a
 * player reaches it (ERROR_CODE_IO_BAD_HTTP_STATUS, on the TV emulator). So
 * nothing is ever asked for closer to the present than LIVE_EDGE_MS.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days back this channel can be played from; 0 when it cannot. */
export function archiveDays(stream: Pick<Stream, 'tv_archive' | 'tv_archive_duration'> | null | undefined): number {
  if (!stream || Number(stream.tv_archive) !== 1) {
    return 0;
  }
  const days = Number(stream.tv_archive_duration);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
}

/**
 * What can be done with a programme on a channel: play it again (it has
 * finished), start it over (it is on now), or nothing.
 *
 * Only inside the channel's archive, and a little inside it: the oldest few
 * minutes are the ones a provider has usually already thrown away by the time
 * a player asks for them.
 */
export type CatchUpKind = 'replay' | 'startOver';

const ARCHIVE_EDGE_MS = 10 * 60 * 1000;

/** How close to the present a stretch may reach: the minute being recorded, and one more for the provider to catch up. */
export const LIVE_EDGE_MS = 2 * 60 * 1000;

export function catchUpKind(
  stream: Pick<Stream, 'tv_archive' | 'tv_archive_duration'> | null | undefined,
  programme: { start: number; stop: number },
  now: number
): CatchUpKind | null {
  const days = archiveDays(stream);
  const { start, stop } = programme;
  if (!days || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) {
    return null;
  }
  // Starting over needs a whole minute already recorded to start with.
  if (start < now - days * DAY_MS + ARCHIVE_EDGE_MS || start > now - LIVE_EDGE_MS - 60_000) {
    return null;
  }
  return stop <= now ? 'replay' : 'startOver';
}

/** Minutes past the programme's end asked for too: programmes overrun, and the guide is not exact. */
export const CATCH_UP_OVERRUN_MINUTES = 5;

/**
 * The stretch to ask for: from the programme's start, to its end plus a
 * margin, and never closer to `now` than LIVE_EDGE_MS. `from` starts partway
 * in, for continuing a programme started over. Whole minutes, because that is
 * all the address can say.
 */
export function catchUpStretch(
  programme: { start: number; stop: number },
  now: number,
  from = programme.start
): { startMs: number; minutes: number } {
  const startMs = Math.floor(Math.max(programme.start, from) / 60_000) * 60_000;
  const wanted = Math.ceil((programme.stop - startMs) / 60_000) + CATCH_UP_OVERRUN_MINUTES;
  const recorded = Math.floor((now - LIVE_EDGE_MS - startMs) / 60_000);
  return { startMs, minutes: Math.max(1, Math.min(wanted, recorded)) };
}

/**
 * The provider's clock, as far as a catch-up address needs it.
 *
 * `timezone` is the provider's own name for it ("Europe/Amsterdam"), which
 * gets summer time right on any date. `offsetMinutes` is worked out from the
 * two clocks the provider reports side by side, for a provider whose timezone
 * is missing or is not one this device knows.
 */
export interface ProviderClock {
  timezone?: string;
  offsetMinutes?: number;
}

/**
 * The provider's clock, from the `server_info` that signing in returns.
 *
 * `time_now` is the provider's wall clock ("2026-09-26 23:07:55") and
 * `timestamp_now` the same moment in Unix seconds, so their difference is the
 * provider's offset from UTC -- rounded to a quarter of an hour, since the two
 * are read a moment apart and no timezone is offset by less.
 */
export function providerClockFrom(serverInfo: Record<string, unknown> | null | undefined): ProviderClock | null {
  if (!serverInfo) {
    return null;
  }
  const clock: ProviderClock = {};

  const timezone = typeof serverInfo['timezone'] === 'string' ? serverInfo['timezone'].trim() : '';
  if (timezone && knownTimezone(timezone)) {
    clock.timezone = timezone;
  }

  const wall = typeof serverInfo['time_now'] === 'string' ? serverInfo['time_now'] : '';
  const unix = Number(serverInfo['timestamp_now']);
  const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(wall);
  if (parts && Number.isFinite(unix) && unix > 0) {
    const [, y, mo, d, h, mi, s] = parts;
    const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0));
    const offset = Math.round((asUtc - unix * 1000) / 60_000 / 15) * 15;
    if (Math.abs(offset) <= 14 * 60) {
      clock.offsetMinutes = offset;
    }
  }

  return clock.timezone || clock.offsetMinutes !== undefined ? clock : null;
}

function knownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A moment as the catch-up address writes it: "2026-09-26:21-09", in the
 * provider's clock. The device's own clock when the provider's is not known,
 * which is right for a provider in the viewer's timezone and wrong by the
 * difference otherwise -- a programme that starts early or late, rather than
 * none at all.
 */
export function providerClockTime(ms: number, clock: ProviderClock | null | undefined): string {
  if (clock?.timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: clock.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      })
        .formatToParts(new Date(ms))
        .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
      return `${parts['year']}-${parts['month']}-${parts['day']}:${parts['hour']}-${parts['minute']}`;
    } catch {
      // Fall through to the offset.
    }
  }

  const shifted =
    clock?.offsetMinutes !== undefined
      ? new Date(ms + clock.offsetMinutes * 60_000)
      : new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  const two = (value: number) => String(value).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${two(shifted.getUTCMonth() + 1)}-${two(shifted.getUTCDate())}` +
    `:${two(shifted.getUTCHours())}-${two(shifted.getUTCMinutes())}`
  );
}
