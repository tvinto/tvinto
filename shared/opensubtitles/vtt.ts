/**
 * Subtitle text as the players want it: WebVTT, UTF-8, no BOM.
 *
 * OpenSubtitles is asked for WebVTT (`sub_format`), and mostly sends it -- but
 * their files were converted from whatever was uploaded, and an SRT comes back
 * often enough that a client which trusted the request would show a file of
 * "00:00:01,000" lines that no player parses. Converting is a dozen lines and
 * removes the whole question.
 *
 * The two differ in less than they look: a comma before the milliseconds, the
 * cue numbers SRT puts on their own line, and the header WebVTT wants. Cue text
 * is left exactly as it is, including its markup, which both formats allow.
 */

/** `00:01:02,500` or `1:02,5` -- SRT is written loosely in the wild. */
const SRT_TIME = /(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/g;

/** A cue number: a line of digits on its own, just before a timing line. */
const CUE_NUMBER = /^\d+$/;

const ARROW = /-->/;

const stripBom = (text: string): string => text.replace(/^﻿/, '');

/**
 * SubStation tags, which WebVTT has no idea what to do with.
 *
 * Their files are converted from whatever was uploaded, and a subtitle first
 * made as .ass keeps things like `{\an8}` (put this line at the top) in the
 * text -- which Media3 then draws literally: the first added subtitle played on
 * a television read "{\an8}i vjetar brzine do 50 km/h". Dropped rather than
 * honoured: a position from another format is not worth carrying, and the
 * account's own subtitle settings decide how lines look.
 */
const STYLE_TAGS = /\{\\[^}]*\}/g;

/** Cue text without the tags no player here reads. */
export const withoutStyleTags = (value: string): string => value.replace(STYLE_TAGS, '');

const normalise = (text: string): string => stripBom(text).replace(/\r\n?/g, '\n');

/** WebVTT wants two digits of hours and a dot; SRT may have one digit and a comma. */
const asVttTime = (hours: string, minutes: string, seconds: string, millis: string): string =>
  `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}.${millis.padEnd(3, '0').slice(0, 3)}`;

/**
 * The same subtitles as WebVTT, or null when the text is not subtitles at all.
 *
 * Null rather than a guess for an HTML error page or an empty file: saving one
 * of those to the account would be a subtitle that shows nothing, and the
 * person would have spent a download on it.
 */
export const toWebVtt = (text: string): string | null => {
  const lines = normalise(text).trim();
  if (!lines) {
    return null;
  }

  const cleaned = withoutStyleTags(lines);
  if (/^WEBVTT(?:[ \t]|\n|$)/.test(cleaned)) {
    // Already theirs. Timings still normalised: files converted from SRT have
    // been seen to keep the comma even under a WEBVTT header.
    return `${cleaned.replace(SRT_TIME, (_, h, m, s, ms) => asVttTime(h, m, s, ms))}\n`;
  }

  const source = cleaned.split('\n');
  const out: string[] = ['WEBVTT', ''];
  let cues = 0;

  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];

    if (ARROW.test(line)) {
      cues += 1;
      // The number before a timing line belongs to SRT and means nothing here.
      if (out.length && CUE_NUMBER.test(out[out.length - 1].trim())) {
        out.pop();
      }
      out.push(line.replace(SRT_TIME, (_, h, m, s, ms) => asVttTime(h, m, s, ms)).trim());
      continue;
    }

    out.push(line);
  }

  return cues > 0 ? `${out.join('\n').trim()}\n` : null;
};

/** A WebVTT time: `00:01:02.500`, or `01:02.500` as the short form allows. */
const VTT_TIME = /(?:(\d{2,3}):)?(\d{2}):(\d{2})\.(\d{3})/g;

const asMillis = (hours: string | undefined, minutes: string, seconds: string, millis: string): number =>
  (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(millis);

const asVtt = (millis: number): string => {
  const clamped = Math.max(0, Math.round(millis));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const rest = clamped % 1000;
  const clock = [hours, minutes, seconds].map(part => String(part).padStart(2, '0')).join(':');
  return `${clock}.${String(rest).padStart(3, '0')}`;
};

/**
 * The same subtitles, moved earlier or later.
 *
 * A subtitle made for another copy of a film is often a second or two out, and
 * this is how the offset is honoured: the cue times are rewritten. mpv and VLC
 * can shift subtitles as they play, and Media3 cannot -- doing it here means one
 * answer for all three, and the same file whichever player opens it.
 *
 * Only the timing lines are touched. Times inside cue text (a subtitle that
 * quotes a clock) are left alone, because the line has to contain `-->` to be
 * read as timing at all. Nothing is moved before zero: a cue dragged to a
 * negative start would be dropped by players rather than shown at the start.
 */
export const shiftWebVtt = (text: string, offsetMs: number): string => {
  if (!Number.isFinite(offsetMs) || Math.round(offsetMs) === 0) {
    return text;
  }

  return text
    .split('\n')
    .map(line =>
      line.includes('-->')
        ? line.replace(VTT_TIME, (_, hours, minutes, seconds, millis) =>
            asVtt(asMillis(hours, minutes, seconds, millis) + offsetMs)
          )
        : line
    )
    .join('\n');
};
