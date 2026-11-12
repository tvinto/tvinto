import { Injectable, computed, inject } from '@angular/core';
import { SETTING_KEYS } from '@shared/types';
import { TmdbClient, TmdbFetch, TmdbKind, TmdbTitle } from '@shared/tmdb/client';
import {
  ChosenDescription,
  DescriptionLanguage,
  chooseDescription,
  findTmdbId,
  readDescriptionLanguage,
  tmdbLanguage,
  fold
} from '@shared/tmdb/describe';
import { episodeIdentity, filmIdentity } from '@shared/opensubtitles/identify';
import { SettingsService } from './settings.service';
import { ProviderAccessService } from './provider-access.service';
import { TmdbService } from './tmdb.service';
import { posterTitle } from '../utils/series-display.utils';

/** Where TMDB's answers are kept on the device. */
const CACHE_KEY = 'xtream_tmdb_cache';

/** Kept this long -- well inside the six months TMDB's terms allow. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** At most this many answers, the oldest going first, so storage stays small. */
const MOST_KEPT = 400;

/** How long to wait for the provider's own details before going on without them. */
const DETAILS_TIMEOUT_MS = 8000;

type Cached = Record<string, { at: number; value: unknown }>;

type Loose = Record<string, unknown>;

const object = (value: unknown): Loose =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Film, show and episode descriptions, from the provider or from TMDB.
 *
 * The choice is an account setting, so it follows the person between devices.
 * With the provider's chosen, TMDB is asked only where the provider wrote
 * nothing -- an episode with an empty space -- and with a language chosen, it
 * is asked first, in that language, then in English. The device calls TMDB
 * itself, with the key its sync service hands out; nothing a person looks at
 * passes through the service.
 */
@Injectable({ providedIn: 'root' })
export class DescriptionsService {
  private readonly settings = inject(SettingsService);
  private readonly provider = inject(ProviderAccessService);

  readonly language = computed<DescriptionLanguage>(() =>
    readDescriptionLanguage(this.settings.get(SETTING_KEYS.descriptionLanguage))
  );

  private readonly keys = inject(TmdbService);

  /** A seam for tests: how TMDB is reached. */
  get fetchImpl(): TmdbFetch {
    return this.keys.fetchImpl;
  }
  set fetchImpl(fetchImpl: TmdbFetch) {
    this.keys.fetchImpl = fetchImpl;
  }

  /** The provider's details of films asked about this launch, so reopening a panel asks it nothing. */
  private readonly filmDetails = new Map<string, Promise<unknown>>();

  setLanguage(language: DescriptionLanguage): void {
    this.settings.set(SETTING_KEYS.descriptionLanguage, language);
  }

  /** Whether this sync service has a TMDB key at all, for the setting to say so. */
  async available(): Promise<boolean> {
    return (await this.tmdb()) !== null;
  }

  /** The provider's details for a film, asked once per stream; null when it does not answer. */
  private async vodDetails(streamId: string | number): Promise<unknown> {
    const direct = await this.provider.direct();
    try {
      if (direct) {
        const key = String(streamId);
        if (!this.filmDetails.has(key)) {
          this.filmDetails.set(key, direct.client.getVodInfo(key, DETAILS_TIMEOUT_MS).catch(error => {
            this.filmDetails.delete(key);
            throw error;
          }));
        }
        return await this.filmDetails.get(key);
      }
    } catch {
      // Without the provider's details there is still TMDB, by name.
    }
    return null;
  }

  /**
   * The TMDB id of a film in the library, for its own page (round 6, TV-27):
   * the provider's, else by IMDb, else by name and year -- as its
   * description finds it. Null without a key or a match; the provider's own
   * words come back either way, for a page TMDB cannot help with.
   */
  async filmTmdbId(streamId: string | number, name: string): Promise<{ id: number | null; plot: string; name: string }> {
    const details = await this.vodDetails(streamId);
    const info = object(object(details)['info']);
    const plot = text(info['plot']) || text(info['description']);
    // A page opened by its address knows no name: the provider's details do.
    name = name || text(info['name']) || text(object(object(details)['movie_data'])['name']);
    const identity = filmIdentity(details, posterTitle(name));
    const tmdb = await this.tmdb();
    if (!tmdb) {
      return { id: null, plot, name };
    }
    const known = { tmdbId: identity.tmdbId, imdbId: identity.imdbId, title: identity.title, originalTitle: identity.originalTitle, year: identity.year };
    try {
      const id = await this.remembered(`id:movie:${known.tmdbId ?? ''}:${known.imdbId ?? ''}:${known.title}:${known.year ?? ''}`, () =>
        findTmdbId(tmdb, { kind: 'movie', ...known })
      );
      return { id, plot, name };
    } catch {
      return { id: null, plot, name };
    }
  }

