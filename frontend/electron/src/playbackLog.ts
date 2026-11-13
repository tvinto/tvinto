import { appendFileSync, renameSync, statSync } from 'fs';
import { join } from 'path';

/**
 * A record of every time playback starts, stops or is reopened, in
 * `playback.log` beside the app's own data (`%APPDATA%\Tvinto\playback.log`).
 *
 * Written because a live channel stopped about once a minute on the owner's
 * desktop (12 November) and nothing said why: mpv closed, the app took it for
 * the viewer closing it, and there was no log. Each line now says who ended
 * the stream -- mpv (with its reason and error), the provider, or the app --
 * so the next drop explains itself.
 *
 * No address, username or password ever reaches a line: a stream is named by
 * the last part of its path (`1234.m3u8`), which is the channel's number at
 * the provider and nothing more.
 */

/** Past this the log starts again, keeping the previous one as playback.old.log. */
const MAX_BYTES = 1024 * 1024;

/** The stream's file name without where it lives or who asked: "http …/1234.m3u8". */
export function redactUrl(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) {
    return '(none)';
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim())?.[1]?.toLowerCase();
  if (!scheme) {
    // A local file: a recording of the app's own.
    return 'a local file';
  }
  const path = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0] ?? '';
  const last = path.split('/').filter(Boolean).pop() ?? '';
  // A channel number and an extension; anything else could be a name or a token.
  return /^\d{1,12}(\.[A-Za-z0-9]{1,5})?$/.test(last)
    ? `${scheme} …/${last}`
    : `${scheme} …`;
}

/** Any address inside a message (mpv's errors can quote one), redacted the same way. */
export function redactText(text: unknown): string {
  return String(text ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi, match => redactUrl(match));
}

let file: string | null = null;

/** Where the log is written, once Electron can say. */
export function setPlaybackLogFolder(folder: string): void {
  file = join(folder, 'playback.log');
}

/** One line: on stdout as `[playback] …`, and in playback.log with the time. */
export function playbackLog(message: string): void {
  const line = redactText(message);
  console.info(`[playback] ${line}`);
  if (!file) {
    return;
  }
  try {
    try {
      if (statSync(file).size > MAX_BYTES) {
        renameSync(file, file.replace(/\.log$/, '.old.log'));
      }
    } catch {
      // Not there yet.
    }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A log that cannot be written must not stop a channel.
  }
}
