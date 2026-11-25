import { Injectable, inject } from '@angular/core';
import { Stream } from '@shared/types';
import { TmdbKind, TmdbList, TmdbTrending } from '@shared/tmdb/client';
import { versionsOf } from '@shared/tmdb/popular';
import { TmdbService } from './tmdb.service';
import { XtreamService } from './xtream.service';
import { posterTitle } from '../utils/series-display.utils';

/** A trending film or show this library has, with every copy of it. */
export interface Popular {
  item: TmdbTrending;
  type: 'vod' | 'series';
  versions: Stream[];
  /** Its place on TMDB's list for its kind, from 0: what mixes films and shows into one row. */
  rank: number;
}

/** One page of TMDB's list, as far as this library has it: how many titles were on it, and how many pages there are. */
export interface PopularPage {
  found: Popular[];
  checked: number;
  pages: number;
  /**
   * Matched against a library this device does not hold whole yet (it could
   * not be downloaded just now): what was found is real, but "none" is not
   * believable, and the page is never kept.
   */
  incomplete?: boolean;
}

/** How far down TMDB's list a full list goes: the first 500, past which matches get rare and slow (TV-26). */
export const LIST_PAGES = 25;

/** The week's lists, a page at a time, as TMDB gave them. */
interface Held {
  at: number;
  pages: number;
  lists: Record<number, TmdbTrending[]>;
}

/** Where a list's first pages are kept: the week's trending where it always was. */
const keptKey = (kind: TmdbKind, list: TmdbList) => (list === 'trending' ? `xtream_tmdb_trending_${kind}` : `xtream_tmdb_list_${list}_${kind}`);
const KEEP_MS = 24 * 60 * 60 * 1000;
/** One page of one list: 'movie:top:1'. */
const pageKey = (kind: TmdbKind, list: TmdbList, page: number) => `${kind}:${list}:${page}`;

/**
 * For You's row as last worked out, and whose library it was found in.
 *
 * Working it out looks every title up in the library, two names each, sixty
 * titles: over a minute on a user's TV, and For You did it on every visit
 * (21 October). Now once a day; meanwhile the last row is shown at once.
 */
const ROW_KEY = 'xtream_popular_row';

interface Row {
  at: number;
  library: string;
  /** The film and show libraries it was matched against (rowLibraries); a row without it is from before 25 November. */
  libraryAt?: string;
  limit: number;
  found: Popular[];
}

/**
 * Pages of TMDB's lists as matched against the library, and whose library.
 *
 * For You's row was kept (ROW_KEY) but nothing else was: Movies and TV Shows
 * worked out their Top rated and genre rows again on every visit, and showed
 * nothing until they had (26 October). Each matched page is now
 * kept for the day, the most recently used few on the device: enough for
 * the six rows of each library's front page and For You's (14 November).
 */
const PAGES_KEY = 'xtream_popular_pages';
const PAGES_ON_DEVICE = 40;

interface KeptPage {
  key: string;
  at: number;
  library: string;
  /** When the library it was matched against was downloaded (XtreamService.libraryAt); one without it was not matched against the library held whole, and is never used. */
  libraryAt?: string;
  page: PopularPage;
}

/** Where the library's genre counts are kept (DiscoverService.countGenres). */
export const countsKey = (kind: TmdbKind) => `xtream_tmdb_genre_counts_${kind}`;

/**
 * Set once the answers older versions worked out are gone. 1.0.130 matched
 * TMDB's lists against a library not downloaded yet and kept "none of it is
 * here" for a day, the genre counts for a week (24 November). Those carry no
 * library time, so nothing would use them now anyway; this frees the space.
 */
const DISCARDED_KEY = 'xtream_library_answers_discarded_v1';

export function discardAnswersFromBefore(): void {
  try {
    if (localStorage.getItem(DISCARDED_KEY)) {
      return;
    }
    for (const key of [ROW_KEY, PAGES_KEY, countsKey('movie'), countsKey('tv')]) {
      localStorage.removeItem(key);
    }
    localStorage.setItem(DISCARDED_KEY, '1');
  } catch {
    // Storage unavailable: nothing kept to discard.
  }
}

/** The names a title is looked for by: English, and its own where that differs. */
const namesOf = (item: Pick<TmdbTrending, 'title' | 'originalTitle'>): string[] =>
  [...new Set([item.title, item.originalTitle].filter(Boolean))];

/** How old a kept list may be and still stand in when TMDB does not answer (TV-34). */
const STALE_MS = 7 * KEEP_MS;

