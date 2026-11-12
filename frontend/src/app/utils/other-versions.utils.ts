import { withoutTags } from './channel-display.utils';

/**
 * Other versions of the same film in the library, for when one will not play.
 *
 * Providers list a film several times over -- "EN - X-Men [UHD] (2000)",
 * "EN - X-Men 4K (2000) X-Men 01", "FR - X-Men (2000)" -- and a device without
 * a decoder for 4K HEVC can usually play one of the others. So a film that
 * fails to decode is matched against the rest by its title and year, with the
 * language prefix and the quality marks taken off, and the ones that are not
 * themselves 4K are offered, the same language first.
 */

/** Anything that names a stream: the library's streams, and a playing item. */
export interface NamedStream {
  stream_id: number | string;
  name: string;
}

const LANGUAGE_PREFIX = /^\s*\|?\s*([A-Z]{2,3}(?:-[A-Z]{2})?)\s*\|?\s*[-|:]\s*/;
const QUALITY = /\b(?:4K|UHD|2160p?|1080[pi]?|720p?|576p?|480p?|FHD|FULL\s?HD|HD|SD|HDR10\+?|HDR|DV|DOLBY\s*VISION|HEVC|H\.?265|X265|REMUX|RAW|VIP)\b/gi;
const HIGH_RESOLUTION = /\b(?:4K|UHD|2160p?)\b/i;

/** The language a provider put in front of the name, if it did: "EN", "FR". */
export const languageOf = (name: string): string | null => LANGUAGE_PREFIX.exec(name)?.[1] ?? null;

/** Whether the name says this version is 4K. */
export const isHighResolution = (name: string): boolean => HIGH_RESOLUTION.test(withoutTags(name));

/**
 * The film a name refers to, whatever version it is: its title and year, in
 * lower case with the punctuation gone. "EN - X-Men [UHD] (2000)" and
 * "FR - X-Men (2000)" are both "xmen|2000".
 */
