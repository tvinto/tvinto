import { TmdbClient, TmdbKind, TmdbTitle } from './client';

/**
 * Which description to show, and finding the film or show it belongs to.
 * Pure but for the client it is handed.
 */

/** TMDB's spelling of each language the app speaks. */
const TMDB_LANGUAGES = {
  en: 'en-US',
  hr: 'hr-HR',
  bs: 'bs-BS',
  sr: 'sr-RS',
  sl: 'sl-SI',
  mk: 'mk-MK',
  sq: 'sq-AL',
  de: 'de-DE',
  es: 'es-ES',
  fr: 'fr-FR',
  it: 'it-IT',
  nl: 'nl-NL',
  pl: 'pl-PL',
  pt: 'pt-BR',
  ru: 'ru-RU',
  tr: 'tr-TR'
} as const;

/** What a person can choose: the provider's own words, or TMDB's in a language the app speaks. */
export type DescriptionLanguage = 'provider' | keyof typeof TMDB_LANGUAGES;

export const DESCRIPTION_LANGUAGES: readonly DescriptionLanguage[] = ['provider', ...(Object.keys(TMDB_LANGUAGES) as (keyof typeof TMDB_LANGUAGES)[])];

export const readDescriptionLanguage = (raw: string | null | undefined): DescriptionLanguage =>
  (DESCRIPTION_LANGUAGES as readonly string[]).includes(raw ?? '') ? (raw as DescriptionLanguage) : 'provider';

/** TMDB's spelling of a language. */
export const tmdbLanguage = (language: Exclude<DescriptionLanguage, 'provider'>): string => TMDB_LANGUAGES[language] ?? 'en-US';

/** Where a shown description came from, for the small mark beside it. */
export type DescriptionSource = 'provider' | 'tmdb';

export interface ChosenDescription {
  text: string;
  source: DescriptionSource;
}

/**
 * The description to show: TMDB's in the chosen language, then TMDB's in
 * English, then the provider's. With the provider's chosen, the provider's --
 * unless it is empty, when TMDB's is better than nothing.
 */
export function chooseDescription(
  language: DescriptionLanguage,
  found: { chosen?: string; english?: string; provider?: string }
): ChosenDescription | null {
  const provider = found.provider?.trim() ?? '';
  const tmdb = found.chosen?.trim() || found.english?.trim() || '';
  if (language === 'provider') {
    return provider ? { text: provider, source: 'provider' } : tmdb ? { text: tmdb, source: 'tmdb' } : null;
  }
  return tmdb ? { text: tmdb, source: 'tmdb' } : provider ? { text: provider, source: 'provider' } : null;
}

export const fold = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The one search result that is the film or show, or null.
 *
 * Only a clear match: the title (or original title) the same once case,
 * accents and punctuation are set aside, and the year within one when both
 * are known -- a remake shares its name with the original. Two that fit is no
 * match at all; a wrong description is worse than the provider's.
 */
export function pickMatch(results: readonly TmdbTitle[], names: readonly string[], year: number | null): TmdbTitle | null {
  const wanted = new Set(names.map(fold).filter(Boolean));
  const fits = results.filter(result => {
    const named = wanted.has(fold(result.title)) || wanted.has(fold(result.originalTitle));
    const dated = !year || !result.year || Math.abs(Number(result.year) - year) <= 1;
    return named && dated;
  });
  return fits.length === 1 ? fits[0] : null;
}

/** What is known about a film or show from the provider. */
export interface KnownTitle {
  kind: TmdbKind;
  tmdbId: number | null;
  imdbId: number | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
}

/** The TMDB id of a film or show: the provider's, through IMDb, or by a clear search match. */
export async function findTmdbId(client: TmdbClient, known: KnownTitle): Promise<number | null> {
  if (known.tmdbId) {
    return known.tmdbId;
  }
  if (known.imdbId) {
    const id = await client.fromImdb(known.kind, known.imdbId);
    if (id) {
      return id;
    }
  }
  const names = [known.title, known.originalTitle ?? ''].filter(Boolean);
  for (const query of names) {
    const found = pickMatch(await client.search(known.kind, query, known.year, 'en-US'), names, known.year);
    if (found) {
      return found.id;
    }
  }
  return null;
}
