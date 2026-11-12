import { SubtitleQuery } from './client';

/**
 * Which film or episode a subtitle is for, in the terms OpenSubtitles searches by.
 *
 * Streams have no file to hash, so VLC's exact match is unavailable; what is
 * left is an id or a name. The provider usually knows the TMDB id -- stage 0
 * found `info.tmdb` in `get_series_info` for both shows checked -- and an id
 * finds the right film whatever language the provider named it in. Without one,
 * the cleaned-up title and year are searched, and the screen says so (ST-TV-2,
 * "Matched by title"), because a wrong match will run out of step.
 *
 * Pure: the caller fetches provider details, cleans the display name, and
 * decides where to remember the answer.
 */

export type MatchedBy = 'tmdb' | 'imdb' | 'title';

export interface FilmIdentity {
  kind: 'film';
  matchedBy: MatchedBy;
  tmdbId: number | null;
  imdbId: number | null;
  /** The title to search for, or to show as "Searching for". */
  title: string;
  /** An original-language title the provider gave, when it differs. */
  originalTitle: string | null;
  year: number | null;
}

export interface EpisodeIdentity {
  kind: 'episode';
  matchedBy: MatchedBy;
  /** The show's ids; OpenSubtitles finds the episode by show, season and episode. */
  parentTmdbId: number | null;
  parentImdbId: number | null;
  season: number;
  episode: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
}

export type SubtitleIdentity = FilmIdentity | EpisodeIdentity;

type Loose = Record<string, unknown>;

const object = (value: unknown): Loose =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {};

/**
 * A positive whole id out of whatever the provider wrote: 24188, "24188",
 * "tt0133093" for IMDb. Zero, empty, "null" and "N/A" are no id at all -- panels
 * write all of them for "unknown".
 */
export const idFrom = (value: unknown): number | null => {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const digits = /^(?:tt)?0*(\d{1,10})$/i.exec(raw)?.[1];
  const id = digits ? Number(digits) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const yearFrom = (...values: unknown[]): number | null => {
  for (const value of values) {
    const found = /\b(19\d{2}|20\d{2})\b/.exec(typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '');
    if (found) {
      return Number(found[1]);
    }
  }
  return null;
};

const firstId = (fields: Loose, names: string[]): number | null => {
  for (const name of names) {
    const id = idFrom(fields[name]);
    if (id) {
      return id;
    }
  }
  return null;
};

const TMDB_FIELDS = ['tmdb_id', 'tmdb'];
const IMDB_FIELDS = ['imdb_id', 'imdb'];

/** An original title worth offering: present, and not the same words as the title. */
const different = (original: unknown, title: string): string | null => {
  // This provider writes the year into `o_name` too: "Outta Time (2002)".
  const text = typeof original === 'string' ? original.replace(/\s*[([]\s*(?:19|20)\d{2}\s*[)\]]\s*$/, '').trim() : '';
  const fold = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return text && fold(text) !== fold(title) ? text : null;
};

const matchedBy = (tmdb: number | null, imdb: number | null): MatchedBy => (tmdb ? 'tmdb' : imdb ? 'imdb' : 'title');

/**
 * A film, from `get_vod_info` (`{ info, movie_data }`) and the name the app
 * shows, already cleaned of tags and year (`posterTitle`).
 */
export const filmIdentity = (
  vodInfo: unknown,
  display: { title: string; year?: string | number | null }
): FilmIdentity => {
  const body = object(vodInfo);
  const info = object(body['info']);
  const movie = object(body['movie_data']);

  const tmdbId = firstId(info, TMDB_FIELDS) ?? firstId(movie, TMDB_FIELDS);
  const imdbId = firstId(info, IMDB_FIELDS) ?? firstId(movie, IMDB_FIELDS);
  const title = display.title.trim();

  return {
    kind: 'film',
    matchedBy: matchedBy(tmdbId, imdbId),
    tmdbId,
    imdbId,
    title,
    originalTitle: different(info['o_name'] ?? info['original_name'], title),
    year: yearFrom(display.year, info['releasedate'], info['release_date'], info['releaseDate'], info['year'])
  };
};

/**
 * An episode, from the show's `get_series_info` (`{ info, episodes }`), the
 * season and episode numbers, and the show's cleaned name.
 */
export const episodeIdentity = (
  seriesInfo: unknown,
  episode: { season: number; episode: number },
  display: { title: string; year?: string | number | null }
): EpisodeIdentity => {
  const body = object(seriesInfo);
  // The Express backend flattens the facts; the provider nests them under `info`.
  const info = body['info'] ? object(body['info']) : body;

  const parentTmdbId = firstId(info, TMDB_FIELDS);
  const parentImdbId = firstId(info, IMDB_FIELDS);
  const title = display.title.trim();

  return {
    kind: 'episode',
    matchedBy: matchedBy(parentTmdbId, parentImdbId),
    parentTmdbId,
    parentImdbId,
    season: episode.season,
    episode: episode.episode,
    title,
    originalTitle: different(info['o_name'] ?? info['original_name'], title),
    year: yearFrom(display.year, info['releaseDate'], info['release_date'], info['year'])
  };
};

/**
 * What to ask OpenSubtitles for.
 *
 * An id alone when there is one: their docs say parameters act as filters, so
 * a year or a name beside a right id can only lose matches. By title, the year
 * narrows a remake from the original; `query` overrides the title when the
 * person edited the search.
 */
export const searchFor = (
  identity: SubtitleIdentity,
  languages: string[],
  query?: string
): SubtitleQuery => {
  const edited = query?.trim();
  const byTitle = !!edited || identity.matchedBy === 'title';

  if (identity.kind === 'film') {
    if (!byTitle) {
      return identity.tmdbId ? { tmdbId: identity.tmdbId, languages } : { imdbId: identity.imdbId ?? undefined, languages };
    }
    return {
      query: edited || identity.title,
      year: edited ? undefined : identity.year ?? undefined,
      type: 'movie',
      languages
    };
  }

  const episode = { season: identity.season, episode: identity.episode, languages };
  if (!byTitle) {
    return identity.parentTmdbId
      ? { parentTmdbId: identity.parentTmdbId, ...episode }
      : { parentImdbId: identity.parentImdbId ?? undefined, ...episode };
  }
  return { query: edited || identity.title, type: 'episode', ...episode };
};

/**
 * Words a provider adds to a name that OpenSubtitles has never heard of.
 *
 * For the "Try …" suggestions when a search by title finds nothing (ST-TV-2).
 * The display name is already free of the prefix and superscript tags; these
 * are the ones left in plain text.
 */
const PACKAGING = /\b(4k|uhd|fhd|hd|sd|hevc|x26[45]|h\.?26[45]|multi\s*sub|sub|dub|sinkronizirano|titlovano|vip|raw)\b/gi;

/** Up to two search texts to offer when nothing was found: trimmed, and the original title. */
export const titleSuggestions = (identity: SubtitleIdentity, tried: string): string[] => {
  const fold = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const trimmed = identity.title.replace(PACKAGING, ' ').replace(/[\s\-–|:]+$/g, '').replace(/\s+/g, ' ').trim();
  const offers = [trimmed, identity.originalTitle ?? ''].filter(Boolean);
  return [...new Set(offers)].filter(offer => fold(offer) !== fold(tried)).slice(0, 2);
};
