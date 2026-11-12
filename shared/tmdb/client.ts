/**
 * TMDB, as far as descriptions and "Popular now" need it.
 *
 * Called from the device, with the key the sync service hands out -- the same
 * arrangement as OpenSubtitles. Takes either kind of key TMDB issues: the
 * short v3 "API key", sent as `api_key`, or the long v4 "read access token",
 * sent as a bearer token; whichever a user set works.
 *
 * Every call takes a language and gets what TMDB has in it -- TMDB does not
 * translate, it keeps what people wrote per language, so an empty overview
 * means "not written in this language", which the caller falls back from.
 */

const BASE = 'https://api.themoviedb.org/3';

export type TmdbFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

import { TmdbTrailer, trailersFrom } from './trailers';

export type TmdbKind = 'movie' | 'tv';

/** A film or show, with what descriptions need. */
export interface TmdbTitle {
  id: number;
  title: string;
  originalTitle: string;
  overview: string;
  /** "2019", or '' when TMDB has no date. */
  year: string;
}

/** A film or show trending this week, with its poster. */
export interface TmdbTrending extends TmdbTitle {
  kind: TmdbKind;
  /** The poster's path on TMDB's image server, or '' when it has none. */
  poster: string;
}

/** A poster's address, at the width a card draws it. */
export const tmdbPoster = (path: string, width: 'w185' | 'w342' = 'w342'): string =>
  path ? `https://image.tmdb.org/t/p/${width}${path}` : '';

/** What a film's own page shows (TV-27): its details, artwork, score and age ratings. */
export interface TmdbFilm extends TmdbTitle {
  /** Minutes, or 0 when TMDB does not know. */
  runtime: number;
  genres: string[];
  /** TMDB's vote average out of 10, or null when too few have voted. */
  vote: number | null;
  poster: string;
  backdrop: string;
  /** Age ratings by country code ("HR", "DE", "US"), as each country writes them. */
  certifications: Record<string, string>;
  /** The series it belongs to (Resident Evil 1-7), or null. */
  collection: { id: number; name: string; poster: string; backdrop: string } | null;
  /** TMDB's recommendations, most fitting first: what "More like this" is kept from. */
  recommendations: TmdbTrending[];
  /** Its trailers on YouTube, in TMDB's order (orderTrailers puts them in the person's). */
  trailers: TmdbTrailer[];
}

/** An episode TMDB names: the next one announced, or the last one aired. */
export interface TmdbEpisodeDate {
  season: number;
  episode: number;
  name: string;
  /** "2026-10-24", or '' when not dated. */
  airDate: string;
}

/** What a show's own page shows (TV-29). */
export interface TmdbShow extends TmdbTitle {
  genres: string[];
  vote: number | null;
  poster: string;
  backdrop: string;
  seasons: number;
  /** "Returning Series", "Ended", "Canceled"... as TMDB writes it. */
  status: string;
  next: TmdbEpisodeDate | null;
  last: TmdbEpisodeDate | null;
  certifications: Record<string, string>;
  recommendations: TmdbTrending[];
  trailers: TmdbTrailer[];
}

/** A genre, as TMDB names it. */
export interface TmdbGenre {
  id: number;
  name: string;
}

/**
 * Which of TMDB's lists (TV-32): 'trending' for the week's, 'top' for the
 * best rated, 'genre-<id>' for a genre's most popular, 'genre-<id>-top' for
 * its best rated.
 */
export type TmdbList = string;

/** How few votes a title may have and still count as top rated in a genre: else a 10 from three people leads. */
const TOP_VOTES = { movie: 2000, tv: 500 } as const;

/** The genre a list is of, and whether it is its best rated; null for a list that is not a genre's. */
export function listGenre(list: TmdbList): { genre: number; top: boolean } | null {
  const found = /^genre-(\d+)(-top)?$/.exec(list);
  return found ? { genre: Number(found[1]), top: !!found[2] } : null;
}