  /**
   * A film's TMDB id from the name the catalogue shows alone -- no request to
   * the provider, so it can be asked for every poster on screen (the age
   * lock's covers, TV-31). Shares its remembered answer with filmTmdbId for a
   * film whose details named no id.
   */
  async filmTmdbIdByName(name: string): Promise<number | null> {
    const tmdb = await this.tmdb();
    if (!tmdb) {
      return null;
    }
    const identity = filmIdentity(null, posterTitle(name));
    const known = { tmdbId: null, imdbId: null, title: identity.title, originalTitle: identity.originalTitle, year: identity.year };
    try {
      return await this.remembered(`id:movie:::${known.title}:${known.year ?? ''}`, () => findTmdbId(tmdb, { kind: 'movie', ...known }));
    } catch {
      return null;
    }
  }

  /**
   * A show's TMDB id from the name the catalogue shows alone, asking the
   * provider nothing -- for the spotlight and the billboard (round 13).
   */
  async showTmdbIdByName(name: string): Promise<number | null> {
    const tmdb = await this.tmdb();
    if (!tmdb) {
      return null;
    }
    const identity = filmIdentity(null, posterTitle(name));
    const known = { tmdbId: null, imdbId: null, title: identity.title, originalTitle: identity.originalTitle, year: identity.year };
    try {
      const id = await this.remembered(`id:tv:::${known.title}:${known.year ?? ''}`, () => findTmdbId(tmdb, { kind: 'tv', ...known }));
      if (id) {
        return id;
      }
      // Several shows share a name -- "Supernatural" is three on TMDB -- and
      // with no year the careful match takes none of them. For a picture and
      // a few words, TMDB's first of that exact name, its most popular, is
      // the one meant (a user's For You, 31 October).
      const wanted = fold(known.title);
      const results = await tmdb.search('tv', known.title, known.year, 'en-US');
      return results.find(result => fold(result.title) === wanted || fold(result.originalTitle ?? '') === wanted)?.id ?? null;
    } catch {
      return null;
    }
  }

  /** A film's description, from its stream id and the name the catalogue shows. */
  async film(streamId: string | number, name: string): Promise<ChosenDescription | null> {
    const details = await this.vodDetails(streamId);
    const info = object(object(details)['info']);
    const ownWords = text(info['plot']) || text(info['description']);
    const display = posterTitle(name);
    const identity = filmIdentity(details, display);

    return this.describe('movie', ownWords, {
      tmdbId: identity.tmdbId,
      imdbId: identity.imdbId,
      title: identity.title,
      originalTitle: identity.originalTitle,
      year: identity.year
    });
  }

  /** A show's description, from the `get_series_info` its page already holds. */
  /** A show's TMDB id, as its description finds it (round 6, TV-29); null without a key or a match. */
  async showTmdbId(seriesInfo: unknown, name: string): Promise<number | null> {
    const identity = episodeIdentity(seriesInfo, { season: 1, episode: 1 }, posterTitle(name));
    const tmdb = await this.tmdb();
    if (!tmdb) {
      return null;
    }
    const known = {
      tmdbId: identity.parentTmdbId,
      imdbId: identity.parentImdbId,
      title: identity.title,
      originalTitle: identity.originalTitle,
      year: identity.year
    };
    try {
      return await this.remembered(`id:tv:${known.tmdbId ?? ''}:${known.imdbId ?? ''}:${known.title}:${known.year ?? ''}`, () =>
        findTmdbId(tmdb, { kind: 'tv', ...known })
      );
    } catch {
      return null;
    }
  }

  async show(seriesInfo: unknown, name: string): Promise<ChosenDescription | null> {
    const info = object(seriesInfo)['info'] ? object(object(seriesInfo)['info']) : object(seriesInfo);
    const ownWords = text(info['plot']) || text(info['description']);
    const identity = episodeIdentity(seriesInfo, { season: 1, episode: 1 }, posterTitle(name));
    return this.describe('tv', ownWords, {
      tmdbId: identity.parentTmdbId,
      imdbId: identity.parentImdbId,
      title: identity.title,
      originalTitle: identity.originalTitle,
      year: identity.year
    });
  }

