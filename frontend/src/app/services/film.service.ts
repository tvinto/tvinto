import { Injectable, inject } from '@angular/core';
import { Stream } from '@shared/types';
import { TmdbClient, TmdbFilm, TmdbTrending, tmdbBackdrop, tmdbPoster } from '@shared/tmdb/client';
import { lockRating } from '@shared/tmdb/age';
import { TmdbTrailer, orderTrailers, videoLanguages } from '@shared/tmdb/trailers';
import { AgeLockService } from './age-lock.service';
import { CopyChoicesService } from './copy-choices.service';
import { CopyFallbackService } from './copy-fallback.service';
import { copyLanguage, copyQualityLabel, isCinemaRecording, orderCopies } from '@shared/tmdb/copies';
import { plainTitle } from '@shared/tmdb/popular';
import { tmdbLanguage } from '@shared/tmdb/describe';
import { DescriptionsService } from './descriptions.service';
import { PopularService } from './popular.service';
import { TmdbService } from './tmdb.service';
import { XtreamService } from './xtream.service';
import { categoryNames, preferredLanguages } from '../components/for-you/popular-cards';
import { posterTitle } from '../utils/series-display.utils';
import { locale } from '../utils/i18n';

/** One copy of a film as its page lists it (TV-28). */
export interface FilmCopy {
  stream: Stream;
  /** The provider's category, how people recognise "the good one". */
  category: string;
  /** "hr", "en"... or '' when the provider's tags do not say. */
  language: string;
  /** The language as a word, in the app's language: "Hrvatski", "Arabic". */
  languageName: string;
  /** "4K", "HD", or ''. */
  quality: string;
  cinema: boolean;
}

/** A film another list points to, as far as the library has it: More like this, a collection. */
export interface FilmLink {
  item: TmdbTrending;
  poster: string;
  /** How many copies the library holds; 0 for a film it lacks. */
  copies: number;
}

/** What a film's own page shows (TV-27). */
export interface FilmPage {
  /** What the page is opened by: a TMDB id ("603"), or a library stream when TMDB knows no film for it ("s2169856"). */
  ref: string;
  /** The TMDB id, or 0 for a page made from the library alone. */
  id: number;
  title: string;
  year: string;
  /** Minutes, or 0. */
  runtime: number;
  genres: string[];
  /** The age rating to show ("12", "16"), or ''. */
  rating: string;
  /** TMDB's score out of 10, or null. */
  vote: number | null;
  overview: string;
  poster: string;
  backdrop: string;
  /** In the order Play tries them: the person's languages, the best picture, cinema recordings last. */
  copies: FilmCopy[];
  /** The series it belongs to (TV-30), or null. */
  collection: { id: number; name: string; poster: string } | null;
  /** TMDB's recommendations, not yet kept to the library: see `moreLikeThis`. */
  recommendations: TmdbTrending[];
  /** Its trailers, the one to open first (TV-33); none for a page without TMDB. */
  trailers: TmdbTrailer[];
  /** TMDB did not answer: the page was made from what the library and the list knew (TV-34). */
  detailsFailed: boolean;
}

/** A film as For You's billboard shows it (NX-TV-1). */
export interface FilmFeature {
  backdrop: string;
  overview: string;
  year: string;
  runtime: number;
  genres: string[];
  rating: string;
  vote: number | null;
  /** A show's seasons; absent for a film. */
  seasons?: number;
}

/** A collection's page (TV-30): its films in order, the ones the library lacks included. */
export interface CollectionPage {
  id: number;
  name: string;
  backdrop: string;
  parts: FilmLink[];
}

/** What a list hands over when it opens a film, to fall back on. */
export interface FilmKnown {
  title?: string;
  originalTitle?: string;
  year?: string;
  poster?: string;
  /** The library name of the stream a page is opened from ("EN - Hope (2026)"). */
  name?: string;
}

/** How long a film's page is kept for its copies page and a return to it. */
const PAGE_KEEP_MS = 5 * 60 * 1000;


/** "More like this" is shown only when at least this many are in the library (TV-27). */
export const MORE_LIKE_THIS_MIN = 3;

/**
 * A film's own page (round 6, TV-27), the choice of copy (TV-28), More like
 * this and collections (TV-30).
 *
 * The details come from TMDB, in the description language; the copies from
 * what this device's catalogue already holds, found as Popular finds them.
 * A film card in the library opens its page by stream: its TMDB id is found
 * as its description finds it, and when there is none, the page is made
 * from the library alone. When TMDB does not answer, a title known from the
 * list it was opened from still finds its copies, so Play stays reachable.
 */