/** Where a list is asked for. */
export function listRequest(kind: TmdbKind, list: TmdbList): { path: string; params: Record<string, string | number> } {
  // Best rated by enough people -- TMDB's own top-rated list leads with
  // this year's releases on a few hundred votes, not The Godfather.
  if (list === 'top') {
    return { path: `/discover/${kind}`, params: { sort_by: 'vote_average.desc', 'vote_count.gte': TOP_VOTES[kind] } };
  }
  const genre = listGenre(list);
  if (genre) {
    return {
      path: `/discover/${kind}`,
      params: genre.top
        ? { with_genres: genre.genre, sort_by: 'vote_average.desc', 'vote_count.gte': TOP_VOTES[kind] }
        : { with_genres: genre.genre, sort_by: 'popularity.desc' }
    };
  }
  return { path: `/trending/${kind}/week`, params: {} };
}

/** A film series in order (TV-30). */
export interface TmdbCollection {
  id: number;
  name: string;
  backdrop: string;
  /** Its films, earliest first. */
  parts: TmdbTrending[];
}

/** A backdrop's address, at a width a page draws it. */
export const tmdbBackdrop = (path: string, width: 'w780' | 'w1280' = 'w1280'): string =>
  path ? `https://image.tmdb.org/t/p/${width}${path}` : '';

/**
 * The age rating to show: the first of these countries that rates the film
 * (round 6, TV-31 -- Croatia rates few, so Germany, then the United States).
 */
export function ageRating(certifications: Record<string, string>, countries: readonly string[] = ['HR', 'DE', 'US']): string {
  for (const country of countries) {
    if (certifications[country]) {
      return certifications[country];
    }
  }
  return '';
}

export interface TmdbEpisode {
  episode: number;
  name: string;
  overview: string;
}

/** A refusal TMDB gave, so the caller can tell a bad key from a missing title. */
export class TmdbError extends Error {
  constructor(readonly status: number) {
    super(`TMDB answered ${status}`);
    this.name = 'TmdbError';
  }
}

type Loose = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const year = (value: unknown): string => /^(\d{4})/.exec(text(value))?.[1] ?? '';

const titleFrom = (raw: Loose): TmdbTitle => ({
  id: Number(raw['id']),
  title: text(raw['title']) || text(raw['name']),
  originalTitle: text(raw['original_title']) || text(raw['original_name']),
  overview: text(raw['overview']),
  year: year(raw['release_date']) || year(raw['first_air_date'])
});

/** A list of films or shows as trending, recommendations and collections give them. */
const listFrom = (value: unknown, kind: TmdbKind): TmdbTrending[] =>
  (Array.isArray(value) ? (value as Loose[]) : [])
    .filter(item => (item['media_type'] ?? kind) === kind)
    .map(item => ({ ...titleFrom(item), kind, poster: text(item['poster_path']) }));

const episodeDateFrom = (value: unknown): TmdbEpisodeDate | null => {
  const raw = value && typeof value === 'object' ? (value as Loose) : null;
  return raw && Number(raw['episode_number'])
    ? { season: Number(raw['season_number']) || 0, episode: Number(raw['episode_number']), name: text(raw['name']), airDate: text(raw['air_date']) }
    : null;
};

const collectionFrom = (value: unknown): TmdbFilm['collection'] => {
  const raw = value && typeof value === 'object' ? (value as Loose) : null;
  return raw && Number(raw['id'])
    ? { id: Number(raw['id']), name: text(raw['name']), poster: text(raw['poster_path']), backdrop: text(raw['backdrop_path']) }
    : null;
};

