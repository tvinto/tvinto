import { connectionsAllowedFrom, connectionsKey } from '@shared/recording/recording';
import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AccountService } from './account.service';
import { SettingsService } from './settings.service';
import { API_URL, hasServer } from './api-url';
import { DirectProvider, ProviderAccessService } from './provider-access.service';
import { ALL_CHANNELS_ID, tagged, untagged } from '@shared/providers/providerRecord';
import { tagStream } from '@shared/providers/mergedCatalogue';
import { t } from '../utils/i18n';
import { GuideByStream, LooseProgramme } from '../utils/guide.utils';
import { EMPTY, Observable, concat, defer, firstValueFrom, from, of } from 'rxjs';
import { catchError, filter, map, switchMap, tap } from 'rxjs/operators';
import { SeriesInfoCache } from './native/seriesInfoCache';
import {
  categoryScope,
  readSortChoice,
  sortCategories,
  sortStreams,
  sortToUse,
  streamScope
} from '@shared/xtream/ordering';
import {
  GuideChannelIndex,
  MatchedChannel,
  chooseTwin,
  guideTwins,
  indexGuideChannels,
  normaliseChannelId,
  programmesByStream,
  streamsByGuideChannel
} from '@shared/xtream/guideMatching';
import { GuideService } from './guide.service';
import { noteShowTitles } from '../utils/held-titles';
import { KnownChannel } from '@shared/xtream/guide';
import { GUIDE_SEARCH_AHEAD_MS, GUIDE_SEARCH_LIMIT, GuideFind, linkGuideHits } from '../utils/guide-search.utils';
import { GuideSourcesService } from './guide-sources.service';
import { ServiceKindService } from './service-kind.service';
import { LocalUserDataService } from './local-user-data.service';
import { NativePlayerService } from './native-player.service';
import { ParentalLockService } from './parental-lock.service';
import { ProviderSlot } from './routed-client';
import { DownloadedFile, GuideDownloadPlugin, downloadedFileAddress, downloadedFileBytes, guideDownloadPlugin } from './native/guideDownload';
import {
  FileCategory,
  LibraryFileUnreadable,
  LibraryWorkerUnavailable,
  readLibraryHere,
  workerLibraryFileReader,
  workerLibraryReader
} from '@shared/xtream/libraryWorker';
import { ProviderClock, providerClockFrom, providerClockTime } from '@shared/xtream/catchUp';
import { saysNothing } from '../utils/progress.utils';
import {
  CATEGORY_SORTS,
  Category,
  CategorySort,
  EPGListing,
  RECENT_LIMIT,
  STREAM_SORTS,
  SeriesInfo,
  Stream,
  StreamSort,
  StreamType,
  SETTING_KEYS,
  SettingKey,
  WatchProgress,
  WatchProgressInput
} from '@shared/types';


/**
 * The provider's clock, as last read, and whose it was. Localstorage, like the
 * credentials it belongs with; the username only to notice a change of line.
 */
const PROVIDER_CLOCK_KEY = 'xtream_provider_clock';

/** How long a provider's clock is trusted before signing in again to read it: it changes twice a year. */
const PROVIDER_CLOCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredProviderClock {
  providerUsername: string;
  clock: ProviderClock | null;
  at: number;
}

/** How far back a guide read reaches unless asked for more: the programme already running. */
const GUIDE_BACK_MS = 60 * 60 * 1000;

/** What a series that could not be loaded looks like, so a view has fields. */
const EMPTY_SERIES: SeriesInfo = {
  id: '',
  name: '',
  plot: '',
  cast: '',
  director: '',
  genre: '',
  releaseDate: '',
  last_modified: '',
  rating: 0,
  rating_5based: 0,
  backdrop_path: [],
  youtube_trailer: '',
  episode_run_time: '',
  category_id: ''
};

@Injectable({
  providedIn: 'root'
})
export class XtreamService {
  // Read at each use: a server chosen at sign-in takes effect without a restart.
  private readonly syncServer = inject(API_URL);
  private get apiUrl(): string {
    return this.syncServer();
  }

  private readonly accounts = inject(AccountService);
  private readonly settings = inject(SettingsService);
  private readonly provider = inject(ProviderAccessService);
  private readonly guide = inject(GuideService);
  private readonly serviceKind = inject(ServiceKindService);
  private readonly guideSources = inject(GuideSourcesService);
  private readonly local = inject(LocalUserDataService);
  private readonly nativePlayer = inject(NativePlayerService);
  private readonly lock = inject(ParentalLockService);
  private readonly seriesCache = new SeriesInfoCache();

  /** The library being indexed for search right now, for the screen to say so. */
  readonly indexing = signal<StreamType | null>(null);

  /**
   * How far that index has got: categories written, of how many (null until
   * that is known). Null while the library is still downloading, which is one
   * request whose length nobody says.
   */
  readonly indexProgress = signal<{ filed: number; total: number | null } | null>(null);

  constructor(private http: HttpClient) {}

  /**
   * Runs a request the device's own way when it can, and the backend's way
   * otherwise.
   *
   * Both arms are given, always. This is not a migration with the old path left
   * behind to be deleted: a browser cannot reach an HTTP-only provider and
   * never will be able to, so the backend arm is the permanent answer for one
   * of the four screens this app is for.
   *
   * A failure on the device arm falls back rather than surfacing. The most
   * likely cause is the provider being unreachable from this network, and the
   * backend may well be somewhere it is reachable from.
   */
  private eitherWay<T>(
    onDevice: (direct: DirectProvider) => Promise<T>,
    viaBackend: () => Observable<T>
  ): Observable<T> {
    if (!this.provider.supported) {
      return viaBackend();
    }

    return defer(() => this.provider.direct()).pipe(
      switchMap(direct => {
        if (!direct) {
          return viaBackend();
        }
        return from(onDevice(direct)).pipe(
          catchError(error => {
            console.warn('Direct provider request failed; trying the backend', error);
            return viaBackend();
          })
        );
      })
    );
  }

  /**
   * The arrangement for a list, when one is needed to sort by.
   *
   * Still the backend's to answer: an arrangement belongs to the account, not
   * to the subscription, and nothing keeps a device-local copy yet. Failing
   * quietly to an empty arrangement is right -- sortStreams and sortCategories
   * both fall back to name order, which is wrong but readable, rather than
   * leaving the list in whatever order the provider happened to send.
   */
  private arrangementFor(
    kind: 'category' | 'stream',
    type: StreamType,
    categoryId?: string
  ): Promise<string[]> {
    return firstValueFrom(
      this.getManualOrder(kind, type, categoryId).pipe(catchError(() => of([] as string[])))
    );
  }

  /**
   * The session token, which AccountService owns.
   *
   * Kept as a method here because plenty of call sites ask this service; two
   * copies of who you are would be two things to get out of step.
   */
  getSessionToken(): string | null {
    return this.accounts.getToken();
  }

  /** Whether there is a session to make requests with. */
  isAuthenticated(): boolean {
    return this.accounts.hasAccess();
  }

  /**
   * How lists are ordered, which is a preference of the account rather than of
   * this browser -- arrange your categories on the laptop and the phone should
   * open the same way.
   *
   * An unrecognised stored value falls back to the default rather than being
   * sent to the backend, which would answer with its own default anyway and
   * make the setting look like it had silently stopped working.
   */
  getCategorySort(): CategorySort {
    const stored = this.settings.get(SETTING_KEYS.categorySort) as CategorySort | null;
    return stored && CATEGORY_SORTS.includes(stored) ? stored : 'name_asc';
  }

