import { groupCopies } from '@shared/tmdb/popular';
import { orderCopies } from '@shared/tmdb/copies';
import { posterTitle } from './series-display.utils';
import { preferredLanguages } from './languages';

/**
 * A film or show once, not once per copy (round 6: "a title is one thing,
 * not twenty"): copies of one title -- 4K and HD, one per language -- grouped
 * as the film page's Copies section groups them, each group shown by the copy
 * Play would choose, in the place of the group's first. Recently added showed
 * The Odyssey twice in a row (14 November).
 */
export function oneCardPerTitle<T>(items: readonly T[], nameOf: (item: T) => string): T[] {
  const languages = preferredLanguages();
  return groupCopies(items, item => {
    const own = posterTitle(nameOf(item));
    return { title: own.title, year: own.year ? Number(own.year) : null };
  }).map(group => orderCopies(group, languages, item => ({ name: nameOf(item) }))[0]);
}

/** The first of each title, as given: for rows whose order is their point, such as Continue watching. */
export function firstPerTitle<T>(items: readonly T[], nameOf: (item: T) => string): T[] {
  return groupCopies(items, item => {
    const own = posterTitle(nameOf(item));
    return { title: own.title, year: own.year ? Number(own.year) : null };
  }).map(group => group[0]);
}