/**
 * The pages kept on the device, so a day's launches ask TMDB once for For
 * You's rows. Pages further down, which only "Show more" reaches, are kept
 * for this launch.
 */
const KEPT_PAGES = 3;

/**
 * "Popular now" for For You: what is trending on TMDB
 * this week, films and shows apart, as far as this library has them.
 *
 * TMDB's list comes a page of twenty at a time, once a day. Each title is
 * then looked for in what this device's catalogue holds, and kept only if
 * some copy of it is there. A library never held whole is downloaded first,
 * once, as a search would: matched against only the categories opened so far,
 * a new device's Top rated said none of it was in the library, and kept
 * saying so for the day (24 November). Titles are in English, which is what most providers name
 * their films in; a film a provider names in its own language is found by
 * its original title.
 */
@Injectable({ providedIn: 'root' })
export class PopularService {
  private readonly tmdb = inject(TmdbService);
  private readonly xtream = inject(XtreamService);
  private readonly held = new Map<string, Held>();
  private row: Row | null = null;
  /** Every page matched this launch; the device keeps the first few of each list (PAGES_KEY). */
  private readonly matched = new Map<string, KeptPage>();
  private keptPages: KeptPage[] | null = null;

  constructor() {
    discardAnswersFromBefore();
  }

  /** When this kind's library was last downloaded whole; null while it is not held whole. */
  libraryAt(kind: TmdbKind): Promise<string | null> {
    return this.xtream.libraryAt(kind === 'movie' ? 'vod' : 'series');
  }

  /** Both libraries' download times, which For You's row was matched against; null unless both are held whole. */
  private async rowLibraries(): Promise<string | null> {
    const [films, shows] = [await this.libraryAt('movie'), await this.libraryAt('tv')];
    return films && shows ? `${films}|${shows}` : null;
  }

  /**
   * For You's row: the first this library has, most popular first, from the
   * first few pages. Empty without a TMDB key, or when TMDB does not answer.
   */
  async popular(kind: TmdbKind, limit = 12, list: TmdbList = 'trending'): Promise<Popular[]> {
    return this.firstFound(kind, limit, list, page => this.page(kind, page, list));
  }

  /**
   * The same row as last matched, however old, to show while `popular` works
   * out today's; null when this device has not matched it before.
   */
  async lastPopular(kind: TmdbKind, limit = 12, list: TmdbList = 'trending'): Promise<Popular[] | null> {
    const library = await this.xtream.libraryOwner();
    if (!this.keptPage(library, kind, list, 1)) {
      return null;
    }
    return this.firstFound(kind, limit, list, async page => {
      const kept = this.keptPage(library, kind, list, page);
      if (!kept) {
        throw new Error('not kept');
      }
      return kept;
    });
  }

  private async firstFound(kind: TmdbKind, limit: number, list: TmdbList, pageOf: (page: number) => Promise<PopularPage>): Promise<Popular[]> {
    const found: Popular[] = [];
    try {
      for (let page = 1; page <= KEPT_PAGES && found.length < limit; page++) {
        const one = await pageOf(page);
        found.push(...one.found.filter(entry => !found.some(had => had.item.id === entry.item.id)));
        if (page >= one.pages) {
          break;
        }
      }
    } catch {
      // TMDB not answering, or the key refused: the row keeps to what it found.
    }
    return found.slice(0, limit);
  }

  /**
   * For You's one row (FY-TV-2): films and shows mixed, ten of them, each
   * by its place on its own list -- TMDB scores films far above shows, so
   * its score would leave a row of films.
   */
  async mixed(limit = 10): Promise<Popular[]> {
    const library = await this.xtream.libraryOwner();
    // Kept, before anything is read from the database: a read waits its
    // turn behind a library download's writes (card 35, 25 November).
    const last = this.lastRow(library, limit);
    if (last && Date.now() - last.at < KEEP_MS) {
      return this.stillAllowed(last.found);
    }
    const [films, shows] = [await this.popular('movie', limit), await this.popular('tv', limit)];
    const found = [...films, ...shows].sort((a, b) => a.rank - b.rank || (a.type === 'vod' ? -1 : 1)).slice(0, limit);
    // Read again: either library may have arrived while it was matched.
    const matchedIn = await this.rowLibraries();
    if (found.length && matchedIn) {
      this.keepRow({ at: Date.now(), library, libraryAt: matchedIn, limit, found });
    }
    return found;
  }

