import { t } from './i18n';

/**
 * How a channel and its programmes are written on the guide.
 *
 * The TV boards (TV-1 to TV-3) never show a provider's raw name. `HR| ARENA
 * SPORT 1 ⱽᴵᴾ ᴿᴬᵂ` is drawn as "ARENA SPORT 1" with "101 · ᵛᴵᴾ ᴿᴬᵂ" beneath it
 * and a tile reading "AS1" beside it: the country tag says nothing inside a
 * Croatian category, and the packaging tags push the part that tells channels
 * apart off the end of the line. Pure functions so the rules can be tested
 * without a guide to draw.
 */

/** The superscript letters providers spell their packaging tags in. */
const SUPERSCRIPT = /[ʰ-˿ᴬ-ᶿ⁰-₟ⱼⱽ]+/g;

/** A provider's country tag at the start of a name: `HR|`, `US-`, `LAT:`. */
const COUNTRY_TAG = /^\s*[A-Za-z]{2,3}\s*[|:-]\s*/;

/** Words that are packaging, not part of what identifies the channel. */
const QUALITY = new Set(['HD', 'FHD', 'UHD', 'SD', '4K', 'HQ', 'RAW', 'VIP']);

export interface ChannelDisplay {
  /** The name without its country tag or superscript tags. */
  title: string;
  /** The superscript tags, space-separated, or an empty string. */
  tags: string;
}

export const channelDisplay = (name: string | null | undefined): ChannelDisplay => {
  const raw = (name ?? '').trim();
  const tags = (raw.match(SUPERSCRIPT) ?? []).join(' ');
  const title = raw.replace(COUNTRY_TAG, '').replace(SUPERSCRIPT, ' ').replace(/\s+/g, ' ').trim();

  // A name that was nothing but tags keeps what it had rather than going blank.
  return { title: title || raw, tags };
};

/**
 * A category's name without the superscript tags, keeping its country tag.
 *
 * Unlike a channel inside a category, a category sits in a list of 830 from
 * every country, and `HR|` is how one is told from another.
 */
export const withoutTags = (name: string | null | undefined): string => {
  const raw = (name ?? '').trim();
  return raw.replace(SUPERSCRIPT, ' ').replace(/\s+/g, ' ').trim() || raw;
};

/**
 * Up to three characters to stand in for a missing or broken logo.
 *
 * The initials of the words that name the channel and its number, as the
 * boards draw them: "Arena Sport 1" is AS1, "Eurosport" is EU. Quality words
 * are skipped, or every HD channel would end in H.
 */
export const channelMonogram = (title: string | null | undefined): string => {
  const words = (title ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word && !QUALITY.has(word.toUpperCase()));

  const lettered = words.filter(word => /^\p{L}/u.test(word));
  const number = words.find(word => /^\p{N}+$/u.test(word)) ?? '';

  if (!lettered.length) {
    return number.slice(0, 3) || firstSymbol(title) || '?';
  }

  // The number whole and the letters fitted round it: cutting the number
  // instead drew "Channel 10" to "Channel 19" all as CN1. A longer number is
  // not the channel's: a code or a resolution.
  const digits = number.length <= 3 ? number : '';
  const room = 3 - digits.length;
  const letters =
    lettered.length === 1
      ? lettered[0].slice(0, Math.min(room, digits ? 1 : 2))
      : lettered
          .slice(0, Math.min(room, 2))
          .map(word => word[0])
          .join('');

  return (letters + digits).toUpperCase();
};

/** "📺🔥" draws 📺 rather than a question mark; one emoji, however many code points. */
const firstSymbol = (title: string | null | undefined): string => {
  const text = (title ?? '').trim();
  if (!text) {
    return '';
  }
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return segmenter ? (segmenter.segment(text)[Symbol.iterator]().next().value?.segment ?? '') : [...text][0];
};

/**
 * "20:45", always 24-hour.
 *
 * Not the device locale's choice: the emulator's English locale drew the guide
 * in "06:30 PM", which wraps onto two lines in a time slot, and the people this
 * guide is for read a 24-hour clock.
 */
export const clockTime = (ms: number): string => {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};


/** "TUE 8 SEP", the time header's date. */
export const guideDateLabel = (ms: number): string => {
  const date = new Date(ms);
  return t('time.guideDate', {
    day: t('time.days').split(',')[date.getDay()],
    date: String(date.getDate()),
    month: t('time.months').split(',')[date.getMonth()]
  });
};

/** "68 min left", or null once it has finished or when there is no end. */
export const minutesLeft = (stopMs: number, now: number): string | null => {
  if (!Number.isFinite(stopMs) || stopMs <= now) {
    return null;
  }
  return t('time.minLeft', { count: Math.max(1, Math.round((stopMs - now) / 60_000)) });
};

/** How far through a programme is, 0 to 100. */
export const percentThrough = (startMs: number, stopMs: number, now: number): number => {
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs) || stopMs <= startMs) {
    return 0;
  }
  return Math.max(0, Math.min(100, ((now - startMs) / (stopMs - startMs)) * 100));
};