  setCategorySort(sort: CategorySort) {
    const at = new Date().toISOString();
    this.settings.set(SETTING_KEYS.categorySort, sort);
    this.settings.set(SETTING_KEYS.categorySortAt, at);
    this.chooseForThem(SETTING_KEYS.setUpCategorySort, sort, at);
  }

  getStreamSort(): StreamSort {
    const stored = this.settings.get(SETTING_KEYS.streamSort) as StreamSort | null;
    return stored && STREAM_SORTS.includes(stored) ? stored : 'name_asc';
  }

  setStreamSort(sort: StreamSort) {
    const at = new Date().toISOString();
    this.settings.set(SETTING_KEYS.streamSort, sort);
    this.settings.set(SETTING_KEYS.streamSortAt, at);
    this.chooseForThem(SETTING_KEYS.setUpStreamSort, sort, at);
  }

  /**
   * In somebody's setup, a sort is chosen for them: it goes to their account
   * on Save, as well as being this setup's own, or it would never leave the
   * admin's desktop (sortToUse).
   */
  private chooseForThem(key: SettingKey, sort: string, at: string): void {
    if (this.accounts.profileScope() === 'setup') {
      this.settings.set(key, JSON.stringify({ sort, at }));
    }
  }

  /**
   * The sort a type's categories are drawn with here: this device's choice, or
   * the account's arrangement or a sort chosen in its setup when that is the
   * newer decision (sortToUse).
   * Only on a device that keeps the account's work; a browser asks the
   * backend, which sorts by the choice it is sent.
   */
  categorySortFor(type: StreamType): CategorySort {
    if (!this.local.enabled) {
      return this.getCategorySort();
    }
    const stored = this.settings.get(SETTING_KEYS.categorySort) as CategorySort | null;
    return sortToUse<CategorySort>(
      { sort: stored && CATEGORY_SORTS.includes(stored) ? stored : null, at: this.settings.get(SETTING_KEYS.categorySortAt) },
      this.local.arrangedAt(categoryScope(type)),
      'name_asc',
      readSortChoice(this.settings.get(SETTING_KEYS.setUpCategorySort), CATEGORY_SORTS)
    );
  }

  /** The same for one category's channels, films or shows. */
  streamSortFor(type: StreamType, categoryId: string): StreamSort {
    if (!this.local.enabled) {
      return this.getStreamSort();
    }
    const stored = this.settings.get(SETTING_KEYS.streamSort) as StreamSort | null;
    return sortToUse<StreamSort>(
      { sort: stored && STREAM_SORTS.includes(stored) ? stored : null, at: this.settings.get(SETTING_KEYS.streamSortAt) },
      this.local.arrangedAt(streamScope(type, categoryId)),
      'name_asc',
      readSortChoice(this.settings.get(SETTING_KEYS.setUpStreamSort), STREAM_SORTS)
    );
  }

  /**
   * Reads and writes of the account's own work.
   *
   * On a device these go to the local copy, which is the truth the screen is
   * drawn from; the change feed carries them to the server afterwards. In a
   * browser they go straight to the server, as they always have.
   *
   * Synchronous underneath, and still an Observable, because every call site
   * subscribes -- changing that would be a sweep through the components for no
   * gain, and the browser arm genuinely is asynchronous.
   */
  private personal<T>(onDevice: () => T, viaBackend: () => Observable<T>): Observable<T> {
    return this.local.enabled ? of(onDevice()) : viaBackend();
  }

  // --- Locked categories ----------------------------------------------------

  /**
   * A list with whatever belongs to a locked category taken out.
   *
   * Favourites and history do not say which category their items are in, so
   * the locked categories' own contents are read -- from the device's
   * catalogue as a rule, and only while something is locked and the device is
   * locked, which is when the answer is anything but "nothing".
   *
   * Also taken out: what belongs to a provider that is switched off or gone.
   * It stays on the account, and would only fail to play.
   */
  private withoutLockedOut<T>(
    type: StreamType,
    list: Observable<T[]>,
    idOf: (item: T) => string
  ): Observable<T[]> {
    return list.pipe(
      switchMap(items =>
        from(Promise.all([this.lockedOutIds(type), this.provider.loadedRecords()])).pipe(
          map(([out, records]) => {
            // No records is a browser, which does not keep providers itself.
            const on = new Set(records.filter(record => record.enabled).map(record => record.tag));
            const provided = (item: T) => records.length === 0 || on.has(untagged(idOf(item)).tag);
            return items.filter(item => provided(item) && !out.has(idOf(item)));
          })
        )
      )
    );
  }

  /** Whether something is in a category that is locked on this device right now. */
  async isLockedOut(type: StreamType, itemId: string): Promise<boolean> {
    return (await this.lockedOutIds(type)).has(String(itemId));
  }

  /** Per library and set of locked categories, so the contents are read once. */
  private readonly lockedOutCache = new Map<string, Promise<Set<string>>>();

  private lockedOutIds(type: StreamType): Promise<Set<string>> {
    const categories = this.lock.lockedOutOf(type);
    if (!categories.length) {
      return Promise.resolve(new Set());
    }

    const key = `${type}:${[...categories].sort((a, b) => a.localeCompare(b)).join(',')}`;
    const held = this.lockedOutCache.get(key);
    if (held) {
      return held;
    }

    let complete = true;
    const reading = Promise.all(
      categories.map(categoryId =>
        firstValueFrom(
          this.eitherWay(
            direct => direct.catalogue.streams(type, categoryId),
            () =>
              this.http
                .get<{ success: boolean; data: Stream[] }>(`${this.apiUrl}/streams/${type}/${categoryId}`)
                .pipe(map(response => (response.success ? response.data : [])))
          )
        ).catch(() => {
          complete = false;
          return [] as Stream[];
        })
      )
    ).then(lists => {
      // A category that could not be read is asked again next time rather
      // than remembered as empty.
      if (!complete) {
        this.lockedOutCache.delete(key);
      }
      return new Set(lists.flat().map(stream => String(stream.stream_id)));
    });

    this.lockedOutCache.set(key, reading);
    return reading;
  }

  /** The favourited streams for a type, ordered by the current channel sort. */
  getFavorites(type: StreamType): Observable<Stream[]> {
    return this.withoutLockedOut(
      type,
      this.personal(
        () => sortStreams(this.local.favourites(type), this.getStreamSort()),
        () =>
          this.http
            .get<{ success: boolean; data: Stream[] }>(`${this.apiUrl}/streams/favorites`, {
              params: { type, sort: this.getStreamSort() }
            })
            .pipe(map(r => (r.success ? r.data : [])))
      ),
      stream => String(stream.stream_id)
    );
  }

  /** Just the ids, so a list can show which rows are already favourited. */
  getFavoriteIds(type: StreamType): Observable<string[]> {
    return this.personal(
      () => this.local.favouriteIds(type),
      () =>
        this.http
          .get<{ success: boolean; data: string[] }>(`${this.apiUrl}/streams/favorites/ids`, {
            params: { type }
          })
          .pipe(map(r => (r.success ? r.data.map(String) : [])))
    );
  }

