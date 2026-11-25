import { Injectable, inject } from '@angular/core';
import { Stream } from '@shared/types';
import { TmdbEpisodeDate, TmdbShow, TmdbTrending, tmdbBackdrop, tmdbPoster } from '@shared/tmdb/client';
import { lockRating } from '@shared/tmdb/age';
import { AgeLockService } from './age-lock.service';
import { CopyChoicesService } from './copy-choices.service';
import { CopyFallbackService } from './copy-fallback.service';
import { ShowNews, showNews } from '@shared/tmdb/episodes';
import { tmdbLanguage } from '@shared/tmdb/describe';
import { DescriptionsService } from './descriptions.service';
import { FilmCopy, FilmFeature, FilmLink, FilmService, TRAILERS_OFFERED, trailerLanguages } from './film.service';
import { TmdbTrailer, orderTrailers, videoLanguages } from '@shared/tmdb/trailers';
import { PopularService } from './popular.service';
import { TmdbService } from './tmdb.service';

/** What TMDB adds to a show's page (round 6, TV-29). */
export interface ShowPage {
  /** The provider's series id this page is for. */
  seriesId: string;
  tmdbId: number;
  title: string;
  year: string;
  genres: string[];
  seasons: number;
  rating: string;
  vote: number | null;
  backdrop: string;
  poster: string;
  /** The line about the next episode, or null when nothing is announced. */
  news: ShowNews;
  /** Every copy of the show the library holds, in the order the person's languages put them. */
  copies: FilmCopy[];
  recommendations: TmdbTrending[];
  /** Its trailers, the one to open first (TV-33). */
  trailers: TmdbTrailer[];
}

/** What For You needs to know about a show, from TMDB alone (FY-TV-2). */
export interface ShowNewsFacts {
  tmdbId: number;
  poster: string;
  status: string;
  next: TmdbEpisodeDate | null;
  last: TmdbEpisodeDate | null;
}

/** Where each show's facts for For You are kept, for the day they were asked on. */
const NEWS_KEY = 'xtream_show_news';

/** How long a show's page is kept for its copies page and a return to it. */
const PAGE_KEEP_MS = 5 * 60 * 1000;

/**
 * TMDB on a show's page (round 6, TV-29): the age rating and score, the next
 * episode, the copies episodes play in -- one choice per show -- and More like
 * this. Absent, not empty, on a device without a TMDB key or for a show TMDB
 * does not know: the page is then exactly the earlier one.
 */
@Injectable({ providedIn: 'root' })
export class ShowService {
  private readonly choices = inject(CopyChoicesService);
  private readonly copyFallback = inject(CopyFallbackService);
  private readonly ages = inject(AgeLockService);
  private readonly tmdb = inject(TmdbService);
  private readonly popular = inject(PopularService);
  private readonly films = inject(FilmService);
  private readonly descriptions = inject(DescriptionsService);

  private readonly pages = new Map<string, { at: number; page: Promise<ShowPage | null> }>();

  /** The page for a provider series, from the `get_series_info` its page already holds. */
  forSeries(seriesId: string, name: string, seriesInfo: unknown): Promise<ShowPage | null> {
    const held = this.pages.get(seriesId);
    if (held && Date.now() - held.at < PAGE_KEEP_MS) {
      return held.page;
    }
    const page = this.build(seriesId, name, seriesInfo);
    this.pages.set(seriesId, { at: Date.now(), page });
    page.catch(() => this.pages.delete(seriesId));
    return page;
  }

  /** Forgets a kept page, so the next `forSeries` looks for its copies again. */
  forget(seriesId: string): void {
    this.pages.delete(seriesId);
  }

  /** A page already worked out, for the copies page. */
  cached(seriesId: string): Promise<ShowPage | null> | null {
    return this.pages.get(seriesId)?.page ?? null;
  }

  private async build(seriesId: string, name: string, seriesInfo: unknown): Promise<ShowPage | null> {
    const client = await this.tmdb.client();
    const id = client ? await this.descriptions.showTmdbId(seriesInfo, name) : null;
    if (!client || !id) {
      return null;
    }
    const show: TmdbShow | null = await client.show(id, this.language(), videoLanguages(trailerLanguages()));
    if (!show) {
      return null;
    }
    const streams = await this.popular.copiesOf(show, 'series');
    const self = { stream_id: seriesId, name } as unknown as Stream;
    const all = streams.some(stream => String(stream.stream_id) === seriesId) ? streams : [self, ...streams];
    const held = heldEpisodes(seriesInfo);
    return {
      seriesId,
      tmdbId: id,
      title: show.title,
      year: show.year,
      genres: show.genres,
      seasons: show.seasons,
      rating: lockRating(show.certifications, this.ages.lock().country),
      vote: show.vote,
      backdrop: tmdbBackdrop(show.backdrop),
      poster: tmdbPoster(show.poster),
      news: showNews(show, localToday(), (season, episode) => held.has(`${season}:${episode}`)),
      copies: await this.films.described(all, 'series'),
      recommendations: show.recommendations,
      trailers: orderTrailers(show.trailers, trailerLanguages()).slice(0, TRAILERS_OFFERED)
    };
  }