  /** The row as last worked out, however old, to show while `mixed` works out a new one; null if none. */
  async lastMixed(limit = 10): Promise<Popular[] | null> {
    const last = this.lastRow(await this.xtream.libraryOwner(), limit);
    return last ? this.stillAllowed(last.found) : null;
  }

  /** A kept row's copies the parental lock still lets through, as it may have changed since. */
  private stillAllowed(found: Popular[]): Popular[] {
    return found
      .map(entry => ({ ...entry, versions: entry.versions.filter(stream => this.xtream.allowed(entry.type, stream)) }))
      .filter(entry => entry.versions.length > 0);
  }

  private lastRow(library: string, limit: number): Row | null {
    if (!this.row) {
      try {
        const kept = JSON.parse(localStorage.getItem(ROW_KEY) ?? 'null') as Row | null;
        this.row = kept && typeof kept.at === 'number' && Array.isArray(kept.found) ? kept : null;
      } catch {
        this.row = null;
      }
    }
    // A row matched without both libraries whole is never shown again, however recent.
    return this.row && this.row.libraryAt && this.row.library === library && this.row.limit === limit ? this.row : null;
  }

  private keepRow(row: Row): void {
    this.row = row;
    try {
      localStorage.setItem(ROW_KEY, JSON.stringify(row));
    } catch {
      // Storage full or unavailable: kept for this launch.
    }
  }

  /**
   * One page of the week's list, as far as this library has it. Throws when
   * TMDB does not answer, so a page asked for on purpose can say so; pages
   * 0 when there is no key at all. Matched once a day; `remember` false for a
   * count (DiscoverService.countGenres) that should not push rows off the
   * device.
   */
  async page(kind: TmdbKind, page: number, which: TmdbList = 'trending', remember = true): Promise<PopularPage> {
    const library = await this.xtream.libraryOwner();
    // Kept, before anything is read from the database: Movies and Back
    // waited behind a library download's writes for pages already matched (card 35).
    const kept = this.keptPage(library, kind, which, page, KEEP_MS);
    if (kept) {
      return kept;
    }
    let libraryAt = await this.libraryAt(kind);
    const list = await this.listPage(kind, which, page);
    if (!list) {
      return { found: [], checked: 0, pages: 0 };
    }
    const type = kind === 'movie' ? 'vod' : 'series';
    if (!libraryAt && (await this.xtream.fetchLibraryIfNeverHeld(type))) {
      libraryAt = await this.libraryAt(kind);
    }
    // The whole page in one lookup (XtreamService.findHeldTitles): a search
    // per name was over a minute for For You's row on a user's TV.
    const held = await this.copiesIn(type, list.items);
    const found: Popular[] = [];
    for (const [index, item] of list.items.entries()) {
      const versions = held.get(item.id) ?? [];
      if (versions.length) {
        found.push({ item, type, versions, rank: (page - 1) * 20 + index });
      }
    }
    const matched: PopularPage = { found, checked: list.items.length, pages: list.pages, ...(libraryAt ? {} : { incomplete: true }) };
    if (remember && libraryAt) {
      this.keepPage({ key: pageKey(kind, which, page), at: Date.now(), library, libraryAt, page: matched });
    }
    return matched;
  }

  /**
   * Every copy of each of these films or shows the library holds, by TMDB id,
   * in one lookup -- "More like this" and a film series asked once per title,
   * which is what made Popular take over a minute before it stopped.
   */
  async copiesIn(type: 'vod' | 'series', items: readonly TmdbTrending[]): Promise<Map<number, Stream[]>> {
    const held = await this.xtream.findHeldTitles(type, items.flatMap(item => namesOf(item)));
    const copies = new Map<number, Stream[]>();
    for (const item of items) {
      const streams = new Map<string, Stream>();
      for (const name of namesOf(item)) {
        for (const stream of held.get(name) ?? []) {
          streams.set(String(stream.stream_id), stream);
        }
      }
      copies.set(item.id, this.versionsIn(item, [...streams.values()]));
    }
    return copies;
  }

  /**
   * A page matched before for this library, with what the parental lock
   * still lets through. Only one matched against the library held whole,
   * no older than `maxAge`. A later download does not make it stale: that
   * made every page match again after the daily refresh, and Back to Movies
   * waited for all of them (card 35, 25 November).
   */
  private keptPage(library: string, kind: TmdbKind, list: TmdbList, page: number, maxAge = Infinity): PopularPage | null {
    const key = pageKey(kind, list, page);
    const kept = this.matched.get(key) ?? this.onDevice().find(entry => entry.key === key);
    if (!kept?.libraryAt || kept.library !== library) {
      return null;
    }
    if (Date.now() - kept.at >= maxAge) {
      return null;
    }
    return { ...kept.page, found: this.stillAllowed(kept.page.found) };
  }