  /**
   * Stars or unstars a stream.
   *
   * Takes the whole stream rather than its id because a device has to be able
   * to draw the favourites rail with no backend to hydrate it from -- the name
   * and the icon are in hand at this moment and nowhere else later.
   */
  setFavorite(stream: Stream, type: StreamType, favorite: boolean): Observable<boolean> {
    const streamId = String(stream.stream_id);

    return this.personal(
      () => {
        this.local.setFavourite(stream, type, favorite);
        return true;
      },
      () => {
        const body = { streamId, type };
        const request = favorite
          ? this.http.post<{ success: boolean }>(`${this.apiUrl}/streams/favorites`, body)
          : this.http.request<{ success: boolean }>('DELETE', `${this.apiUrl}/streams/favorites`, {
              body
            });

        return request.pipe(map(r => r.success));
      }
    );
  }

  // --- Watch history ------------------------------------------------------

  /** The last few things watched in a section, newest first. */
  getRecentlyWatched(type: StreamType, limit = RECENT_LIMIT): Observable<WatchProgress[]> {
    return this.withoutLockedOut(
      type,
      this.personal(
        () => this.local.recent(type, limit),
        () =>
          this.http
            .get<{ success: boolean; data: WatchProgress[] }>(
              `${this.apiUrl}/streams/progress/recent`,
              { params: { type, limit: String(limit) } }
            )
            .pipe(
              map(r => (r.success ? r.data : [])),
              // History is a convenience: a section should still open if it fails.
              catchError(() => of([] as WatchProgress[]))
            )
      ),
      // An episode is kept out by its show, which is what the category holds.
      entry => String(entry.type === 'series' ? (entry.seriesId ?? entry.itemId) : entry.itemId)
    );
  }

  /** Positions for a set of items, so a list can show how far each one got. */
  getProgressFor(type: StreamType, itemIds: string[]): Observable<Record<string, WatchProgress>> {
    if (itemIds.length === 0) {
      return of({});
    }

    return this.personal(
      () => this.local.progressFor(type, itemIds),
      () =>
        this.http
          .post<{ success: boolean; data: Record<string, WatchProgress> }>(
            `${this.apiUrl}/streams/progress/lookup`,
            { type, itemIds }
          )
          .pipe(
            map(r => (r.success ? r.data : {})),
            catchError(() => of({}))
          )
    );
  }

  /** Every episode position for one show, keyed by episode id. */
  getSeriesProgress(seriesId: string | number): Observable<Record<string, WatchProgress>> {
    return this.personal(
      () => this.local.seriesProgress(String(seriesId)),
      () =>
        this.http
          .get<{ success: boolean; data: Record<string, WatchProgress> }>(
            `${this.apiUrl}/streams/progress/series/${seriesId}`
          )
          .pipe(
            map(r => (r.success ? r.data : {})),
            catchError(() => of({}))
          )
    );
  }

  /**
   * Records where playback got to.
   *
   * Failures are swallowed: this fires repeatedly while something plays, and a
   * lost position is not worth interrupting the viewer over. On a device it
   * cannot fail at all -- it is a write to local storage, and the queue carries
   * it onward whenever there is somewhere to carry it to.
   */
  saveProgress(entry: WatchProgressInput): Observable<WatchProgress | null> {
    // Watching is using the app, however long it goes without a key press.
    this.lock.noteActivity();
    // A report that says nothing must not replace one that does (saysNothing).
    if (saysNothing(entry)) {
      return of(null);
    }
    return this.personal<WatchProgress | null>(
      () => this.local.saveProgress(entry),
      () =>
        this.http
          .post<{ success: boolean; data: WatchProgress }>(`${this.apiUrl}/streams/progress`, entry)
          .pipe(
            map(r => (r.success ? r.data : null)),
            catchError(() => of(null))
          )
    );
  }

  /** Drops something from the watch history. */
  removeProgress(type: StreamType, itemId: string): Observable<boolean> {
    return this.personal(
      () => {
        this.local.removeProgress(type, itemId);
        return true;
      },
      () =>
        this.http
          .request<{ success: boolean }>('DELETE', `${this.apiUrl}/streams/progress`, {
            body: { type, itemId }
          })
          .pipe(
            map(r => r.success),
            catchError(() => of(false))
          )
    );
  }

  /**
   * The scope an arrangement is stored under.
   *
   * A stream arrangement without a category has no scope to be stored in --
   * that is the favourites list or a search, neither of which is arrangeable.
   */
  private scopeFor(
    kind: 'category' | 'stream',
    type: StreamType,
    categoryId?: string
  ): string | null {
    if (kind === 'category') {
      return categoryScope(type);
    }
    return categoryId ? streamScope(type, categoryId) : null;
  }

  /** Reads the saved manual arrangement for a list. */
  getManualOrder(kind: 'category' | 'stream', type: StreamType, categoryId?: string): Observable<string[]> {
    return this.personal(
      () => {
        const scope = this.scopeFor(kind, type, categoryId);
        return scope ? this.local.manualOrder(scope) : [];
      },
      () => {
        const params: Record<string, string> = { kind, type };
        if (categoryId) {
          params['categoryId'] = categoryId;
        }
        return this.http
          .get<{ success: boolean; data: { itemIds: string[] } }>(`${this.apiUrl}/streams/order`, {
            params
          })
          .pipe(map(r => (r.success ? r.data.itemIds : [])));
      }
    );
  }

  /** Persists a manual arrangement so it applies on every device. */
  saveManualOrder(
    kind: 'category' | 'stream',
    type: StreamType,
    itemIds: string[],
    categoryId?: string
  ): Observable<boolean> {
    return this.personal(
      () => {
        const scope = this.scopeFor(kind, type, categoryId);
        if (scope) {
          this.local.saveManualOrder(scope, itemIds);
        }
        return !!scope;
      },
      () =>
        this.http
          .post<{ success: boolean }>(`${this.apiUrl}/streams/order`, {
            kind,
            type,
            categoryId,
            itemIds
          })
          .pipe(map(r => r.success))
    );
  }

  /**
   * The categories a list shows: without the hidden ones, and without the
   * locked ones while this device is locked. `everything` is for the one place
   * that has to show those too -- where they are hidden and locked.
   */
  getCategories(type: StreamType, { everything = false } = {}): Observable<Category[]> {
    return this.allCategories(type).pipe(
      map(categories => this.withAllChannels(type, categories)),
      map(categories => (everything ? categories : this.lock.shown(type, categories)))
    );
  }

  /**
   * An "All channels" row at the head of each provider's live categories,
   * when there is more than one provider (TV-21, D-15). With one there are no
   * groups, and the list is what it always was.
   */
  private withAllChannels(type: StreamType, categories: Category[]): Category[] {
    if (type !== 'live') {
      return categories;
    }
    const providers = new Set(categories.map(category => category.provider ?? ''));
    if (providers.size < 2) {
      return categories;
    }
    const headed = new Set<string>();
    const out: Category[] = [];
    for (const category of categories) {
      const tag = category.provider ?? '';
      if (!headed.has(tag)) {
        headed.add(tag);
        out.push({
          category_id: tagged(tag, ALL_CHANNELS_ID),
          category_name: t('cat.allChannels'),
          parent_id: '0',
          provider: tag
        });
      }
      out.push(category);
    }
    return out;
  }