  /**
   * The dates of a show's last and next episodes, for For You's "New in your
   * shows": from TMDB, at most once a day per show, and without asking the
   * provider anything -- `info` is what the device's catalogue or history
   * already holds. Null on a device without a key or for a show TMDB does
   * not know.
   */
  async newsFacts(seriesId: string, name: string, info: unknown, today = localToday()): Promise<ShowNewsFacts | null> {
    const kept = readNews();
    const held = kept.day === today ? kept.shows[seriesId] : undefined;
    if (held !== undefined) {
      return held;
    }
    const client = await this.tmdb.client();
    if (!client) {
      return null;
    }
    const id = await this.descriptions.showTmdbId(info, name);
    // A request that failed is asked again next time; a show TMDB does not know, tomorrow.
    const show = id ? await client.show(id, this.language()).catch(() => undefined) : null;
    if (show === undefined) {
      return null;
    }
    const facts: ShowNewsFacts | null =
      id && show ? { tmdbId: id, poster: tmdbPoster(show.poster), status: show.status, next: show.next, last: show.last } : null;
    const now = readNews();
    writeNews({ day: today, shows: { ...(now.day === today ? now.shows : {}), [seriesId]: facts } });
    return facts;
  }

  /** TMDB's recommendations kept to the shows the library has. */
  async moreLikeThis(page: ShowPage, signal?: AbortSignal): Promise<FilmLink[]> {
    return (await this.films.linked(page.recommendations, 'series', signal)).filter(link => link.copies > 0);
  }

  /** The copy of a show a TMDB list opens: the one chosen for it, else the first in the person's languages. */
  async preferredCopy(item: TmdbTrending): Promise<Stream | null> {
    const copies = await this.films.described(await this.popular.copiesOf(item, 'series'), 'series');
    const chosen = this.chosen(item.id);
    return (copies.find(copy => String(copy.stream.stream_id) === chosen) ?? this.copyFallback.inPlayOrder(copies)[0])?.stream ?? null;
  }

  chosen(tmdbId: number): string | null {
    return this.choices.chosen('shows', tmdbId);
  }

  /** Kept for the account, so another device plays the same copy (TV-29). */
  choose(tmdbId: number, seriesId: string | number): void {
    this.choices.choose('shows', tmdbId, seriesId);
  }


  private readonly features = new Map<string, Promise<FilmFeature | null>>();

  /**
   * What the spotlight and the billboard show of a show (round 13): its page's
   * when it has been opened, else TMDB's, found by the name the catalogue
   * shows -- the provider is asked nothing. Kept for the session.
   */
  feature(seriesId: string, name: string): Promise<FilmFeature | null> {
    const held = this.features.get(seriesId);
    if (held) {
      return held;
    }
    const found = (async (): Promise<FilmFeature | null> => {
      const page = await (this.cached(seriesId) ?? Promise.resolve(null)).catch(() => null);
      if (page) {
        return { backdrop: page.backdrop, overview: '', year: page.year, runtime: 0, genres: page.genres, rating: page.rating, vote: page.vote, seasons: page.seasons };
      }
      const client = await this.tmdb.client();
      const id = client ? await this.descriptions.showTmdbIdByName(name).catch(() => null) : null;
      const show = client && id ? await client.show(id, this.language()).catch(() => null) : null;
      if (!show) {
        return null;
      }
      return {
        backdrop: tmdbBackdrop(show.backdrop ?? ''),
        overview: show.overview,
        year: show.year,
        runtime: 0,
        genres: show.genres ?? [],
        rating: lockRating(show.certifications, this.ages.lock().country),
        vote: show.vote ?? null,
        seasons: show.seasons
      };
    })();
    this.features.set(seriesId, found);
    found.then(
      feature => feature || this.features.delete(seriesId),
      () => this.features.delete(seriesId)
    );
    return found;
  }

  private language(): string {
    const chosen = this.descriptions.language();
    return tmdbLanguage(chosen === 'provider' ? 'en' : chosen);
  }
}

/** "2026-10-24" in the viewer's own calendar. */
export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "season:episode" for every episode the provider's list has. */
function heldEpisodes(seriesInfo: unknown): Set<string> {
  const held = new Set<string>();
  const episodes = (seriesInfo as { episodes?: Record<string, Array<{ season?: unknown; episode_num?: unknown }>> } | null)?.episodes ?? {};
  for (const [season, list] of Object.entries(episodes)) {
    for (const episode of Array.isArray(list) ? list : []) {
      held.add(`${Number(episode.season ?? season)}:${Number(episode.episode_num)}`);
    }
  }
  return held;
}

interface KeptNews {
  day: string;
  shows: Record<string, ShowNewsFacts | null>;
}

function readNews(): KeptNews {
  try {
    const held = JSON.parse(localStorage.getItem(NEWS_KEY) ?? 'null') as KeptNews | null;
    return held && typeof held.day === 'string' && held.shows && typeof held.shows === 'object' ? held : { day: '', shows: {} };
  } catch {
    return { day: '', shows: {} };
  }
}

function writeNews(news: KeptNews): void {
  try {
    localStorage.setItem(NEWS_KEY, JSON.stringify(news));
  } catch {
    // Storage unavailable: asked again next time.
  }
}

