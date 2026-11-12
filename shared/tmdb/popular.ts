import { TmdbTitle } from './client';
import { fold } from './describe';

/**
 * "Popular now": what is trending on TMDB this week, as far as this library
 * has it.
 *
 * The other way round from finding a film's description: there a library
 * title looks for its one TMDB entry; here a TMDB entry looks for every
 * library title that is a copy of it -- the 4K one, the English one, the
 * Dutch one -- so the row shows the film once and the panel offers the copies.
 */

/** A provider's tag in front of a name: "|EN| ", "[4K] - ", "NL - ". */
const LEADING_TAG = /^\s*(?:\|[^|]{1,8}\||\[[^\]]{1,8}\]|[A-Za-z0-9+]{1,4}\s+[-|:])\s*(?:[-|:]\s+)?/;

/** Words about the copy, not the film: its picture, its source, its sound, its subtitles. */
const COPY_WORDS =
  /[([]?\b(?:4k|8k|uhd|fhd|hd|sd|hdr|hevc|x26[45]|1080p|720p|2160p|cam|hdcam|ts|webrip|web-dl|bluray|hdtv|multi[\s-]?subs?|dubbed|dub)\b[)\]]?/gi;

/** A library title with the provider's tags and the copy's words taken off. */
export function plainTitle(name: string): string {
  let title = name;
  for (let tags = 0; tags < 3 && LEADING_TAG.test(title); tags++) {
    title = title.replace(LEADING_TAG, '');
  }
  return title.replace(COPY_WORDS, ' ').trim();
}

/**
 * Whether a library title is a copy of this TMDB film or show: the same name
 * or original name once case, accents, punctuation, tags and copy words are
 * set aside, and the year within one when both are known -- a remake shares
 * its name with the original. A name that is only close is not a copy.
 */
export function isVersionOf(item: Pick<TmdbTitle, 'title' | 'originalTitle' | 'year'>, name: string, year: number | null): boolean {
  return isNamed(item, name) && datedAlike(item, year);
}

const isNamed = (item: Pick<TmdbTitle, 'title' | 'originalTitle'>, name: string): boolean => {
  const own = fold(plainTitle(name));
  return !!own && (own === fold(item.title) || own === fold(item.originalTitle));
};

const datedAlike = (item: Pick<TmdbTitle, 'year'>, year: number | null): boolean =>
  !year || !item.year || Math.abs(Number(item.year) - year) <= 1;

/**
 * The copies of this film or show among a search's results.
 *
 * A copy whose name gives no year is taken only where the name is not also
 * another year's: "Resident Evil" trending as the 2026 film, beside a library
 * holding Resident Evil (2002), leaves an undated "Resident Evil" as likely
 * the old one as the new -- and the row is for the new. Where every dated
 * copy agrees, as with a new title nobody made before, the undated ones are
 * the same film filed carelessly, and are kept.
 */
export function versionsOf<T>(
  item: Pick<TmdbTitle, 'title' | 'originalTitle' | 'year'>,
  candidates: readonly T[],
  read: (candidate: T) => { title: string; year: number | null }
): T[] {
  const named = candidates.filter(candidate => isNamed(item, read(candidate).title));
  const otherYear = named.some(candidate => {
    const { year } = read(candidate);
    return year !== null && !datedAlike(item, year);
  });
  return named.filter(candidate => {
    const { year } = read(candidate);
    return year === null ? !otherYear || !item.year : datedAlike(item, year);
  });
}

/**
 * Copies of the same film or show, grouped (search, round 6: "a title is one
 * thing, not twenty"): the same name once tags and copy words are set aside,
 * and the same year. A copy whose name gives no year joins the one dated
 * group of its name, when there is only one; otherwise it stays on its own.
 * Groups come in the order their first copy came.
 */
export function groupCopies<T>(items: readonly T[], read: (item: T) => { title: string; year: number | null }): T[][] {
  const groups: { name: string; year: number | null; items: T[] }[] = [];
  const undated: { name: string; item: T; at: number }[] = [];
  items.forEach((item, at) => {
    const { title, year } = read(item);
    const name = fold(plainTitle(title)) || fold(title);
    if (year === null) {
      undated.push({ name, item, at });
      return;
    }
    const group = groups.find(candidate => candidate.name === name && candidate.year === year);
    if (group) {
      group.items.push(item);
    } else {
      groups.push({ name, year, items: [item] });
    }
  });
  for (const { name, item } of undated) {
    const dated = groups.filter(group => group.name === name && group.year !== null);
    const target = dated.length === 1 ? dated[0] : groups.find(group => group.name === name && group.year === null);
    if (target) {
      target.items.push(item);
    } else {
      groups.push({ name, year: null, items: [item] });
    }
  }
  const firstAt = (group: { items: T[] }) => Math.min(...group.items.map(item => items.indexOf(item)));
  const inOrder = (group: T[]) => [...group].sort((a, b) => items.indexOf(a) - items.indexOf(b));
  return groups.sort((a, b) => firstAt(a) - firstAt(b)).map(group => inOrder(group.items));
}