export const versionKey = (name: string): string => {
  const plain = withoutTags(name)
    .replace(LANGUAGE_PREFIX, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(QUALITY, ' ');
  // What follows the year is a series marker or a note ("X-Men 01"), not the title.
  const dated = /^(.*?)\(\s*(\d{4})\s*\)/.exec(plain);
  const title = (dated ? dated[1] : plain).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return dated ? `${title}|${dated[2]}` : title;
};

/** The words to search the library with, to find the other versions at all. */
export const searchWordsFor = (name: string): string =>
  withoutTags(name)
    .replace(LANGUAGE_PREFIX, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(QUALITY, ' ')
    .replace(/\(\s*\d{4}\s*\).*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The versions of `original` among `candidates` that are not 4K: the same language first. */
export const otherVersions = <T extends NamedStream>(original: NamedStream, candidates: T[]): T[] => {
  const key = versionKey(original.name);
  const language = languageOf(original.name);
  return candidates
    .filter(
      candidate =>
        String(candidate.stream_id) !== String(original.stream_id) &&
        !isHighResolution(candidate.name) &&
        versionKey(candidate.name) === key
    )
    .sort((a, b) => Number(languageOf(b.name) === language) - Number(languageOf(a.name) === language));
};

/**
 * Why a copy failed, as far as trying another copy is concerned.
 *
 * - `decode`: this device cannot play its format. A smaller copy may play.
 * - `copy`: this copy is missing or damaged. Another one may be fine.
 * - `account`: the provider refused the subscription, not the copy -- a
 *   wrong login, too many connections. Every copy would be refused alike,
 *   and trying several in a row is the kind of burst a provider notices.
 * - `network`: the provider could not be reached at all. Same for every copy.
 */
export type CopyFailure = 'decode' | 'copy' | 'account' | 'network';

// A recording holding the one connection is the same for every copy (recordings.service.ts).
const REFUSED_ACCOUNT = /\bHTTP (?:401|403|407|429|451|458|509)\b|RECORDING_HOLDS_CONNECTION/;
const UNREACHABLE = /NETWORK|TIMEOUT|UNREACHABLE|CONNECTION_FAILED|CONNECTION_CLOSED/i;

export const copyFailure = (errorCode: string): CopyFailure => {
  if (/decod|format_exceeds|format_unsupported|no decoder/i.test(errorCode)) {
    return 'decode';
  }
  if (REFUSED_ACCOUNT.test(errorCode)) {
    return 'account';
  }
  if (UNREACHABLE.test(errorCode) && !/BAD_HTTP_STATUS/i.test(errorCode)) {
    return 'network';
  }
  return 'copy';
};

/** At most this many copies are tried after the first, whatever the library holds. */
export const MOST_COPIES_TRIED = 3;

/**
 * How many other copies are worth trying after a failure like this one.
 *
 * Three when the failure plainly belongs to the copy: a status that is not a
 * refusal, a missing or damaged file, a format this device can't decode. One
 * when it doesn't say -- an APK older than the one that reports the status,
 * or mpv, which only says it exited -- because it may be the account, and
 * three refusals in a row is a burst a provider notices.
 */
export const copiesWorthTrying = (errorCode: string): number => {
  const failure = copyFailure(errorCode);
  if (failure === 'account' || failure === 'network') {
    return 0;
  }
  const plainlyTheCopy =
    failure === 'decode' || /\bHTTP \d{3}\b/.test(errorCode) || /FILE_NOT_FOUND|PARSING|MALFORMED|CONTAINER/i.test(errorCode);
  return plainlyTheCopy ? MOST_COPIES_TRIED : 1;
};

/** How big a copy's picture is, from its name: 4 for 4K, 3 Full HD, 2 HD, 1 SD. Full HD when the name doesn't say. */
export const qualityOf = (name: string): number => {
  const plain = withoutTags(name);
  if (HIGH_RESOLUTION.test(plain)) {
    return 4;
  }
  if (/\b(?:FHD|1080[pi]?|FULL\s?HD)\b/i.test(plain)) {
    return 3;
  }
  if (/\b(?:HD|720p?)\b/i.test(plain)) {
    return 2;
  }
  if (/\b(?:SD|480p?|576p?)\b/i.test(plain)) {
    return 1;
  }
  return 3;
};

/**
 * The copy to try after `failed` did not play, or null when there is none
 * worth trying.
 *
 * Never a bigger picture than the one that failed. A copy that would not open
 * is most likely a dead link, so one of the same size comes first, then
 * smaller ones; one this device could not decode wants a smaller picture
 * first, and never 4K, which no TV box decodes in software. Within those, the
 * language of the copy that failed first: it was chosen for the person.
 */
export const nextCopy = <T extends NamedStream>(
  failed: NamedStream,
  candidates: T[],
  tried: ReadonlySet<string>,
  failure: CopyFailure
): T | null => {
  if (failure === 'account' || failure === 'network') {
    return null;
  }
  const key = versionKey(failed.name);
  const size = qualityOf(failed.name);
  const language = languageOf(failed.name);
  const usable = candidates.filter(candidate => {
    const id = String(candidate.stream_id);
    const quality = qualityOf(candidate.name);
    return (
      id !== String(failed.stream_id) &&
      !tried.has(id) &&
      versionKey(candidate.name) === key &&
      quality <= size &&
      (failure !== 'decode' || quality < 4)
    );
  });
  // Lower is better: same size first after a dead link, smaller first after a decoder gave up.
  const group = (quality: number) => (failure === 'copy' ? (quality === size ? 0 : 1) : quality < size ? 0 : 1);
  return (
    [...usable].sort(
      (a, b) =>
        group(qualityOf(a.name)) - group(qualityOf(b.name)) ||
        Number(languageOf(b.name) === language) - Number(languageOf(a.name) === language) ||
        qualityOf(b.name) - qualityOf(a.name)
    )[0] ?? null
  );
};