  /**
   * A season's episode descriptions, by episode number: the provider's where
   * it wrote one (unless a language is chosen), TMDB's for the rest.
   */
  async episodes(
    seriesInfo: unknown,
    name: string,
    season: number,
    ownWords: ReadonlyMap<number, string>
  ): Promise<Map<number, ChosenDescription>> {
    const language = this.language();
    const shown = new Map<number, ChosenDescription>();
    const missing = [...ownWords.values()].some(words => !words.trim()) || ownWords.size === 0;

    if (language === 'provider' && !missing) {
      for (const [episode, words] of ownWords) {
        shown.set(episode, { text: words, source: 'provider' });
      }
      return shown;
    }

    const identity = episodeIdentity(seriesInfo, { season, episode: 1 }, posterTitle(name));
    const tmdb = await this.tmdb();
    const showId = tmdb
      ? await this.remembered(`id:tv:${identity.parentTmdbId ?? ''}:${identity.parentImdbId ?? ''}:${identity.title}`, () =>
          findTmdbId(tmdb, {
            kind: 'tv',
            tmdbId: identity.parentTmdbId,
            imdbId: identity.parentImdbId,
            title: identity.title,
            originalTitle: identity.originalTitle,
            year: identity.year
          })
        ).catch(() => null)
      : null;

    const read = async (lang: string) =>
      tmdb && showId
        ? new Map(
            (await this.remembered(`season:${showId}:${season}:${lang}`, () => tmdb.season(showId, season, lang)).catch(() => [])).map(
              episode => [episode.episode, episode.overview] as const
            )
          )
        : new Map<number, string>();

    const chosen = language === 'provider' ? new Map<number, string>() : await read(tmdbLanguage(language));
    const english = language === 'en' ? chosen : await read('en-US');

    const episodes = new Set([...ownWords.keys(), ...chosen.keys(), ...english.keys()]);
    for (const episode of episodes) {
      const found = chooseDescription(language, {
        chosen: chosen.get(episode),
        english: english.get(episode),
        provider: ownWords.get(episode)
      });
      if (found) {
        shown.set(episode, found);
      }
    }
    return shown;
  }

  /** The description for one film or show, by the rules in `chooseDescription`. */
  private async describe(
    kind: TmdbKind,
    ownWords: string,
    known: { tmdbId: number | null; imdbId: number | null; title: string; originalTitle: string | null; year: number | null }
  ): Promise<ChosenDescription | null> {
    const language = this.language();
    if (language === 'provider' && ownWords) {
      return { text: ownWords, source: 'provider' };
    }

    const tmdb = await this.tmdb();
    if (!tmdb) {
      return ownWords ? { text: ownWords, source: 'provider' } : null;
    }

    try {
      const id = await this.remembered(`id:${kind}:${known.tmdbId ?? ''}:${known.imdbId ?? ''}:${known.title}:${known.year ?? ''}`, () =>
        findTmdbId(tmdb, { kind, ...known })
      );
      if (!id) {
        return chooseDescription(language, { provider: ownWords });
      }
      const details = (lang: string) =>
        this.remembered<TmdbTitle | null>(`${kind}:${id}:${lang}`, () => tmdb.details(kind, id, lang));
      const chosen = language === 'provider' ? null : await details(tmdbLanguage(language));
      const english = chosen?.overview || language === 'en' ? chosen : await details('en-US');
      return chooseDescription(language, {
        chosen: chosen?.overview,
        english: english?.overview,
        provider: ownWords
      });
    } catch {
      // TMDB not answering, or the key refused: the provider's words, as before.
      return ownWords ? { text: ownWords, source: 'provider' } : null;
    }
  }

  /** The client, or null when this device has no TMDB key from anywhere (TmdbService). */
  private tmdb(): Promise<TmdbClient | null> {
    return this.keys.client();
  }

  /** An answer kept on the device for a month, or asked for. */
  private async remembered<T>(key: string, ask: () => Promise<T>): Promise<T> {
    const cache = this.readCache();
    const held = cache[key];
    if (held && Date.now() - held.at < KEEP_MS) {
      return held.value as T;
    }
    const value = await ask();
    this.keep(key, value);
    return value;
  }

  private keep(key: string, value: unknown): void {
    const cache = this.readCache();
    cache[key] = { at: Date.now(), value };
    const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, MOST_KEPT);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // Only costs a request next time.
    }
  }

  private readCache(): Cached {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return parsed && typeof parsed === 'object' ? (parsed as Cached) : {};
    } catch {
      return {};
    }
  }
}
