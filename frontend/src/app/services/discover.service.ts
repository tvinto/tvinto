import { Injectable, inject } from '@angular/core';
import { WatchProgress } from '@shared/types';
import { TmdbGenre, TmdbKind } from '@shared/tmdb/client';
import { tmdbLanguage } from '@shared/tmdb/describe';
import { HR_GENRE_NAMES } from '@shared/tmdb/genres';
import { DescriptionsService } from './descriptions.service';
import { PopularService } from './popular.service';
import { TmdbService } from './tmdb.service';
import { currentLanguage } from '../utils/i18n';

/** A genre is offered once its most popular titles include this many the library has (TV-32). */
export const GENRE_MIN = 6;

/** How many of the latest watched titles say which genres someone watches. */
const WATCHED_LOOKED_AT = 15;

const DAY_MS = 24 * 60 * 60 * 1000;
const GENRES_KEEP_MS = 30 * DAY_MS;
const COUNTS_KEEP_MS = 7 * DAY_MS;

/**
 * Browsing Movies and TV Shows by TMDB's lists (TV-32, P-20): the genres,
 * which of them this library has enough of, and which this person watches
 * most -- each from TMDB, kept on the device so a launch asks again rarely.
 * Nothing here asks the provider: titles are matched against the catalogue
 * the device already holds.
 */
@Injectable({ providedIn: 'root' })
export class DiscoverService {
  private readonly tmdb = inject(TmdbService);
  private readonly popular = inject(PopularService);
  private readonly descriptions = inject(DescriptionsService);

  /** TMDB's genres in the app's language; empty without a key or when TMDB does not answer. */
  async genres(kind: TmdbKind): Promise<TmdbGenre[]> {
    const language = this.language();
    const key = `xtream_tmdb_genres_${kind}_${language}`;
    const kept = read<{ at: number; genres: TmdbGenre[] }>(key);
    if (kept && Date.now() - kept.at < GENRES_KEEP_MS) {
      return kept.genres;
    }
    const client = await this.tmdb.client();
    if (!client) {
      return [];
    }
    try {
      let genres = await client.genres(kind, language);
      // TMDB has no Croatian names for genres: ours, else English.
      if (language === 'hr-HR') {
        genres = genres.map(genre => ({ ...genre, name: HR_GENRE_NAMES[genre.id] ?? genre.name }));
      }
      if (genres.some(genre => !genre.name) && language !== 'en-US') {
        const english = new Map((await client.genres(kind, 'en-US')).map(genre => [genre.id, genre.name]));
        genres = genres.map(genre => ({ ...genre, name: genre.name || english.get(genre.id) || '' }));
      }
      genres = genres.filter(genre => genre.name);
      if (genres.length) {
        write(key, { at: Date.now(), genres });
      }
      return genres;
    } catch {
      return kept?.genres ?? [];
    }
  }

  /** The genres to offer: those not yet counted, and those the library has enough of. */
  async offered(kind: TmdbKind): Promise<TmdbGenre[]> {
    const counts = read<Counts>(countsKey(kind))?.counts ?? {};
    return (await this.genres(kind)).filter(genre => (counts[genre.id] ?? GENRE_MIN) >= GENRE_MIN);
  }

  /**
   * Counts, once a week, how many of each genre's most popular titles the
   * library has -- up to six, which is all the question needs. One genre at
   * a time, stopping when `stopped` says so.
   */
  async countGenres(kind: TmdbKind, stopped: () => boolean): Promise<boolean> {
    const kept = read<Counts>(countsKey(kind));
    const fresh = kept && Date.now() - kept.at < COUNTS_KEEP_MS ? kept : { at: Date.now(), counts: {} };
    let changed = false;
    for (const genre of await this.genres(kind)) {
      if (stopped()) {
        break;
      }
      if (fresh.counts[genre.id] !== undefined) {
        continue;
      }
      try {
        fresh.counts[genre.id] = (await this.popular.page(kind, 1, `genre-${genre.id}`, false)).found.length;
        changed = true;
        write(countsKey(kind), fresh);
      } catch {
        break;
      }
    }
    return changed;
  }

  /**
   * The genres this person watches most, most first: from the latest titles
   * in the history, each looked up on TMDB once and kept. A genre needs two
   * titles to count, so one film is not a taste.
   */
  async watched(kind: TmdbKind, history: readonly WatchProgress[], limit = 2): Promise<number[]> {
    const client = await this.tmdb.client();
    if (!client) {
      return [];
    }
    const seen = new Set<string>();
    const tally = new Map<number, number>();
    const titles = read<Record<string, number[]>>(TITLE_GENRES_KEY) ?? {};
    for (const entry of history) {
      const show = entry.seriesId ?? entry.itemId;
      if (seen.size >= WATCHED_LOOKED_AT || seen.has(show)) {
        continue;
      }
      seen.add(show);
      const id =
        kind === 'movie'
          ? ((await this.descriptions.filmTmdbId(entry.itemId, entry.name).catch(() => null))?.id ?? null)
          : await this.descriptions.showTmdbId(null, entry.name).catch(() => null);
      if (!id) {
        continue;
      }
      const key = `${kind}:${id}`;
      let genres = titles[key];
      if (!genres) {
        genres = (await client.genreIds(kind, id).catch(() => null)) ?? [];
        titles[key] = genres;
        write(TITLE_GENRES_KEY, titles);
      }
      for (const genre of genres) {
        tally.set(genre, (tally.get(genre) ?? 0) + 1);
      }
    }
    return [...tally]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([genre]) => genre);
  }

  private language(): string {
    // Genre names are the app's words, whatever language descriptions are in.
    return tmdbLanguage(currentLanguage());
  }
}

interface Counts {
  at: number;
  counts: Record<number, number>;
}

const countsKey = (kind: TmdbKind) => `xtream_tmdb_genre_counts_${kind}`;

/** Each looked-up title's genres, by "movie:603". */
const TITLE_GENRES_KEY = 'xtream_tmdb_title_genres';

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: asked again next time.
  }
}
