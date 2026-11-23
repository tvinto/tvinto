/**
 * The failures that throw nothing -- a stream that will not play, a guide
 * that will not load, a sync, TMDB or OpenSubtitles refusing -- as error
 * reports (docs/error-reports.md). Each is one event with a short code and
 * context that holds no personal value: kinds and numbers, never a name or an
 * address.
 *
 * Grouped, so a provider having a bad evening sends one event per kind every
 * few minutes, with a count, rather than one per channel tried.
 */

export type FailureKind = 'stream' | 'guide' | 'sync' | 'tmdb' | 'opensubtitles';

/** Numbers, short words and yes/no only. */
export type FailureContext = Record<string, string | number | boolean | null>;

export interface Failure {
  kind: FailureKind;
  /** ERROR_CODE_IO_BAD_HTTP_STATUS, parse, 503... */
  code: string;
  context: FailureContext;
}

/** What is sent: the failure, and how many of its kind there were since the last one sent. */
export interface GroupedFailure extends Failure {
  count: number;
}

/** One event per kind per this long. */
export const FAILURE_WINDOW_MS = 5 * 60 * 1000;

/**
 * The grouping, with the clock handed in. The first failure of a kind goes at
 * once; the rest inside the window are counted, and the window's end sends
 * the last of them with the count (`due`).
 */
export class FailureGroups {
  private readonly windows = new Map<FailureKind, { opened: number; held: GroupedFailure | null }>();

  constructor(private readonly windowMs = FAILURE_WINDOW_MS) {}

  /** The event to send now, or null when it is counted towards the next one. */
  note(failure: Failure, now: number): GroupedFailure | null {
    const open = this.windows.get(failure.kind);
    if (open && now - open.opened < this.windowMs) {
      open.held = { ...failure, count: (open.held?.count ?? 0) + 1 };
      return null;
    }
    // The previous window's last failures, if any, go with this one's count.
    const count = 1 + (open?.held?.count ?? 0);
    this.windows.set(failure.kind, { opened: now, held: null });
    return { ...failure, count };
  }

  /** The counted failures whose window has closed, to send now; each window then starts again. */
  due(now: number): GroupedFailure[] {
    const out: GroupedFailure[] = [];
    for (const [kind, open] of this.windows) {
      if (now - open.opened >= this.windowMs) {
        if (open.held) {
          out.push(open.held);
        }
        this.windows.delete(kind);
      }
    }
    return out;
  }
}

/** Live, film or episode, from what the app knows of the item or the Xtream address's shape. */
export function streamKind(itemType: string | null | undefined, url = ''): 'live' | 'film' | 'episode' | 'recording' | 'unknown' {
  if (itemType === 'live') {
    return 'live';
  }
  if (itemType === 'movie' || itemType === 'vod') {
    return 'film';
  }
  if (itemType === 'series') {
    return 'episode';
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^https?:\/\/127\.0\.0\.1:/i.test(url)) {
    return url ? 'recording' : 'unknown';
  }
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return /^\/live\//i.test(path) ? 'live' : /^\/movie\//i.test(path) ? 'film' : /^\/series\//i.test(path) ? 'episode' : 'unknown';
}

/** The address's extension -- ts, m3u8, mkv -- and nothing else of it. */
export function streamContainer(url: string): string {
  const last = url.split(/[?#]/)[0]?.split('/').pop() ?? '';
  return /\.([A-Za-z0-9]{1,5})$/.exec(last)?.[1]?.toLowerCase() ?? 'none';
}

/**
 * A stream failure's code without anything personal in it: the player's
 * names (ERROR_CODE_DECODING_FAILED, "mpv exited with code 2") and numbers,
 * up to a short length. Anything else -- a sentence that might name a file --
 * is cut to its first word.
 */
export function failureCode(code: string): string {
  const trimmed = code.trim();
  if (/^[A-Za-z0-9_ .:-]{1,60}$/.test(trimmed) && !/[\\/@]/.test(trimmed)) {
    return trimmed;
  }
  return /^[A-Za-z0-9_-]{1,40}/.exec(trimmed)?.[0] ?? 'unknown';
}

/**
 * What a player's failure says, in parts: Media3 writes
 * "no decoder on this device managed hevc 3840x2160 (ERROR_CODE_DECODING_FAILED)"
 * and "ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 404)"; mpv's are "mpv exited with code 2".
 */
export function streamFailure(errorCode: string): { code: string; codec: string | null; http: number | null } {
  const named = /\bERROR_CODE_[A-Z0-9_]+/.exec(errorCode)?.[0];
  const codec = /\b(hevc|avc|h264|h265|hev1|hvc1|mpeg2video|mpeg4|vp8|vp9|av01|av1|dvhe|dolby-vision|ac3|eac3|e-ac3|dts|aac|mp4a-latm|opus|truehd|mp3)\b/i.exec(errorCode)?.[1]?.toLowerCase() ?? null;
  const http = Number(/\bHTTP (\d{3})\b/.exec(errorCode)?.[1]) || null;
  return { code: named ?? failureCode(errorCode), codec, http };
}