  /**
   * Every channel of one provider: its whole live listing, as search indexes
   * it -- one request a day at most, and the device's own copy otherwise --
   * less what is hidden or locked.
   */
  private async allChannelsOf(direct: DirectProvider, type: StreamType, tag: string): Promise<Stream[]> {
    const slot = direct.slots.find(candidate => candidate.tag === tag);
    if (!slot) {
      return [];
    }
    if (!(await slot.catalogue.indexIsFresh(type)) && !this.nativePlayer.active()) {
      await this.runIndex(direct, type, true, tag).catch(() => 0);
    }
    const all = (await slot.catalogue.allStreams(type)).map(stream => tagStream(tag, stream));
    return sortStreams(
      all.filter(stream => !this.lock.keepsOut(type, stream.category_id)),
      this.getStreamSort(),
      []
    );
  }

  private allCategories(type: StreamType): Observable<Category[]> {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }

    const sort = this.categorySortFor(type);

    return this.eitherWay(
      async direct => {
        const categories = await direct.catalogue.categories(type);
        const arrangement = sort === 'manual' ? await this.arrangementFor('category', type) : [];
        return sortCategories(categories, sort, arrangement);
      },
      () =>
        this.http
          .get<{ success: boolean; data: Category[] }>(`${this.apiUrl}/streams/categories/${type}`, {
            params: { sort }
          })
          .pipe(map(response => (response.success ? response.data : [])))
    );
  }

  getStreams(categoryId: string, type: StreamType): Observable<Stream[]> {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }
    // A locked category's address can still be reached -- from history, a
    // link, a screen that was open when it locked. It opens empty.
    if (this.lock.keepsOut(type, categoryId)) {
      return of([]);
    }

    const { tag, id } = untagged(categoryId);
    if (id === ALL_CHANNELS_ID) {
      return this.eitherWay(
        direct => this.allChannelsOf(direct, type, tag),
        () => of([] as Stream[])
      );
    }

    const sort = this.streamSortFor(type, categoryId);

    return this.eitherWay(
      async direct => {
        const streams = await direct.catalogue.streams(type, categoryId);
        const arrangement =
          sort === 'manual' ? await this.arrangementFor('stream', type, categoryId) : [];
        return sortStreams(streams, sort, arrangement);
      },
      () =>
        this.http
          .get<{ success: boolean; data: Stream[] }>(`${this.apiUrl}/streams/${type}/${categoryId}`, {
            params: { sort }
          })
          .pipe(map(response => (response.success ? response.data : [])))
    );
  }

  /**
   * Searching, over the catalogue this device holds.
   *
   * It used to post to `/api/streams/search` whatever kind of device this was,
   * and for an account on the sync service that endpoint does not exist -- the
   * Worker answers 404, the store's `catchError` turns that into an empty
   * list, and the screen says "Nothing here." Every search, silently, since
   * the account moved. Measured in the running app: typing "hrt" on a line-up
   * containing HRT 1 to 4 returned nothing at all.
   *
   * A device that fetches its own catalogue now searches its own catalogue.
   * That is not a compromise forced by the 404: there is no search in the
   * Xtream protocol, so the only way to ask the provider "what matches this"
   * is to pull every category and look, which is the sweep that got this
   * address blocked. `Catalogue.search` reads the store and never fetches.
   *
   * What it therefore covers is what this device has browsed -- everything on
   * Android, where the catalogue is in SQLite and survives, and this session's
   * browsing on the desktop, where it is a Map in the window. The caller says
   * so on screen rather than leaving an empty result to be read as "you do not
   * have this channel".
   */
  /**
   * `limit` is how deep to look, and the search results page asks for more than
   * the default hundred: a section there says "showing 5 of 137", and a total
   * capped at a hundred would be a number the page had made up.
   */
  searchStreams(query: string, type: StreamType, limit?: number): Observable<Stream[]> {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }

    const sort = this.getStreamSort();

    return this.eitherWay(
      async direct => {
        await this.indexIfStale(direct, type);
        const found = await direct.catalogue.search(type, query, limit);
        return sortStreams(found, sort, []);
      },
      () =>
        this.http
          .post<{ success: boolean; data: Stream[] }>(`${this.apiUrl}/streams/search`, {
            query,
            types: [type]
          })
          .pipe(map(response => (response.success ? response.data : [])))
    ).pipe(map(found => found.filter(stream => !this.lock.keepsOut(type, stream.category_id))));
  }

  /**
   * Indexes a library for search when its index is missing or over a day old.
   *
   * Never while something is playing: the subscription allows one connection,
   * and a large download beside a stream is a stutter nobody asked for. A
   * failure is not a failed search -- it searches what is already held.
   *
   * And neither is staleness. A *missing* index is worth waiting for, because
   * without one there is nothing to search; a day-old one is not, because
   * yesterday's answer is very nearly today's and this account holds 196,451
   * films. Waiting for that download before showing anything is what "indexing
   * lasts forever" was: a search that had every row it needed already on the
   * device, sat behind a refresh of them. Now the stale index answers and the
   * refresh runs behind it, for the search after this one.
   */
  private async indexIfStale(direct: DirectProvider, type: StreamType): Promise<void> {
    if (this.nativePlayer.active() || (await direct.catalogue.indexIsFresh(type))) {
      return;
    }

    const refresh = () =>
      this.runIndex(direct, type).catch(() => {
        // Deliberately without the error: a transport failure can carry the
        // request's address, and for Xtream the address is the credential.
        console.warn(`Could not index ${type} for search; searching what is held`);
      });

    if (await direct.catalogue.indexedAt(type)) {
      void refresh();
      return;
    }

    await refresh();
  }

  /**
   * A library this device has never held, downloaded now, for a film or show
   * page that found only the copies in categories already opened (9 November).
   * The same one request per library a search makes when nothing is held;
   * nothing when a library is held at all, however old -- For You keeps that
   * fresh -- and never while something plays. True when the library arrived,
   * for the page to look for its copies again.
   */
  async fetchLibraryIfNeverHeld(type: StreamType): Promise<boolean> {
    // One download however many rows and pages ask at once.
    let fetching = this.fetchingLibrary.get(type);
    if (!fetching) {
      fetching = this.fetchNeverHeld(type).finally(() => this.fetchingLibrary.delete(type));
      this.fetchingLibrary.set(type, fetching);
    }
    return fetching;
  }

  private readonly fetchingLibrary = new Map<StreamType, Promise<boolean>>();

  private async fetchNeverHeld(type: StreamType): Promise<boolean> {
    const direct = await this.provider.direct().catch(() => null);
    if (!direct || this.nativePlayer.active() || (await direct.catalogue.indexedAt(type))) {
      return false;
    }
    await this.runIndex(direct, type).catch(() => {
      // Without the error: a transport failure can carry the request's
      // address, and for Xtream the address is the credential.
      console.warn(`Could not download the ${type} library for a page's copies`);
    });
    return Boolean(await direct.catalogue.indexedAt(type).catch(() => null));
  }

  /**
   * Whether this device holds a library whole (indexed at least once), not
   * only the categories opened so far: what an answer of "not in your
   * library" needs before it can be believed.
   */
  async libraryHeld(type: StreamType): Promise<boolean> {
    const direct = await this.provider.direct().catch(() => null);
    return Boolean(direct && (await direct.catalogue.indexedAt(type).catch(() => null)));
  }

  /**
   * One provider's whole library indexed now, for carrying the account over
   * to it when it replaced another (CarryOverService). Null where this device
   * does not reach providers itself.
   */
  async indexProvider(tag: string, type: StreamType): Promise<number | null> {
    const direct = await this.provider.direct();
    return direct ? this.runIndex(direct, type, true, tag) : null;
  }

  private async runIndex(direct: DirectProvider, type: StreamType, force = false, onlyTag?: string): Promise<number> {
    this.indexing.set(type);
    this.indexProgress.set(null);
    // Shown twice a second at most, as a guide's is: a redraw per category
    // is a lot of them on a television.
    let shownAt = 0;
    const onFiled = (filed: number, total: number | null) => {
      const now = Date.now();
      if (now - shownAt >= 500 || filed === total) {
        shownAt = now;
        this.indexProgress.set({ filed, total });
      }
    };
    try {
      // Each provider in turn: they may well share one line. One whose index
      // is still fresh is left alone -- a playlist added today must not cost
      // the subscription a second whole-library download the same day.
      let count = 0;
      for (const slot of direct.slots) {
        if (onlyTag !== undefined && slot.tag !== onlyTag) {
          continue;
        }
        if (!force && (await slot.catalogue.indexIsFresh(type))) {
          continue;
        }
        // On Android an Xtream listing goes to a file and is read back a title
        // at a time: through the HTTP bridge in one piece, a whole show library
        // ran a television out of memory and Android killed the app. A
        // playlist is read that way by its source already.
        const plugin = slot.xtream ? guideDownloadPlugin() : null;
        if (slot.xtream && plugin) {
          const address = slot.xtream.streamsAddress(type);
          count += await slot.catalogue.indexWith(type, async file => {
            const downloaded = await plugin.download({ url: address, idleTimeoutMs: 60_000 });
            try {
              return await this.readLibraryFile(plugin, downloaded, type, file);
            } finally {
              await plugin.discard({ id: downloaded.id }).catch(() => undefined);
            }
          }, onFiled);
        } else {
          count += await slot.catalogue.index(type, undefined, onFiled);
        }
        this.indexProgress.set(null);
      }
      return count;
    } finally {
      this.indexing.set(null);
      this.indexProgress.set(null);
    }
  }

  /** Set once the library worker could not be started here, so the next index does not try again. */
  private libraryReadHere = typeof Worker === 'undefined';

  /** Set once a worker could not fetch a downloaded file here, so the next index reads it over the bridge. */
  private libraryFileOverBridge = false;

  /**
   * A downloaded library, read by a worker straight from the file where this
   * APK says where the file is; over the bridge otherwise, or where the worker
   * could not fetch it. Nothing is downloaded twice: a fallback reads the same
   * file.
   */
  private async readLibraryFile(plugin: GuideDownloadPlugin, downloaded: DownloadedFile, type: StreamType, file: FileCategory): Promise<number> {
    const address = downloadedFileAddress(downloaded);
    if (address && !this.libraryReadHere && !this.libraryFileOverBridge) {
      let start: typeof import('./native/library-worker').startLibraryWorker | null = null;
      try {
        ({ startLibraryWorker: start } = await import('./native/library-worker'));
        return await workerLibraryFileReader(start)(address, type, file);
      } catch (error) {
        if (error instanceof LibraryFileUnreadable) {
          console.warn('The library worker could not fetch the download; reading it over the bridge');
          this.libraryFileOverBridge = true;
        } else if (start && !(error instanceof LibraryWorkerUnavailable)) {
          // Failing part way through is the index's failure, the caller's to report.
          throw error;
        } else {
          console.warn('Reading the library on the page, as a worker could not be started:', error instanceof Error ? error.name : '');
          this.libraryReadHere = true;
        }
      }
    }
    return this.readLibrary(downloadedFileBytes(plugin, downloaded), type, file);
  }

  /**
   * Who reads a library listing: a worker, so the page goes on answering the
   * remote while a library is indexed (shared/xtream/libraryWorker.ts); the
   * page itself where a worker cannot be started -- from the same bytes,
   * untouched, so nothing is downloaded twice.
   */
  private async readLibrary(bytes: AsyncIterable<Uint8Array>, type: StreamType, file: FileCategory): Promise<number> {
    if (!this.libraryReadHere) {
      let start: typeof import('./native/library-worker').startLibraryWorker | null = null;
      try {
        ({ startLibraryWorker: start } = await import('./native/library-worker'));
        return await workerLibraryReader(start)(bytes, type, file);
      } catch (error) {
        // Failing part way through is the index's failure, the caller's to
        // report; only a worker that never started is read around.
        if (start && !(error instanceof LibraryWorkerUnavailable)) {
          throw error;
        }
        console.warn('Reading the library on the page, as a worker could not be started:', error instanceof Error ? error.name : '');
        this.libraryReadHere = true;
      }
    }
    return readLibraryHere(bytes, type, file);
  }

  /**
   * Indexes a library again now, whatever its age -- the Reindex button.
   *
   * Refused while something is playing, for the reason above; the result says
   * how many titles the index holds, or null when it could not be done here.
   */
  reindexLibrary(type: StreamType): Observable<number | null> {
    if (this.nativePlayer.active()) {
      return of(null);
    }
    return this.eitherWay(
      direct => this.runIndex(direct, type, true),
      () => of(null)
    ).pipe(catchError(() => of(null)));
  }

  /** When each library's background refresh was last tried, so a failing one is not tried on every visit. */
  private readonly refreshTried = new Map<StreamType, number>();

  /**
   * Keeps "Recently added" new: each library indexed again once it is a day
   * old, in the background (12 October: the television's list had
   * been stuck for days). Before this, a library was refreshed only by a
   * search on that device, so a television that is watched rather than
   * searched kept the list it had.
   *
   * One request per library a day, as a search already makes; never while
   * something plays; a failed try waits an hour. True when anything was
   * indexed, for the caller to read the list again.
   */
  async refreshLibrariesIfStale(types: StreamType[]): Promise<boolean> {
    const direct = await this.provider.direct().catch(() => null);
    if (!direct) {
      return false;
    }
    let refreshed = false;
    for (const type of types) {
      const tried = this.refreshTried.get(type) ?? 0;
      if (this.nativePlayer.active() || Date.now() - tried < 60 * 60 * 1000 || (await direct.catalogue.indexIsFresh(type))) {
        continue;
      }
      this.refreshTried.set(type, Date.now());
      try {
        refreshed = (await this.runIndex(direct, type)) > 0 || refreshed;
      } catch {
        // Without the error: a transport failure can carry the request's
        // address, and for Xtream the address is the credential.
        console.warn(`Could not refresh the ${type} library; keeping what is held`);
      }
    }
    return refreshed;
  }

  /** Whose library this device reads, for caches of what was found in it; '' without one. */
  async libraryOwner(): Promise<string> {
    return (await this.provider.direct().catch(() => null))?.providerUsername ?? '';
  }

  /** Whether the parental lock lets this stream be shown, as `findHeld` already asks. */
  allowed(type: StreamType, stream: Stream): boolean {
    return !this.lock.keepsOut(type, stream.category_id);
  }

  /**
   * Many titles looked for in what the device holds, at once
   * (Catalogue.findTitles): each title with its copies, the parental lock
   * applied. Empty answers without a device catalogue.
   */
  async findHeldTitles(type: StreamType, titles: string[], limitEach = 100): Promise<Map<string, Stream[]>> {
    const direct = await this.provider.direct().catch(() => null);
    if (!direct) {
      return new Map();
    }
    const found = await direct.catalogue.findTitles(type, titles, limitEach).catch(() => new Map<string, Stream[]>());
    for (const [title, streams] of found) {
      found.set(title, streams.filter(stream => !this.lock.keepsOut(type, stream.category_id)));
    }
    return found;
  }

  async findHeld(type: StreamType, query: string, limit = 40): Promise<Stream[]> {
    const direct = await this.provider.direct().catch(() => null);
    if (!direct) {
      return [];
    }
    const found = await direct.catalogue.search(type, query, limit).catch(() => [] as Stream[]);
    return found.filter(stream => !this.lock.keepsOut(type, stream.category_id));
  }

  /**
   * The newest additions this device holds for a library, for For You's
   * "Recently added". Reads the device's catalogue only; empty on a build that
   * holds none.
   */
  recentlyAdded(type: StreamType, limit = 24): Observable<Stream[]> {
    return this.eitherWay(
      direct => direct.catalogue.recentlyAdded(type, limit),
      () => of([] as Stream[])
    ).pipe(catchError(() => of([] as Stream[])));
  }

  /** A category as this device holds it, never asked of the provider: [] when it is not held. */
  heldStreams(categoryId: string, type: StreamType): Observable<Stream[]> {
    return this.eitherWay(
      direct => direct.catalogue.held(type, categoryId),
      () => of([] as Stream[])
    ).pipe(catchError(() => of([] as Stream[])));
  }

  /** When a library was last indexed on this device, or null. */
  libraryIndexedAt(type: StreamType): Observable<string | null> {
    return this.eitherWay(
      direct => direct.catalogue.indexedAt(type),
      () => of(null)
    ).pipe(catchError(() => of(null)));
  }

  /** The whole guide for one channel, from a backend that has one. */
  getEPG(streamId: number): Observable<EPGListing> {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }
    return this.backendOnly({ epg_listings: [] } as EPGListing, () =>
      this.http
        .get<{ success: boolean; data: EPGListing }>(`${this.apiUrl}/streams/epg/${streamId}`)
        .pipe(map(response => (response.success ? response.data : { epg_listings: [] })))
    );
  }

  // Get series info (seasons and episodes)
  /**
   * The show's last answer kept on this device, without asking the provider:
   * what a show page reads of its other copies before it has a reason to ask
   * them (the seasons across copies, 22 November). Null when none is kept.
   */
  async keptSeriesInfo(seriesId: string | number): Promise<SeriesInfo | null> {
    const direct = this.provider.supported && this.isAuthenticated() ? await this.provider.direct().catch(() => null) : null;
    if (!direct) {
      return null;
    }
    const kept = await this.seriesCache.get(`${direct.providerUsername}:${seriesId}`).catch(() => null);
    if (!kept || !Object.keys(kept.episodes ?? {}).length) {
      return null;
    }
    noteShowTitles(kept);
    return kept;
  }

  getSeriesInfo(seriesId: string | number): Observable<SeriesInfo> {
    // The show's and its episodes' names, kept out of error reports (utils/held-titles.ts).
    return this.seriesInfoFromProvider(seriesId).pipe(tap(info => noteShowTitles(info)));
  }

  private seriesInfoFromProvider(seriesId: string | number): Observable<SeriesInfo> {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }

    const viaBackend = () =>
      this.http
        .get<{ success: boolean; data: SeriesInfo }>(`${this.apiUrl}/streams/series/info/${seriesId}`)
        .pipe(map(response => (response.success ? response.data : EMPTY_SERIES)));
    if (!this.provider.supported) {
      return viaBackend();
    }

    // The last answer kept on the device first, then the provider's: the
    // provider is the only thing that knows which episodes exist, and a show
    // gains them while you are watching it -- but its one request for a show
    // is every season, and took over 30 s for Supernatural (SeriesInfoCache).
    return defer(() => this.provider.direct()).pipe(
      switchMap(direct => {
        if (!direct) {
          return viaBackend();
        }
        const key = `${direct.providerUsername}:${seriesId}`;
        // An answer with no seasons is not kept, or one bad answer would stand in for good ones.
        const seasons = (info: SeriesInfo | null) => Object.keys(info?.episodes ?? {}).length > 0;
        const fresh = from(direct.client.getSeriesInfo(String(seriesId))).pipe(
          tap(info => seasons(info) && void this.seriesCache.put(key, info))
        );
        return from(this.seriesCache.get(key)).pipe(
          map(kept => (seasons(kept) ? kept : null)),
          switchMap(kept => {
            if (!kept) {
              return fresh.pipe(
                catchError(error => {
                  console.warn('Direct provider request failed; trying the backend', error);
                  return viaBackend();
                })
              );
            }
            const keptAs = JSON.stringify(kept);
            // Behind what is shown: a failure leaves the kept seasons, and an
            // answer that changed nothing does not draw the page again.
            return concat(
              of(kept),
              fresh.pipe(
                filter(info => JSON.stringify(info) !== keptAs),
                catchError(() => EMPTY)
              )
            );
          })
        );
      })
    );
  }

  /**
   * A few programmes for one channel, from a backend that has them.
   *
   * Behind `backendOnly` like the rest of the guide endpoints, and it was not,
   * which is the whole of why the Programme guide panel said "Failed to load
   * EPG data" every time it was opened for weeks. The sync service has no
   * `/streams/*` routes at all, so this asked for something that does not
   * exist and got a 404 -- while the channel list behind the dialog drew the
   * same guide correctly off the device.
   *
   * Nothing calls it now: `EpgStore` reads the device's guide through
   * `guideForStreams`. Kept, and kept safe, because a device pointed back at
   * the Express backend is still a supported thing to be.
   */
  /**
   * For automatic matches that drew nothing, the same channel from another guide.
   *
   * On a real device the provider's guide listed HBO, Nick Jr, Doku TV and ten
   * more with empty schedules while epgshare carried them in full, and those
   * rows stayed blank because the provider's copy happened to match first.
   * Here, each automatic match with no programmes in the window has its twins
   * asked, and a single twin that has programmes takes its place. It rewrites
   * `streamsByChannel` in place and returns the programmes it found.
   *
   * Hand-made mappings are left exactly as they are: somebody chose that
   * channel, and a blank row is a truer answer to their choice than a
   * substitute they did not pick. And it is one extra read of the store, only
   * for the channels that came back empty, so a guide that answers everything
   * costs nothing more than before.
   */
  private async fromTwins(
    index: ReturnType<typeof indexGuideChannels>,
    guideChannels: readonly { id: string; name: string; sourceId: string }[],
    matchedAutomatically: Map<string, MatchedChannel>,
    streamsByChannel: Map<string, MatchedChannel>,
    programmes: readonly { channel: string }[],
    from: number,
    to: number
  ): Promise<{ channel: string; start: number; stop: number; title: string; description: string; category: string }[]> {
    const answered = new Set(programmes.map(programme => normaliseChannelId(programme.channel)));
    const known = new Map(guideChannels.map(channel => [`${channel.sourceId}|${channel.id}`, channel]));

    const empty = [...matchedAutomatically.values()].filter(
      matched => !answered.has(normaliseChannelId(matched.ref.channelId))
    );
    if (!empty.length) {
      return [];
    }

    const twinsOf = new Map<MatchedChannel, ReturnType<typeof guideTwins>>();
    for (const matched of empty) {
      const channel = known.get(`${matched.ref.sourceId}|${matched.ref.channelId}`);
      if (channel) {
        twinsOf.set(matched, guideTwins(index, channel));
      }
    }

    const candidates = [...twinsOf.values()].flat();
    if (!candidates.length) {
      return [];
    }

    const found = await this.guide.programmesFor(
      candidates.map(twin => ({ sourceId: twin.sourceId, channelId: twin.id })),
      from,
      to
    );
    // Programmes come back carrying a channel id and no source. Everything
    // asked for here is a twin, so an id that answered belongs to a twin -- and
    // two twins sharing an id across guides are the same channel by the
    // strictest test there is, which is exactly when either will do.
    const withProgrammes = new Set(found.map(programme => normaliseChannelId(programme.channel)));

    const kept: typeof found = [];
    // Programmes are added once per channel however many empty matches choose
    // it, and not at all when the first read already brought them -- otherwise
    // the same evening is drawn twice, one copy over the other.
    const added = new Set(answered);
    for (const [matched, twins] of twinsOf) {
      const twin = chooseTwin(twins, candidate => withProgrammes.has(normaliseChannelId(candidate.id)));
      if (!twin) {
        continue;
      }

      streamsByChannel.delete(matched.ref.channelId);
      const existing = streamsByChannel.get(twin.id);
      if (existing) {
        existing.streamIds.push(...matched.streamIds);
      } else {
        streamsByChannel.set(twin.id, {
          ref: { sourceId: twin.sourceId, channelId: twin.id },
          streamIds: [...matched.streamIds]
        });
      }
      const twinId = normaliseChannelId(twin.id);
      if (!added.has(twinId)) {
        added.add(twinId);
        kept.push(...found.filter(programme => normaliseChannelId(programme.channel) === twinId));
      }
    }

    return kept;
  }

  getShortEPG(streamId: string, limit: number = 4): Observable<EPGListing> {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }
    return this.backendOnly({ epg_listings: [] } as EPGListing, () =>
      this.http
        .get<{ success: boolean; data: EPGListing }>(
          `${this.apiUrl}/streams/epg-short/${streamId}`,
          { params: { limit: limit.toString() } }
        )
        .pipe(map(response => (response.success ? response.data : { epg_listings: [] })))
    );
  }

  /**
   * The guide for a list of channels, from the device if it has one.
   *
   * Takes streams rather than their ids, which the backend version does not
   * need to. A guide names channels by XMLTV's ids, not by the provider's
   * stream ids, and `epg_channel_id` is the only thing that joins them -- so
   * asking the device requires knowing what each stream calls itself in a
   * guide, and asking the backend never did.
   *
   * Falls back whenever the device cannot answer: no guide loaded, no channel
   * ids on these streams, or nothing in the window. A device with no guide yet
   * should show the backend's while it has one, not an empty row.
   */
  guideForStreams(streams: Stream[], backMs = GUIDE_BACK_MS): Observable<GuideByStream> {
    const ids = streams.map(stream => String(stream.stream_id));
    const viaBackend = () => this.getEPGFromDb(ids);

    if (!this.guide.supported || !streams.length) {
      return viaBackend();
    }

    return defer(async () => {
      // Matched against the guide's own channel ids rather than compared for
      // equality, because a provider and a feed routinely describe the same
      // channel differently -- Htv1.hr against HTV1.HD.hr. Without this, a
      // real line-up matched sixteen channels out of ten thousand.
      const guideChannels = await this.guide.allChannels();
      if (!guideChannels.length) {
        return null;
      }

      const { streamsByChannel, index, matchedAutomatically } = this.matchToGuide(streams, guideChannels);

      if (!streamsByChannel.size) {
        return null;
      }

      // Ahead by more than the timeline draws, so scrolling it needs no second
      // read; behind by only enough to catch the programme already running.
      //
      // Reaching further back is not free and not harmless: the timeline draws
      // from the current half-hour, so anything that finished earlier has
      // nowhere to sit and gets clamped against the left edge of the row. One
      // channel's programme panel asks for more, as far back as its catch-up.
      const now = Date.now();
      const from = now - backMs;
      const to = now + 24 * 60 * 60 * 1000;
      const programmes = await this.guide.programmesFor(
        [...streamsByChannel.values()].map(matched => matched.ref),
        from,
        to
      );

      programmes.push(
        ...(await this.fromTwins(index, guideChannels, matchedAutomatically, streamsByChannel, programmes, from, to))
      );

      if (!programmes.length) {
        return null;
      }

      return programmesByStream(programmes, streamsByChannel);
    }).pipe(
      switchMap(found => (found ? of(found) : viaBackend())),
      catchError(error => {
        console.warn('Device guide unavailable; trying the backend', error);
        return viaBackend();
      })
    );
  }

  /**
   * Nothing, when the server is one that has no guide to give.
   *
   * The sync service keeps accounts and what a person made, and no catalogue
   * and no guide -- so these endpoints are not unavailable there, they do not
   * exist. Asking anyway produces a 404 per screenful, a console full of red,
   * and on one occasion took down the device's own guide, which had already
   * answered correctly, because it was sitting in the same forkJoin.
   *
   * Nothing at once, too, when there is no server at all (hasServer): a
   * device used without an account would otherwise ask an address the app
   * only guessed. On the TV emulator that is the host's port 3000, where a
   * request hangs rather than failing, and every category's guide waited on
   * it (8 November).
   */
  private backendOnly<T>(nothing: T, ask: () => Observable<T>): Observable<T> {
    if (!hasServer()) {
      return of(nothing);
    }
    return from(this.serviceKind.isSyncService()).pipe(
      switchMap(sync => (sync ? of(nothing) : ask()))
    );
  }

  // Get EPG from DB for current streams
  getEPGFromDb(streamIds: string[]): Observable<GuideByStream> {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }
    return this.backendOnly({} as GuideByStream, () =>
      this.http
        .post<{ success: boolean; data: GuideByStream }>(
          `${this.apiUrl}/streams/epg/db`,
          { streamIds }
        )
        .pipe(map(r => (r.success ? r.data : {})))
    );
  }

  // Get "now" EPG mapping for given streams
  getNowEPGForStreams(streamIds: string[]): Observable<Record<string, LooseProgramme>> {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }
    return this.backendOnly({} as Record<string, LooseProgramme>, () =>
      this.http
        .post<{ success: boolean; data: Record<string, LooseProgramme> }>(
          `${this.apiUrl}/streams/epg-now/streams`,
          { streamIds }
        )
        .pipe(map(r => (r.success ? r.data : {})))
    );
  }

  /**
   * Asks a backend to warm its guide cache for these streams.
   *
   * Meaningless against the sync service, which holds no guide -- and worse
   * than meaningless, because of where it sits. "Refresh guide" runs this
   * first and then reads the guide twice; both reads work on a device, and
   * neither was ever reached. The 404 from this call went into the chain's
   * `catchError` and took the whole refresh down with it, so the one button
   * somebody presses when the guide looks empty quietly did nothing at all.
   *
   * `backendOnly` was written for exactly this and the comment on it describes
   * this failure; this call was simply missed when the rest were converted.
   */
  refreshEPGForStreams(
    streamIds: string[],
    ttlHours: number = 2
  ): Observable<{ refreshed: string[]; skipped: string[] }> {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }

    return this.backendOnly({ refreshed: [], skipped: [] }, () =>
      this.http
        .post<{ success: boolean; data: { refreshed: string[]; skipped: string[] } }>(
          `${this.apiUrl}/streams/epg/refresh`,
          { streamIds, ttlHours }
        )
        .pipe(map(r => (r.success ? r.data : { refreshed: [], skipped: [] })))
    );
  }

  /**
   * Exchanges a stream for a playback URL.
   *
   * The two paths differ more than anywhere else here. In a browser the
   * provider URL embeds the Xtream credentials, so it is resolved by the
   * backend behind a short-lived ticket rather than being built here and
   * written into the DOM where any script on the page could read it.
   *
   * On a device the credentials are already held, and the URL is built without
   * asking anyone. That is what takes the PC out of the video path: the ticket
   * route proxies the stream through the backend, so a phone playing an hour of
   * television was previously an hour of traffic through a machine at home.
   */
  /**
   * Where a stretch of a channel's past plays from, on a device.
   *
   * Only on a device: the browser's playback goes through the backend's
   * tickets, which know nothing of catch-up, and it has no player that could
   * use it anyway (catch-up is offered only where the native player is).
   * Carries credentials: never logged.
   */
  catchUpAddress(streamId: string, startMs: number, minutes: number): Observable<string> {
    return defer(async () => {
      const direct = await this.provider.direct();
      if (!direct) {
        throw new Error('Catch-up needs this device to reach the provider');
      }
      return direct.client.catchUpUrl(streamId, startMs, minutes, async slot =>
        providerClockTime(startMs, await this.providerClock(slot))
      );
    });
  }

  /**
   * The provider's clock, read when signing in and kept for a week.
   *
   * One request, the same one signing in makes, and only when catch-up is
   * asked for without a recent answer. If it fails the last answer is used,
   * and failing that the device's own clock, which is right whenever the
   * provider and the viewer share a timezone.
   */
  private async providerClock(slot: ProviderSlot): Promise<ProviderClock | null> {
    if (!slot.xtream) {
      return null;
    }
    // The first provider's under the key it always had; each other one's beside it.
    const storageKey = slot.tag ? `${PROVIDER_CLOCK_KEY}:${slot.tag}` : PROVIDER_CLOCK_KEY;
    let stored: StoredProviderClock | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as StoredProviderClock | null;
    } catch {
      stored = null;
    }
    const ours = stored && stored.providerUsername === slot.storeKey ? stored : null;
    let allowanceKnown = false;
    try {
      allowanceKnown = localStorage.getItem(connectionsKey(slot.tag)) !== null;
    } catch {
      allowanceKnown = false;
    }
    // Asked again, fresh clock or not, while the allowance is not known yet.
    if (ours && allowanceKnown && Date.now() - ours.at < PROVIDER_CLOCK_MAX_AGE_MS) {
      return ours.clock;
    }

    try {
      const answer = await slot.xtream.authenticate(15_000);
      // The same answer says how many streams the subscription allows at once,
      // which a recording needs to know (RecordingsService.mayOpen).
      try {
        localStorage.setItem(connectionsKey(slot.tag), String(connectionsAllowedFrom(answer.user_info)));
      } catch {
        // One is assumed.
      }
      const clock = providerClockFrom(answer.server_info);
      const fresh: StoredProviderClock = { providerUsername: slot.storeKey, clock, at: Date.now() };
      try {
        localStorage.setItem(storageKey, JSON.stringify(fresh));
      } catch {
        // Kept for this request only.
      }
      return clock;
    } catch {
      console.warn('Could not read the provider clock; using the last one known');
      return ours?.clock ?? null;
    }
  }

  /**
   * Asks each Xtream provider for its account once a day (with its clock),
   * which keeps how many streams it allows on the device for recordings.
   */
  async learnConnectionsAllowed(): Promise<void> {
    const direct = await this.provider.direct().catch(() => null);
    for (const slot of direct?.slots ?? []) {
      if (slot.xtream) {
        await this.providerClock(slot).catch(() => null);
      }
    }
  }

  getPlaybackUrl(type: StreamType, streamId: string, extension?: string): Observable<string> {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated');
    }

    return this.eitherWay(
      async direct => {
        // A film has to be asked about. The provider serves it at a path ending
        // in its real container and refuses any other, and it does not put the
        // container in the stream list -- which is why films failed to open
        // while episodes, which carry theirs in the series info, always played.
        let resolved = extension;
        if (type === 'vod' && !resolved) {
          try {
            resolved = (await direct.client.getVodContainerExtension(streamId)) ?? undefined;
          } catch (error) {
            console.warn('Could not resolve the container; trying the default', error);
          }
        }

        return direct.client.playbackUrl(type, streamId, resolved);
      },
      () =>
        this.http
          .post<{ success: boolean; data: { url: string } }>(`${this.apiUrl}/streams/play/ticket`, {
            type,
            streamId,
            extension
          })
          .pipe(map(r => `${this.apiUrl.replace(/\/api$/, '')}${r.data.url}`))
    );
  }

  /**
   * Which guide channel each stream is, keyed by the guide's own channel id.
   *
   * Hand-made mappings are applied first and are not second-guessed. They
   * exist because the automatic answer was absent or wrong, so letting the
   * automatic answer override them would undo the correction.
   */
  private matchToGuide(
    streams: readonly Stream[],
    guideChannels: KnownChannel[]
  ): { streamsByChannel: Map<string, MatchedChannel>; index: GuideChannelIndex; matchedAutomatically: Map<string, MatchedChannel> } {
    const streamsByChannel = new Map<string, MatchedChannel>();
    const automatic: Stream[] = [];

    for (const stream of streams) {
      const mapping = this.guideSources.mappingFor(stream.stream_id);
      if (!mapping) {
        automatic.push(stream);
        continue;
      }

      const existing = streamsByChannel.get(mapping.channelId);
      if (existing) {
        existing.streamIds.push(String(stream.stream_id));
      } else {
        streamsByChannel.set(mapping.channelId, {
          ref: { sourceId: mapping.sourceId, channelId: mapping.channelId },
          streamIds: [String(stream.stream_id)]
        });
      }
    }

    const index = indexGuideChannels(guideChannels);
    const matchedAutomatically = streamsByGuideChannel(automatic, index);

    for (const [channelId, matched] of matchedAutomatically) {
      const existing = streamsByChannel.get(channelId);
      if (existing) {
        existing.streamIds.push(...matched.streamIds);
      } else {
        streamsByChannel.set(channelId, matched);
      }
    }

    return { streamsByChannel, index, matchedAutomatically };
  }

  /**
   * Programmes in this device's guides whose titles hold the words, each on a
   * channel here that can be watched: what is on
   * now and what is coming, never what has finished. Read from what the device
   * already holds -- the guides and the channel list -- and nothing asked of
   * the provider.
   */
  async searchGuide(query: string, limit = GUIDE_SEARCH_LIMIT): Promise<GuideFind[]> {
    if (!this.guide.supported || !this.isAuthenticated()) {
      return [];
    }
    const now = Date.now();
    const hits = await this.guide.searchProgrammes(query, now, now + GUIDE_SEARCH_AHEAD_MS, limit * 4);
    if (!hits.length) {
      return [];
    }
    const direct = await this.provider.direct();
    const streams: Stream[] = [];
    for (const slot of direct?.slots ?? []) {
      for (const stream of await slot.catalogue.allStreams('live').catch(() => [] as Stream[])) {
        const tagged = tagStream(slot.tag, stream);
        if (!this.lock.keepsOut('live', tagged.category_id)) {
          streams.push(tagged);
        }
      }
    }
    if (!streams.length) {
      return [];
    }
    const { streamsByChannel } = this.matchToGuide(streams, await this.guide.allChannels());
    return linkGuideHits(hits, streamsByChannel, new Map(streams.map(stream => [String(stream.stream_id), stream])), now, limit);
  }

}