@Injectable({ providedIn: 'root' })
export class FilmService {
  private readonly choices = inject(CopyChoicesService);
  private readonly copyFallback = inject(CopyFallbackService);
  private readonly ages = inject(AgeLockService);
  private readonly tmdb = inject(TmdbService);
  private readonly popular = inject(PopularService);
  private readonly xtream = inject(XtreamService);
  private readonly descriptions = inject(DescriptionsService);

  private readonly pages = new Map<string, { at: number; page: Promise<FilmPage> }>();

  /** The page for a ref -- a TMDB id, or "s" and a stream id -- with what the opening list knew. */
  open(ref: string, known: FilmKnown = {}): Promise<FilmPage> {
    const held = this.pages.get(ref);
    if (held && Date.now() - held.at < PAGE_KEEP_MS) {
      return held.page;
    }
    const page = ref.startsWith('s') ? this.byStream(ref.slice(1), known) : this.build(Number(ref), known);
    this.pages.set(ref, { at: Date.now(), page });
    // A failure is asked again next time, not kept.
    page.catch(() => this.pages.delete(ref));
    return page;
  }

  /** Forgets a kept page, so the next `open` looks for its copies again. */
  forget(ref: string): void {
    this.pages.delete(ref);
  }

  /** A library film's page: TMDB's, when its id can be found; otherwise the library's own. */
  private async byStream(streamId: string, known: FilmKnown): Promise<FilmPage> {
    const found = await this.descriptions.filmTmdbId(streamId, known.name ?? '').catch(() => ({ id: null, plot: '', name: known.name ?? '' }));
    // Opened by its address, the page knew no name; the provider's details do.
    const name = known.name || found.name;
    if (found.id) {
      const page = await this.build(found.id, known).catch(() => null);
      if (page && page.copies.some(copy => String(copy.stream.stream_id) === streamId)) {
        return { ...page, ref: `s${streamId}` };
      }
    }
    // No TMDB film for it, or one the library's copy does not match: the
    // page is the library's -- the provider's words, poster and name.
    const own = posterTitle(name);
    const title = plainTitle(own.title) || own.title;
    const streams = await this.popular.copiesOf({ title, originalTitle: title, year: own.year }, 'vod');
    const self = { stream_id: streamId, name, stream_icon: known.poster ?? '' } as unknown as Stream;
    const all = streams.some(stream => String(stream.stream_id) === streamId) ? streams : [self, ...streams];
    return {
      ref: `s${streamId}`,
      id: 0,
      title: title || name,
      year: own.year,
      runtime: 0,
      genres: [],
      rating: '',
      vote: null,
      overview: found.plot,
      poster: known.poster ?? '',
      backdrop: '',
      copies: await this.described(all),
      collection: null,
      recommendations: [],
      trailers: [],
      detailsFailed: false
    };
  }

  private async build(id: number, known: FilmKnown): Promise<FilmPage> {
    let details: TmdbFilm | null = null;
    let failure: unknown = null;
    try {
      details = await this.details(id);
    } catch (error) {
      failure = error;
    }
    const base = details ?? (known.title ? { title: known.title, originalTitle: known.originalTitle ?? known.title, year: known.year ?? '', overview: '' } : null);
    if (!base) {
      throw failure ?? new Error(`TMDB has no film ${id}`);
    }
    const copies = await this.described(await this.popular.copiesOf(base, 'vod'));
    return {
      ref: String(id),
      id,
      title: base.title,
      year: base.year,
      runtime: details?.runtime ?? 0,
      genres: details?.genres ?? [],
      rating: details ? lockRating(details.certifications, this.ages.lock().country) : '',
      vote: details?.vote ?? null,
      overview: base.overview,
      poster: tmdbPoster(details?.poster ?? known.poster ?? '') || copies[0]?.stream.stream_icon || '',
      backdrop: tmdbBackdrop(details?.backdrop ?? ''),
      copies,
      collection: details?.collection ? { id: details.collection.id, name: details.collection.name, poster: tmdbPoster(details.collection.poster) } : null,
      recommendations: details?.recommendations ?? [],
      trailers: orderTrailers(details?.trailers ?? [], trailerLanguages()).slice(0, TRAILERS_OFFERED),
      detailsFailed: !details
    };
  }

  /** Copies with their category, language and picture, in the order Play tries them; a show's too (TV-29). */
  async described(streams: Stream[], type: 'vod' | 'series' = 'vod'): Promise<FilmCopy[]> {
    const names = await categoryNames(this.xtream);
    const display = languageNames();
    return orderCopies(
      streams.map(stream => {
        const category = names[type].get(String(stream.category_id)) ?? '';
        const language = copyLanguage(stream.name, category);
        return {
          stream,
          category,
          language,
          languageName: language ? display(language) : '',
          quality: copyQualityLabel(stream.name, category),
          cinema: isCinemaRecording(stream.name, category)
        };
      }),
      preferredLanguages(),
      copy => ({ name: copy.stream.name, category: copy.category })
    );
  }