  private keepPage(kept: KeptPage): void {
    this.matched.set(kept.key, kept);
    if (Number(kept.key.split(':').pop()) > KEPT_PAGES) {
      return;
    }
    const pages = [kept, ...this.onDevice().filter(entry => entry.key !== kept.key)].slice(0, PAGES_ON_DEVICE);
    this.keptPages = pages;
    try {
      localStorage.setItem(PAGES_KEY, JSON.stringify(pages));
    } catch {
      // Storage full or unavailable: kept for this launch.
    }
  }

  private onDevice(): KeptPage[] {
    if (!this.keptPages) {
      try {
        const kept = JSON.parse(localStorage.getItem(PAGES_KEY) ?? '[]') as KeptPage[];
        this.keptPages = Array.isArray(kept) ? kept.filter(entry => entry && typeof entry.key === 'string' && entry.page) : [];
      } catch {
        this.keptPages = [];
      }
    }
    return this.keptPages;
  }

  /** Every copy of a film or show this library holds: also what a film's own page offers (TV-28). */
  async copiesOf(item: Pick<TmdbTrending, 'title' | 'originalTitle' | 'year'>, type: 'vod' | 'series'): Promise<Stream[]> {
    const found = new Map<string, Stream>();
    for (const name of namesOf(item)) {
      // Deep enough for a name with history: Resident Evil is fifty copies of eight films.
      for (const stream of await this.xtream.findHeld(type, name, 100)) {
        found.set(String(stream.stream_id), stream);
      }
    }
    return this.versionsIn(item, [...found.values()]);
  }

  /** Which of these streams are copies of the title: its name, and its year where both say one. */
  private versionsIn(item: Pick<TmdbTrending, 'title' | 'originalTitle' | 'year'>, streams: Stream[]): Stream[] {
    return versionsOf(item, streams, stream => {
      const own = posterTitle(stream.name);
      return { title: own.title, year: own.year ? Number(own.year) : null };
    });
  }

  /** A page of one of TMDB's lists of films or shows: from TMDB at most once a day; null without a key. */
  private async listPage(kind: TmdbKind, list: TmdbList, page: number): Promise<{ items: TmdbTrending[]; pages: number } | null> {
    const kept = this.held.get(`${kind}:${list}`) ?? this.kept(kind, list);
    let held = kept && Date.now() - kept.at < KEEP_MS ? kept : null;
    if (held?.lists[page]) {
      return { items: held.lists[page], pages: held.pages };
    }
    const client = await this.tmdb.client();
    if (!client) {
      return null;
    }
    let fetched: { items: TmdbTrending[]; pages: number };
    try {
      fetched = await client.list(kind, list, 'en-US', page);
    } catch (error) {
      // Last week's list stands in while TMDB is away, so For You keeps its row.
      if (kept?.lists[page] && Date.now() - kept.at < STALE_MS) {
        return { items: kept.lists[page], pages: kept.pages };
      }
      throw error;
    }
    // Overviews are not shown here, and are most of the size.
    const items = fetched.items.map(item => ({ ...item, overview: '' }));
    held = { at: held?.at ?? Date.now(), pages: fetched.pages, lists: { ...held?.lists, [page]: items } };
    this.held.set(`${kind}:${list}`, held);
    this.keep(kind, list, held);
    return { items, pages: held.pages };
  }

  private kept(kind: TmdbKind, list: TmdbList): Held | null {
    try {
      // Where a single mixed list was kept before films and shows were apart.
      localStorage.removeItem('xtream_tmdb_trending');
      const held = JSON.parse(localStorage.getItem(keptKey(kind, list)) ?? 'null') as Held | null;
      return held && typeof held.at === 'number' && held.lists && typeof held.lists === 'object' ? held : null;
    } catch {
      return null;
    }
  }

  private keep(kind: TmdbKind, list: TmdbList, held: Held): void {
    const lists: Record<number, TmdbTrending[]> = {};
    for (let page = 1; page <= KEPT_PAGES; page++) {
      if (held.lists[page]) {
        lists[page] = held.lists[page];
      }
    }
    try {
      localStorage.setItem(keptKey(kind, list), JSON.stringify({ ...held, lists }));
    } catch {
      // Storage unavailable: asked again next launch.
    }
  }
}