export function tmdbClient(fetchFn: TmdbFetch, key: string) {
  // A v4 token is a JWT; a v3 key is 32 hex characters.
  const bearer = key.startsWith('eyJ');

  const get = async (path: string, params: Record<string, string | number | undefined>): Promise<Loose | null> => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        query.set(name, String(value));
      }
    }
    if (!bearer) {
      query.set('api_key', key);
    }
    const response = await fetchFn(`${BASE}${path}?${query.toString()}`, {
      headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${key}` } : {}) }
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new TmdbError(response.status);
    }
    const body = await response.json();
    return body && typeof body === 'object' ? (body as Loose) : null;
  };

  return {
    /** A film or show by its TMDB id, in a language, or null if TMDB has no such id. */
    async details(kind: TmdbKind, id: number, language: string): Promise<TmdbTitle | null> {
      const raw = await get(`/${kind}/${id}`, { language });
      return raw ? titleFrom(raw) : null;
    },

    /** A title's age ratings alone, by country, for the age lock (TV-31); null if TMDB has no such id. */
    async certifications(kind: TmdbKind, id: number): Promise<Record<string, string> | null> {
      const raw = await get(kind === 'movie' ? `/movie/${id}/release_dates` : `/tv/${id}/content_ratings`, {});
      return raw ? (kind === 'movie' ? filmRatingsFrom(raw) : showRatingsFrom(raw)) : null;
    },

    /** A film with what its own page needs, ratings included, in one request; null if TMDB has no such id. */
    async film(id: number, language: string, videoLanguage = 'en,null'): Promise<TmdbFilm | null> {
      const raw = await get(`/movie/${id}`, { language, append_to_response: 'release_dates,recommendations,videos', include_video_language: videoLanguage });
      if (!raw) {
        return null;
      }
      const certifications = filmRatingsFrom(raw['release_dates']);
      const vote = Number(raw['vote_average']);
      return {
        ...titleFrom(raw),
        runtime: Number(raw['runtime']) || 0,
        genres: (Array.isArray(raw['genres']) ? (raw['genres'] as Loose[]) : []).map(genre => text(genre['name'])).filter(Boolean),
        vote: Number(raw['vote_count']) >= 10 && vote > 0 ? Math.round(vote * 10) / 10 : null,
        poster: text(raw['poster_path']),
        backdrop: text(raw['backdrop_path']),
        certifications,
        collection: collectionFrom(raw['belongs_to_collection']),
        recommendations: listFrom((raw['recommendations'] as Loose | undefined)?.['results'], 'movie'),
        trailers: trailersFrom(raw['videos'])
      };
    },

    /** A show with what its own page needs, ratings and recommendations included; null if TMDB has no such id. */
    async show(id: number, language: string, videoLanguage = 'en,null'): Promise<TmdbShow | null> {
      const raw = await get(`/tv/${id}`, { language, append_to_response: 'content_ratings,recommendations,videos', include_video_language: videoLanguage });
      if (!raw) {
        return null;
      }
      const certifications = showRatingsFrom(raw['content_ratings']);
      const vote = Number(raw['vote_average']);
      return {
        ...titleFrom(raw),
        genres: (Array.isArray(raw['genres']) ? (raw['genres'] as Loose[]) : []).map(genre => text(genre['name'])).filter(Boolean),
        vote: Number(raw['vote_count']) >= 10 && vote > 0 ? Math.round(vote * 10) / 10 : null,
        poster: text(raw['poster_path']),
        backdrop: text(raw['backdrop_path']),
        seasons: Number(raw['number_of_seasons']) || 0,
        status: text(raw['status']),
        next: episodeDateFrom(raw['next_episode_to_air']),
        last: episodeDateFrom(raw['last_episode_to_air']),
        certifications,
        recommendations: listFrom((raw['recommendations'] as Loose | undefined)?.['results'], 'tv'),
        trailers: trailersFrom(raw['videos'])
      };
    },

    /** A film series, its films in release order; null if TMDB has no such id. */
    async collection(id: number, language: string): Promise<TmdbCollection | null> {
      const raw = await get(`/collection/${id}`, { language });
      if (!raw) {
        return null;
      }
      const parts = listFrom(raw['parts'], 'movie').sort((a, b) => (a.year || '9999').localeCompare(b.year || '9999'));
      return { id: Number(raw['id']), name: text(raw['name']), backdrop: text(raw['backdrop_path']), parts };
    },

    /** One season's episodes, in a language. */
    async season(showId: number, season: number, language: string): Promise<TmdbEpisode[]> {
      const raw = await get(`/tv/${showId}/season/${season}`, { language });
      const episodes = Array.isArray(raw?.['episodes']) ? (raw?.['episodes'] as Loose[]) : [];
      return episodes.map(episode => ({
        episode: Number(episode['episode_number']),
        name: text(episode['name']),
        overview: text(episode['overview'])
      }));
    },

    /** Films or shows of a name, the first page. */
    async search(kind: TmdbKind, query: string, yearOf: number | null, language: string): Promise<TmdbTitle[]> {
      const raw = await get(`/search/${kind}`, {
        query,
        language,
        ...(yearOf ? (kind === 'movie' ? { year: yearOf } : { first_air_date_year: yearOf }) : {})
      });
      const results = Array.isArray(raw?.['results']) ? (raw?.['results'] as Loose[]) : [];
      return results.map(titleFrom);
    },

    /**
     * Films, or shows, trending this week, most first: one page of twenty,
     * and how many pages TMDB will hand out -- 500 at most, whatever it says.
     */
    async trending(kind: TmdbKind, language: string, page = 1): Promise<{ items: TmdbTrending[]; pages: number }> {
      const raw = await get(`/trending/${kind}/week`, { language, page });
      const results = Array.isArray(raw?.['results']) ? (raw?.['results'] as Loose[]) : [];
      return {
        items: listFrom(results, kind),
        pages: Math.min(Number(raw?.['total_pages']) || 0, 500)
      };
    },

    /**
     * A page of one of TMDB's lists (TV-32): the week's trending, the top
     * rated, or a genre's most popular or best rated (`TmdbList`).
     */
    async list(kind: TmdbKind, list: TmdbList, language: string, page = 1): Promise<{ items: TmdbTrending[]; pages: number }> {
      const { path, params } = listRequest(kind, list);
      const raw = await get(path, { ...params, language, page });
      const results = Array.isArray(raw?.['results']) ? (raw?.['results'] as Loose[]) : [];
      return {
        items: listFrom(results, kind),
        pages: Math.min(Number(raw?.['total_pages']) || 0, 500)
      };
    },

    /** TMDB's genres for films or shows, named in a language -- '' where TMDB has no name in it. */
    async genres(kind: TmdbKind, language: string): Promise<TmdbGenre[]> {
      const raw = await get(`/genre/${kind}/list`, { language });
      const found = Array.isArray(raw?.['genres']) ? (raw?.['genres'] as Loose[]) : [];
      return found.map(genre => ({ id: Number(genre['id']), name: text(genre['name']) })).filter(genre => genre.id > 0);
    },

    /** A title's genre ids alone, for the genres someone watches most; null if TMDB has no such id. */
    async genreIds(kind: TmdbKind, id: number): Promise<number[] | null> {
      const raw = await get(`/${kind}/${id}`, {});
      if (!raw) {
        return null;
      }
      return (Array.isArray(raw['genres']) ? (raw['genres'] as Loose[]) : []).map(genre => Number(genre['id'])).filter(Boolean);
    },

    /** Whether TMDB takes this key: true, or a TmdbError saying why not. */
    async check(): Promise<true> {
      await get('/configuration', {});
      return true;
    },

    /** The TMDB id for an IMDb id, for a provider that gave only the latter. */
    async fromImdb(kind: TmdbKind, imdbId: number): Promise<number | null> {
      const raw = await get(`/find/tt${String(imdbId).padStart(7, '0')}`, { external_source: 'imdb_id' });
      const found = raw?.[kind === 'movie' ? 'movie_results' : 'tv_results'];
      const first = Array.isArray(found) ? (found[0] as Loose | undefined) : undefined;
      return first ? Number(first['id']) || null : null;
    }
  };
}

export type TmdbClient = ReturnType<typeof tmdbClient>;

/** A film's ratings by country, from `release_dates`: the first certification each country gives. */
function filmRatingsFrom(raw: unknown): Record<string, string> {
  const certifications: Record<string, string> = {};
  const countries = (raw as Loose | undefined)?.['results'];
  for (const country of Array.isArray(countries) ? (countries as Loose[]) : []) {
    const dates = Array.isArray(country['release_dates']) ? (country['release_dates'] as Loose[]) : [];
    const rated = dates.map(date => text(date['certification'])).find(Boolean);
    if (rated) {
      certifications[text(country['iso_3166_1']).toUpperCase()] = rated;
    }
  }
  return certifications;
}

/** A show's ratings by country, from `content_ratings`. */
function showRatingsFrom(raw: unknown): Record<string, string> {
  const certifications: Record<string, string> = {};
  const ratings = (raw as Loose | undefined)?.['results'];
  for (const rating of Array.isArray(ratings) ? (ratings as Loose[]) : []) {
    if (text(rating['rating'])) {
      certifications[text(rating['iso_3166_1']).toUpperCase()] = text(rating['rating']);
    }
  }
  return certifications;
}