  /** TMDB's recommendations for a film, kept to the ones the library has, in TMDB's order. */
  async moreLikeThis(page: FilmPage, signal?: AbortSignal): Promise<FilmLink[]> {
    return (await this.linked(page.recommendations, 'vod', signal)).filter(link => link.copies > 0);
  }

  /** A film series in order, with the films the library lacks kept, so a gap shows (TV-30). */
  async collection(id: number, signal?: AbortSignal): Promise<CollectionPage | null> {
    const client = await this.tmdb.client();
    if (!client) {
      return null;
    }
    const raw = await client.collection(id, this.language());
    if (!raw) {
      return null;
    }
    return { id: raw.id, name: raw.name, backdrop: tmdbBackdrop(raw.backdrop), parts: await this.linked(raw.parts, 'vod', signal) };
  }

  /** `signal`: the page asking has been left, so the reads not yet made are not made (Catalogue.findTitles). */
  async linked(items: TmdbTrending[], type: 'vod' | 'series' = 'vod', signal?: AbortSignal): Promise<FilmLink[]> {
    const copies = await this.popular.copiesIn(type, items, signal);
    return items.map(item => ({ item, poster: tmdbPoster(item.poster), copies: copies.get(item.id)?.length ?? 0 }));
  }

  /** The copy Play uses: the one chosen for this film, while the library still has it, else the first. */
  playCopy(page: FilmPage): FilmCopy | undefined {
    const chosen = this.chosen(page.ref);
    // A copy chosen by hand stays the choice; otherwise one that has not just failed here.
    return page.copies.find(copy => String(copy.stream.stream_id) === chosen) ?? this.copyFallback.inPlayOrder(page.copies)[0];
  }

  /** Whether a copy was chosen by hand for this film. */
  chosen(ref: string | number): string | null {
    return this.choices.chosen('films', ref);
  }

  /** Kept for the account, so another device plays the same copy (TV-28). */
  choose(ref: string | number, streamId: string | number): void {
    this.choices.choose('films', ref, streamId);
  }


  private language(): string {
    const chosen = this.descriptions.language();
    return tmdbLanguage(chosen === 'provider' ? 'en' : chosen);
  }

  private readonly features = new Map<string, Promise<FilmFeature | null>>();

  /**
   * What For You's billboard shows of a library film (NX-TV-1): its backdrop
   * and words from TMDB, found by the name the catalogue shows -- For You
   * asks the provider nothing, so not its details either. Lighter than
   * `open` -- the copies are not looked for -- and kept for the session.
   */
  feature(streamId: string, name: string): Promise<FilmFeature | null> {
    const held = this.features.get(streamId);
    if (held) {
      return held;
    }
    const found = (async () => {
      const id = await this.descriptions.filmTmdbIdByName(name).catch(() => null);
      const details = id ? await this.details(id).catch(() => null) : null;
      if (!details) {
        return null;
      }
      return {
        backdrop: tmdbBackdrop(details.backdrop ?? ''),
        overview: details.overview,
        year: details.year,
        runtime: details.runtime ?? 0,
        genres: details.genres ?? [],
        rating: lockRating(details.certifications, this.ages.lock().country),
        vote: details.vote ?? null
      };
    })();
    this.features.set(streamId, found);
    found.then(
      feature => feature || this.features.delete(streamId),
      () => this.features.delete(streamId)
    );
    return found;
  }

  /** TMDB's details in the description language, its overview in English where that one is empty. */
  private async details(id: number): Promise<TmdbFilm | null> {
    const client: TmdbClient | null = await this.tmdb.client();
    if (!client) {
      return null;
    }
    const language = this.language();
    const film = await client.film(id, language, videoLanguages(trailerLanguages()));
    if (film && !film.overview && language !== 'en-US') {
      const english = await client.film(id, 'en-US').catch(() => null);
      return { ...film, overview: english?.overview ?? '' };
    }
    return film;
  }
}


/** Language codes as words, in the app's language, first letter up: "Hrvatski", "Arabic". */
function languageNames(): (code: string) => string {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale()], { type: 'language' });
  } catch {
    names = null;
  }
  return code => {
    const name = names?.of(code) ?? code.toUpperCase();
    return name.charAt(0).toLocaleUpperCase(locale()) + name.slice(1);
  };
}

/** How many trailers a page offers: TMDB lists a dozen for a big film, most of them adverts for one cinema. */
export const TRAILERS_OFFERED = 4;

/** The languages a trailer is wanted in, first first: the app's, then English. */
export const trailerLanguages = (): string[] => preferredLanguages();
