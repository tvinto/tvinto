import { M3uStreamFields } from './m3uPlaylist';

/**
 * The address of a past programme on a playlist channel.
 *
 * An Xtream provider has one way (`buildCatchUpUrl`); a playlist says which of
 * several its server speaks, in the `catchup` attribute. The modes and the
 * placeholders are the ones Kodi's IPTV Simple client defined, which
 * playlists follow; written from its description, not checked against
 * IPTVnator's `catchup.utils.ts` -- worth doing when a
 * playlist with catch-up is at hand to test against:
 *
 * - `default`: `catchup-source` is the whole address, with placeholders.
 * - `append`: `catchup-source` is added to the end of the channel's address.
 * - `shift` (and `timeshift`): `utc=<start>&lutc=<now>` added to the address.
 * - `flussonic` (`fs`): the last part of the path becomes
 *   `timeshift_abs-<start>.ts`, or `index-<start>-<duration>.m3u8` for HLS.
 * - `xc`: the live address rewritten to Xtream's `/timeshift/` form.
 *
 * Placeholders: `{utc}`/`{start}`/`${start}` (start, Unix seconds),
 * `{utcend}`/`{end}`/`${end}`, `{lutc}`/`{now}`/`${now}`, `{duration}`
 * (seconds; `{duration:60}` divides, giving minutes), `{offset}` (seconds ago),
 * and `{Y}` `{m}` `{d}` `{H}` `{M}` `{S}` for the start's date and time in UTC.
 *
 * Null when the stream has no catch-up or a mode this does not know.
 */
export function m3uCatchUpUrl(
  stream: M3uStreamFields,
  startMs: number,
  minutes: number,
  nowMs = Date.now()
): string | null {
  const mode = (stream.catchup_mode ?? '').toLowerCase();
  const url = stream.source_url;
  const start = Math.floor(startMs / 1000);
  const duration = Math.max(1, Math.round(minutes * 60));
  const now = Math.floor(nowMs / 1000);

  const fill = (template: string) => fillPlaceholders(template, { start, duration, now });

  switch (mode) {
    case 'default':
      return stream.catchup_source ? fill(stream.catchup_source) : null;
    case 'append':
      return stream.catchup_source ? url + fill(stream.catchup_source) : null;
    case 'shift':
    case 'timeshift':
      return `${url}${url.includes('?') ? '&' : '?'}utc=${start}&lutc=${now}`;
    case 'flussonic':
    case 'flussonic-hls':
    case 'flussonic-ts':
    case 'fs':
      return flussonic(url, start, duration, mode);
    case 'xc':
      return xtreamStyle(url, start, minutes);
    default:
      return null;
  }
}

function fillPlaceholders(
  template: string,
  { start, duration, now }: { start: number; duration: number; now: number }
): string {
  const at = new Date(start * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  const values: Record<string, string> = {
    utc: String(start),
    start: String(start),
    utcend: String(start + duration),
    end: String(start + duration),
    lutc: String(now),
    now: String(now),
    timestamp: String(now),
    offset: String(Math.max(0, now - start)),
    Y: String(at.getUTCFullYear()),
    m: two(at.getUTCMonth() + 1),
    d: two(at.getUTCDate()),
    H: two(at.getUTCHours()),
    M: two(at.getUTCMinutes()),
    S: two(at.getUTCSeconds())
  };

  return template.replace(/\$?\{(\w+)(?::(\d+))?\}/g, (whole, name: string, divisor?: string) => {
    if (name === 'duration') {
      return String(Math.round(duration / (divisor ? Number(divisor) || 1 : 1)));
    }
    return values[name] ?? whole;
  });
}

/** `.../channel/mpegts` or `.../channel/index.m3u8` to the archive's form. */
function flussonic(url: string, start: number, duration: number, mode: string): string {
  const [path, query] = url.split('?');
  const cut = path.lastIndexOf('/');
  const base = path.slice(0, cut);
  const last = path.slice(cut + 1);
  const hls = mode === 'flussonic-hls' || (mode !== 'flussonic-ts' && /\.m3u8$/i.test(last));
  const archive = hls
    ? `${last.startsWith('index') ? 'index' : last.replace(/\.m3u8$/i, '') || 'index'}-${start}-${duration}.m3u8`
    : `timeshift_abs-${start}.ts`;
  return `${base}/${archive}${query ? `?${query}` : ''}`;
}

/** `/live/user/pass/1.ts` (or `/user/pass/1`) to `/timeshift/user/pass/<min>/<Y-m-d:H-M>/1.ts`. */
function xtreamStyle(url: string, start: number, minutes: number): string | null {
  const match = url.match(/^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(\.\w+)?$/);
  if (!match) {
    return null;
  }
  const [, host, user, pass, id, extension] = match;
  const at = new Date(start * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  const when = `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}:${two(at.getUTCHours())}-${two(at.getUTCMinutes())}`;
  return `${host}/timeshift/${user}/${pass}/${Math.round(minutes)}/${when}/${id}${extension ?? '.ts'}`;
}
