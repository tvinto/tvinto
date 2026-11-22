/**
 * One playback log line for each request mpv makes to the provider.
 *
 * Opening a stream is the app's own doing and has its line already ("app:
 * opens ...", a channel switch, a reopen, Back to live). Every request after
 * that mpv makes by itself, so the app hears of them only through mpv's own
 * log, which it asks for over the pipe (`request_log_messages`) -- too late to
 * see the opening anyway. Two lines there, checked one for one against the
 * fake provider's request log on 22 November:
 *
 * - `[curl] stream level seek from A to B`: a new range request from byte B.
 *   A seek past what is cached, the Matroska cues at the end of a file, and
 *   the read back after a track chosen mid-film.
 * - `[mkv] refresh seek to T`: why the next one comes. mpv keeps packets of
 *   the selected tracks only, so a subtitle or audio track chosen mid-film is
 *   read again from just before where the film is.
 *
 * mpv closed each connection before it opened the next in every measurement,
 * so these lines are one after another, never two open at once. Local files
 * (a subtitle on disk, prefix `file`) are not the provider and say nothing.
 * The address is never in a line: mpv's own message carries it, ours does not.
 */
export interface MpvLogMessage {
  prefix?: unknown;
  level?: unknown;
  text?: unknown;
}

/** Not a request: a probe that hands the address on, and files on this machine. */
const NOT_THE_PROVIDER = new Set(['stream_callback', 'file']);

/** The line one of mpv's log messages makes in the playback log, or null. */
export function streamRequestLine(message: MpvLogMessage): string | null {
  const prefix = typeof message.prefix === 'string' ? message.prefix : '';
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text || NOT_THE_PROVIDER.has(prefix)) {
    return null;
  }

  const seek = /^stream level seek from (\d+) to (\d+)$/.exec(text);
  if (seek) {
    return `mpv: a new request to the provider, from byte ${seek[2]} (it was at byte ${seek[1]})`;
  }

  const refresh = /^refresh seek to (-?\d+(?:\.\d+)?)$/.exec(text);
  if (refresh) {
    const seconds = Math.max(0, Number(refresh[1]));
    return `mpv: reads again from ${seconds.toFixed(1)} s for a track chosen while playing (refresh seek)`;
  }

  return null;
}
