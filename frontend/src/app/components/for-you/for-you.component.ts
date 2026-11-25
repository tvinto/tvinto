import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal, effect, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideInfo, lucideLoaderCircle, lucidePlay, lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { Category, Stream, StreamType, WatchProgress } from '@shared/types';
import { XtreamService } from '../../services/xtream.service';
import { AccountService } from '../../services/account.service';
import { GuideService } from '../../services/guide.service';
import { GuideSourcesService, guideName } from '../../services/guide-sources.service';
import { DeviceSyncService } from '../../services/device-sync.service';
import { BackButtonService } from '../../services/back-button.service';
import { CardGesturesDirective } from '../../directives/card-gestures.directive';
import { ItemAction, ItemActionsComponent } from '../item-actions/item-actions.component';
import { SubtitlePickerComponent } from '../subtitle-picker/subtitle-picker.component';
import { SubtitleItem } from '../../services/subtitle-library.service';
import {
  ProgrammeOnNow,
  channelDisplay,
  continueWatching,
  programmeOnNow,
  watchedPercent,
  posterTitle,
  remainingLabel,
  watchedWhen
} from '../../utils';
import { readHiddenShows, showOf } from '../../utils/for-you.utils';
import { namePrefix } from '../../utils/series-display.utils';
import { SettingsService } from '../../services/settings.service';
import { SETTING_KEYS } from '@shared/types';
import { t } from '../../utils/i18n';
import { TPipe } from '../../pipes/t.pipe';
import { ChannelMonogramPipe, ChannelTagsPipe, ChannelTitlePipe, PosterTitlePipe } from '../../pipes/format.pipes';
import { PopularService } from '../../services/popular.service';
import { TmdbService } from '../../services/tmdb.service';
import { PopularCard, categoryNames, openFilm, openShow, openVersion, popularCard, versionActions } from './popular-cards';
import { ShowService, localToday } from '../../services/show.service';
import { AgeLockService } from '../../services/age-lock.service';
import { ParentalLockService } from '../../services/parental-lock.service';
import { AgeCoverComponent } from '../age-cover/age-cover.component';
import { StorageBannerComponent } from '../storage-banner/storage-banner.component';
import { SlowWaitComponent } from '../slow-wait/slow-wait.component';
import { ShowNews, newsForRow, newsOrder, showNews } from '@shared/tmdb/episodes';
import { newsChip, newsTileLine } from '../../utils/show-news.utils';
import { RouterLink } from '@angular/router';
import { ProviderNamePipe } from '../../pipes/provider-name.pipe';
import { FilmService } from '../../services/film.service';
import { SpotlightComponent, SpotlightHostDirective } from '../spotlight/spotlight.component';
import { runtimeLabel } from '../film/film.component';
import { GuideByStream } from '../../utils/guide.utils';
import { oneCardPerTitle } from '../../utils/one-per-title.utils';

/** A favourite, with the library it belongs to. */
interface Favourite {
  type: StreamType;
  stream: Stream;
}

/** A show with a new or announced episode, for "New in your shows" (FY-TV-2). */
interface NewShow {
  seriesId: string;
  name: string;
  poster: string;
  news: ShowNews;
  line: string;
  /** Not out yet: "Announced" under the date. */
  announced: boolean;
}

/** What the billboard shows of the title it is about (NX-TV-1). */
interface FeaturedDetails {
  key: string;
  backdrop: string;
  overview: string;
  meta: string;
  rating: string;
  vote: number | null;
}

/** A recently added film or show, with the name of its category. */
interface Added {
  type: 'vod' | 'series';
  stream: Stream;
  category: string;
}

/** Whether this device has found a Popular row before (PopularService keeps the lists). */
function hadPopular(): boolean {
  try {
    return localStorage.getItem('xtream_tmdb_trending_movie') !== null;
  } catch {
    return false;
  }
}

/** What the actions panel is open about. */
type MenuTarget =
  | { kind: 'recent'; entry: WatchProgress }
  | { kind: 'favourite'; favourite: Favourite }
  | { kind: 'popular'; popular: PopularCard }
  | { kind: 'added'; item: Added };

/**
 * For You -- the home page (FY-TV, FY-D, FY-P).
 *
 * What someone was doing, across all three libraries at once, one press from
 * carrying on: Continue watching, what is on now on the favourite channels,
 * the next episode of shows finished part-way through a season, what was
 * recently added, the favourites, and the four ways in.
 *
 * Everything on it is data the device already holds -- history, favourites,
 * its own guide and its catalogue. Nothing here asks the provider. Playing
 * is handed to the section that owns it (see `SectionComponent.playOnArrival`)
 * and a show to its own page, so there is one way to play each thing.
 */
@Component({
  selector: 'app-for-you',
  standalone: true,
  imports: [RouterLink, SpotlightComponent, SpotlightHostDirective, StorageBannerComponent, AgeCoverComponent, SlowWaitComponent, TPipe, ProviderNamePipe, NgIcon, HlmButton, CardGesturesDirective, ItemActionsComponent, SubtitlePickerComponent, ChannelTitlePipe, ChannelTagsPipe, ChannelMonogramPipe, PosterTitlePipe],
  providers: [provideIcons({ lucideInfo, lucideLoaderCircle, lucidePlay, lucideX })],
  templateUrl: './for-you.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ForYouComponent {
  readonly guideName = guideName;
  private readonly router = inject(Router);
  private readonly xtream = inject(XtreamService);
  readonly accounts = inject(AccountService);
  private readonly guide = inject(GuideService);
  readonly guideSources = inject(GuideSourcesService);
  private readonly deviceSync = inject(DeviceSyncService);

  readonly loading = signal(true);
  readonly history = signal<WatchProgress[]>([]);
  readonly seriesHistory = signal<WatchProgress[]>([]);
  readonly favourites = signal<Favourite[]>([]);
  readonly added = signal<Added[]>([]);

  /**
   * "Popular this week" (FY-TV-2): what is trending on TMDB, films and shows
   * mixed, ten of them, as far as this library has them (PopularService).
   * Shown in place of "Recently added" -- the newest titles a provider filed,
   * which are mostly ones nobody has heard of -- wherever this device has a
   * TMDB key; "Recently added" stays where it has none.
   */
  readonly popular = signal<PopularCard[]>([]);

  /**
   * Whether the row is still being found, on a device that has had one
   * before: it holds its place with plain tiles meanwhile, so the rows
   * below do not jump when it fills (TV-34). A device that never had TMDB
   * shows nothing while it asks.
   */
  readonly popularLoading = signal(hadPopular());
  private readonly popularService = inject(PopularService);
  private readonly tmdbKeys = inject(TmdbService);

  /** Read again when a key is typed or removed on Account. */
  private readonly popularFollowsKey = effect(() => {
    this.tmdbKeys.ownKey();
    untracked(() => void this.loadPopular());
  });
  private readonly guideRows = signal<GuideByStream>({});
  /** Whether the guide has been read yet: until then a channel is not "No guide", only not known. */
  readonly guideRead = signal(false);
  /** Whether this device holds any guide at all, which is what "On now" needs. */
  readonly hasGuide = signal(true);
  readonly guideOfferDismissed = signal(false);
  private readonly now = signal(Date.now());

  private readonly settings = inject(SettingsService);

  /** Shows taken out of Continue watching, each until it is watched again. */
  private readonly hiddenShows = computed(() => readHiddenShows(this.settings.get(SETTING_KEYS.continueHidden)));

  /**
   * Films, channels and shows -- a show as itself, never one of its episodes
   * (2 October). Shows whose last episode was finished are here
   * too: there is a next one, which is what the separate Up next row was for.
   */
  readonly continueRail = computed(() => continueWatching([this.history(), this.seriesHistory()], 12, this.hiddenShows()));
  readonly liveFavourites = computed(() => this.favourites().filter(favourite => favourite.type === 'live'));
  /** Whether this page has nothing of the account's to show yet: no history, no favourites. */
  private readonly nothingYet = computed(
    () => !this.loading() && this.continueRail().length === 0 && this.favourites().length === 0
  );

  /**
   * The four doors, for an account with no history at all -- not for a
   * device that has just signed in and is still waiting for the account's
   * history to arrive (12 November: a new desktop showed the doors and
   * nothing else, with plenty of history on its way).
   */
  readonly dayOne = computed(() => this.nothingYet() && !this.deviceSync.firstSync());

  /**
   * Whether a guide is downloading here or about to: one loading, one queued
   * behind it, or the first sync that downloads the account's guides still
   * out or still working out which. "No guide on this device yet" offers a
   * download only when none of that is so.
   */
  readonly guideComing = computed(
    () =>
      this.guide.isLoading() ||
      this.guide.queued().length > 0 ||
      this.guideSources.firstLoadsComing() ||
      this.deviceSync.firstSync()
  );

  /** Placeholder rows in place of the doors while the first sync is out. */
  readonly waitingForAccount = computed(() => this.nothingYet() && this.deviceSync.firstSync());

  /** The favourites shown before "+ N more". */
  readonly FAVOURITES_SHOWN = 8;

  constructor() {
    // Read again whenever a sync brings something in -- the first one after
    // signing in above all, which lands after this page has been made.
    effect(() => {
      this.deviceSync.remoteChanges();
      untracked(() => this.load());
    });

    // A library or a guide that has just finished loading is what Popular,
    // Recently added and On now were waiting for.
    let indexing = this.xtream.indexing();
    effect(() => {
      const now = this.xtream.indexing();
      if (indexing !== null && now === null) {
        untracked(() => {
          this.loadRecentlyAdded();
          void this.loadPopular();
        });
      }
      indexing = now;
    });
    let guideLoading = this.guide.isLoading();
    effect(() => {
      const now = this.guide.isLoading();
      if (guideLoading && !now) {
        untracked(() => this.reloadGuide());
      }
      guideLoading = now;
    });

    // Back closes the panel, or the subtitles over it, before it leaves the
    // app: For You is the first screen, where an unclaimed Back exits.
    const back = inject(BackButtonService);
    back.bindTo(computed(() => this.menu() !== null), () => this.closeMenu());
    back.bindTo(computed(() => this.subtitleTarget() !== null), () => this.subtitleTarget.set(null));

    // The minutes left and the meters move; a minute is as fine as they read.
    const tick = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  private load(): void {
    forkJoin({
      live: this.xtream.getRecentlyWatched('live').pipe(catchError(() => of([] as WatchProgress[]))),
      vod: this.xtream.getRecentlyWatched('vod').pipe(catchError(() => of([] as WatchProgress[]))),
      series: this.xtream.getRecentlyWatched('series', 60).pipe(catchError(() => of([] as WatchProgress[]))),
      favLive: this.xtream.getFavorites('live').pipe(catchError(() => of([] as Stream[]))),
      favVod: this.xtream.getFavorites('vod').pipe(catchError(() => of([] as Stream[]))),
      favSeries: this.xtream.getFavorites('series').pipe(catchError(() => of([] as Stream[])))
    }).subscribe(found => {
      this.liveForGuide = { favourites: found.favLive, recent: found.live };
      this.history.set([...found.live, ...found.vod]);
      this.seriesHistory.set(found.series);
      this.favourites.set([
        ...found.favLive.map(stream => ({ type: 'live' as StreamType, stream })),
        ...found.favVod.map(stream => ({ type: 'vod' as StreamType, stream })),
        ...found.favSeries.map(stream => ({ type: 'series' as StreamType, stream }))
      ]);
      this.loading.set(false);
      this.loadGuide(found.favLive, found.live);
      void this.loadShowNews(found.series, found.favSeries);
    });

    this.loadRecentlyAdded();
    // Popular is loaded by popularFollowsKey, which runs once at the start
    // as well: called here too, the row was worked out twice on every visit.
    void this.checkGuideHeld();
  }

  /** "Popular this week", each copy with its category for the panel. */
  private async loadPopular(): Promise<void> {
    try {
      // A first visit with a key holds the row's place too: on a new device
      // the libraries are still downloading, and the row waits for them.
      if (!this.popular().length && (await this.tmdbKeys.client())) {
        this.popularLoading.set(true);
      }
      const names = await categoryNames(this.xtream);
      // Yesterday's row at once, while today's is worked out.
      const last = await this.popularService.lastMixed(10);
      if (last?.length) {
        this.popular.set(last.map(entry => popularCard(entry, names)));
        this.popularLoading.set(false);
      }
      const found = await this.popularService.mixed(10);
      this.popular.set(found.map(entry => popularCard(entry, names)));
    } finally {
      this.popularLoading.set(false);
    }
  }

  /** The two ends of the row on a television: the full lists. */
  readonly popularEnds = [
    { kind: 'movie', label: 'fy.allFilms' },
    { kind: 'tv', label: 'fy.allShows' }
  ];

  /** Placeholder tiles for the row while it is found. */
  readonly LOADING_TILES = Array.from({ length: 8 }, (_, index) => index);

  private readonly shows = inject(ShowService);

  readonly ages = inject(AgeLockService);
  private readonly parental = inject(ParentalLockService);

  /** The posters' ratings learnt while the age lock is on, so a locked one shows covered. */
  private readonly popularRatings = effect(() => {
    const cards = this.popular();
    if (!this.ages.engaged()) {
      return;
    }
    untracked(() => {
      void (async () => {
        await this.ages.learn('movie', cards.filter(card => card.item.kind === 'movie').map(card => card.item.id));
        await this.ages.learn('tv', cards.filter(card => card.item.kind === 'tv').map(card => card.item.id));
      })();
    });
  });

  /** A film opens its own page (TV-27); a show its page, in the copy chosen for it or the person's languages (TV-29). */
  async openPopular(card: PopularCard): Promise<void> {
    const rating = this.ages.lockedLabel(card.item.kind, card.item.id);
    if (rating && !(await this.parental.unlock(t('lock.age.subject', { rating, title: card.item.title })))) {
      return;
    }
    if (card.type === 'vod') {
      openFilm(this.router, card);
      return;
    }
    openShow(this.router, card, this.shows.chosen(card.item.id));
  }

  /**
   * What TMDB says is new in each show in the history and the favourites,
   * by series id: once a day per show, and nothing asked of the provider.
   */
  readonly showNews = signal<ReadonlyMap<string, ShowNews>>(new Map());
  private readonly showCandidates = signal<ReadonlyMap<string, { name: string; poster: string }>>(new Map());

  /** The shows most worth a look first: twenty, so a long history does not keep TMDB busy. */
  private static readonly NEWS_SHOWS = 20;

  private async loadShowNews(history: WatchProgress[], favourites: Stream[]): Promise<void> {
    const shows = new Map<string, { name: string; poster: string; info: unknown }>();
    for (const entry of history) {
      const id = showOf(entry);
      if (!shows.has(id) && !this.hiddenShows()[id]) {
        shows.set(id, { name: entry.name, poster: entry.icon ?? '', info: null });
      }
    }
    for (const stream of favourites) {
      const id = String(stream.stream_id);
      if (!shows.has(id)) {
        shows.set(id, { name: stream.name, poster: stream.stream_icon ?? '', info: stream });
      }
    }
    const today = localToday();
    const picked = [...shows].slice(0, ForYouComponent.NEWS_SHOWS);
    this.showCandidates.set(new Map(picked.map(([id, show]) => [id, { name: show.name, poster: show.poster }])));
    for (const [id, show] of picked) {
      const facts = await this.shows.newsFacts(id, show.name, show.info, today).catch(() => null);
      if (facts) {
        // Whether the provider has the episode is not asked here; the show's page says.
        const news = showNews(facts, today, () => false);
        this.showNews.update(held => new Map(held).set(id, news));
        if (!shows.get(id)?.poster && facts.poster) {
          this.showCandidates.update(held => new Map(held).set(id, { name: show.name, poster: facts.poster }));
        }
      }
    }
  }

  /** "New in your shows": out today, out this week, announced for the next two weeks. */
  readonly newShows = computed<NewShow[]>(() => {
    const today = localToday(new Date(this.now()));
    const found: NewShow[] = [];
    for (const [seriesId, news] of this.showNews()) {
      const show = this.showCandidates().get(seriesId);
      if (show && newsForRow(news, today)) {
        found.push({
          seriesId,
          name: show.name,
          poster: show.poster,
          news,
          line: newsTileLine(news),
          announced: news?.kind === 'soon' || news?.kind === 'season'
        });
      }
    }
    return found.sort((a, b) => newsOrder(a.news, b.news));
  });

  openNewShow(show: NewShow): void {
    void this.router.navigate(['/series', show.seriesId], { queryParams: { name: show.name } });
  }

  /** The channels whose programmes this page shows, as last read. */
  private liveForGuide: { favourites: Stream[]; recent: WatchProgress[] } = { favourites: [], recent: [] };

  /** The guide read again, once one has finished loading here. */
  private reloadGuide(): void {
    this.loadGuide(this.liveForGuide.favourites, this.liveForGuide.recent);
    void this.checkGuideHeld();
  }

  /** The programmes for the channels on this page, from the device's own guide. */
  private loadGuide(favourites: Stream[], recentLive: WatchProgress[]): void {
    const seen = new Set<string>();
    const streams: Stream[] = [];
    for (const stream of [
      ...favourites,
      ...recentLive.map(entry => ({ stream_id: entry.itemId, name: entry.name }) as Stream)
    ]) {
      if (!seen.has(String(stream.stream_id))) {
        seen.add(String(stream.stream_id));
        streams.push(stream);
      }
    }
    if (!streams.length) {
      this.guideRead.set(true);
      return;
    }
    this.xtream
      .guideForStreams(streams)
      .pipe(catchError(() => of({} as GuideByStream)))
      .subscribe(rows => {
        this.guideRows.set(rows ?? {});
        this.guideRead.set(true);
      });
  }

  /** Whether any guide is loaded here, for FY-D's "No guide on this device yet". */
  private async checkGuideHeld(): Promise<void> {
    const sources = this.guideSources.sources().filter(source => source.enabled);
    for (const source of sources) {
      if (await this.guide.summaryFor(source.id).catch(() => null)) {
        this.hasGuide.set(true);
        return;
      }
    }
    this.hasGuide.set(false);
  }

  /**
   * Films and shows, newest first, from what this device's catalogue holds:
   * one card per title, as a provider adds a film's copies together (The
   * Odyssey three times in a row, 14 November). Asked for four times over
   * for that reason.
   */
  private loadRecentlyAdded(): void {
    const oneEach = (streams: Stream[]) => oneCardPerTitle(streams, stream => stream.name);
    forkJoin({
      vod: this.xtream.recentlyAdded('vod', 48).pipe(map(oneEach), catchError(() => of([] as Stream[]))),
      series: this.xtream.recentlyAdded('series', 48).pipe(map(oneEach), catchError(() => of([] as Stream[])))
    }).subscribe(({ vod, series }) => {
      if (!vod.length && !series.length) {
        return;
      }
      const categoryNames = (type: StreamType) =>
        this.xtream.getCategories(type).pipe(catchError(() => of([] as Category[])));
      forkJoin({ vodCategories: categoryNames('vod'), seriesCategories: categoryNames('series') }).subscribe(
        ({ vodCategories, seriesCategories }) => {
          const nameOf = (categories: Category[], id: unknown) =>
            channelDisplay(categories.find(category => category.category_id === String(id))?.category_name ?? '').title;
          const all: Added[] = [
            ...vod.map(stream => ({ type: 'vod' as const, stream, category: nameOf(vodCategories, stream.category_id) })),
            ...series.map(stream => ({
              type: 'series' as const,
              stream,
              category: nameOf(seriesCategories, stream.category_id)
            }))
          ];
          all.sort((a, b) => Number(b.stream.added) - Number(a.stream.added));
          this.added.set(all.slice(0, 12));
        }
      );
    });
  }

  // --- What the cards say -------------------------------------------------

  /** Artwork that failed to load, by address; its card shows initials instead. */
  readonly failedIcons = signal<ReadonlySet<string>>(new Set());

  iconFailed(url: string | null | undefined): void {
    if (url) {
      this.failedIcons.update(failed => new Set(failed).add(url));
    }
  }

  private number(stream: Stream): string {
    const num = (stream as unknown as Record<string, unknown>)['num'];
    return num === null || num === undefined || num === '' ? '' : String(num);
  }

  /**
   * Continue watching, each card with what is on now (a channel), how far it
   * got and when. Worked out when the rail, the guide or the minute changes.
   */
  readonly continueRows = computed(() =>
    this.continueRail().map(entry => ({
      entry,
      onNow: this.onNowFor(entry.itemId),
      percent: watchedPercent(entry),
      when: this.when(entry),
      leftAndWhen: this.leftAndWhen(entry),
      showId: entry.type === 'series' ? showOf(entry) : '',
      prefix: namePrefix(entry.name),
      chip: entry.type === 'series' ? this.chipFor(showOf(entry)) : ''
    }))
  );

  // --- The billboard (NX-TV-1, NX-P-1) ------------------------------------------

  private readonly films = inject(FilmService);

  /** What the billboard is about: the newest film or show in Continue watching. */
  readonly featured = computed(() => this.continueRows().find(row => row.entry.type !== 'live') ?? null);

  /** Its backdrop and words once TMDB has them; its poster and name until then, or without a key. */
  readonly featuredDetails = signal<FeaturedDetails | null>(null);

  private readonly findFeatured = effect(() => {
    const row = this.featured();
    if (!row) {
      return;
    }
    const entry = row.entry;
    const key = entry.type + entry.itemId;
    untracked(() => {
      if (this.featuredDetails()?.key === key) {
        return;
      }
      const done = (found: Omit<FeaturedDetails, 'key'> | null) => {
        if (this.featured()?.entry.itemId === entry.itemId) {
          this.featuredDetails.set({ key, ...(found ?? { backdrop: '', overview: '', meta: '', rating: '', vote: null }) });
        }
      };
      if (entry.type === 'vod') {
        void this.films
          .feature(entry.itemId, entry.name)
          .then(film =>
            done(
              film && {
                backdrop: film.backdrop,
                overview: film.overview,
                meta: [film.year, runtimeLabel(film.runtime), film.genres.slice(0, 2).join(', ')].filter(Boolean).join(' · '),
                rating: film.rating,
                vote: film.vote
              }
            )
          )
          .catch(() => done(null));
      } else {
        void this.shows
          .feature(showOf(entry), entry.name)
          .then(show =>
            done(
              show && {
                backdrop: show.backdrop,
                overview: show.overview,
                meta: [show.year, show.genres.slice(0, 2).join(', '), show.seasons ? t('show.seasons', { count: show.seasons }) : ''].filter(Boolean).join(' · '),
                rating: show.rating,
                vote: show.vote
              }
            )
          )
          .catch(() => done(null));
      }
    });
  });

  /** The billboard's details, once they are the featured title's own. */
  readonly featuredShown = computed(() => {
    const row = this.featured();
    const details = this.featuredDetails();
    return row && details?.key === row.entry.type + row.entry.itemId ? details : null;
  });

  /** More info: the film's page, or the show's. */
  featuredInfo(): void {
    const entry = this.featured()?.entry;
    if (!entry) {
      return;
    }
    if (entry.type === 'series') {
      void this.router.navigate(['/series', showOf(entry)], { queryParams: { name: entry.name } });
      return;
    }
    void this.router.navigate(['/film', `s${entry.itemId}`], { queryParams: { name: entry.name }, state: { film: { poster: entry.icon ?? '' } } });
  }

  /** "New episode today" on a show's resume card, when that is why it is worth opening. */
  private chipFor(seriesId: string): string {
    const news = this.showNews().get(seriesId) ?? null;
    // A weekday names a day only within the week ahead.
    const soon = news?.kind === 'soon' && Date.parse(news.date) - Date.parse(localToday(new Date(this.now()))) < 7 * 86_400_000;
    return news?.kind === 'today' || news?.kind === 'recent' || soon ? newsChip(news) : '';
  }

  /** Favourite channels, each with what is on and its number. */
  readonly liveFavouriteRows = computed(() =>
    this.liveFavourites().map(favourite => ({
      favourite,
      onNow: this.onNowFor(favourite.stream.stream_id),
      number: this.number(favourite.stream)
    }))
  );

  private onNowFor(streamId: string | number): ProgrammeOnNow | null {
    return programmeOnNow(this.guideRows()[String(streamId)], this.now());
  }

  private remaining(entry: WatchProgress): string {
    return remainingLabel(entry);
  }

  private when(entry: WatchProgress): string {
    return watchedWhen(entry.updatedAt, new Date(this.now()));
  }

  /** "23 min left · last night". */
  private leftAndWhen(entry: WatchProgress): string {
    return [this.remaining(entry), this.when(entry)].filter(Boolean).join(' · ');
  }

  // --- What OK does ------------------------------------------------------------

  /**
   * Continue watching: a film or channel from where it was left; a show's
   * page, opened on what is next in it and nothing started.
   */
  resume(entry: WatchProgress): void {
    if (entry.type === 'series') {
      void this.router.navigate(['/series', showOf(entry)], { queryParams: { name: entry.name } });
      return;
    }
    this.playIn(entry.type, entry.itemId, entry.name, entry.icon ?? '', 'recent');
  }

  /** On now, and the favourites: play that channel or film, open that show. */
  openFavourite(favourite: Favourite): void {
    const { type, stream } = favourite;
    if (type === 'series') {
      void this.router.navigate(['/series', stream.stream_id], { queryParams: { name: stream.name } });
      return;
    }
    this.playIn(type, String(stream.stream_id), stream.name, stream.stream_icon ?? '', 'favourite');
  }

  /** A film opens its own page, as a film card does everywhere else (TV-27); a show its page. */
  openAdded(item: Added): void {
    if (item.type === 'series') {
      void this.router.navigate(['/series', item.stream.stream_id], { queryParams: { name: item.stream.name } });
      return;
    }
    void this.router.navigate(['/film', `s${item.stream.stream_id}`], {
      queryParams: { name: item.stream.name },
      state: { film: { name: item.stream.name, poster: item.stream.stream_icon ?? '' } }
    });
  }

  private playIn(type: StreamType, itemId: string, name: string, icon: string, kind: string): void {
    const path = type === 'live' ? '/tv' : type === 'vod' ? '/movies' : '/shows';
    void this.router.navigate([path], { queryParams: { play: itemId, kind, name, icon, return: 1 } });
  }

  // --- Ways in --------------------------------------------------------------

  /** Whether "Browse the guide" is waiting for the first category, to say so when that takes long. */
  readonly openingGuide = signal(false);

  browseGuide(): void {
    if (this.openingGuide()) {
      return;
    }
    this.openingGuide.set(true);
    this.xtream.getCategories('live').subscribe({
      next: categories => {
        this.openingGuide.set(false);
        void this.router.navigate(['/tv'], categories[0] ? { queryParams: { category: categories[0].category_id } } : {});
      },
      error: () => {
        this.openingGuide.set(false);
        void this.router.navigate(['/tv']);
      }
    });
  }

  go(path: string): void {
    void this.router.navigate([path]);
  }

  moreFavourites(): void {
    const first = this.favourites()[0]?.type ?? 'live';
    const path = first === 'live' ? '/tv' : first === 'vod' ? '/movies' : '/shows';
    void this.router.navigate([path], { queryParams: { category: '__favorites__' } });
  }

  // --- Search everything ------------------------------------------------------

  /**
   * The Search tile: the search page, on Everything.
   *
   * It opened a field here, and before that the results were drawn here too.
   * Search is in the menu on every device now (round 11), and the tile stays
   * as a second way in.
   */
  openSearch(): void {
    void this.router.navigate(['/search']);
  }

  // --- The actions panel ------------------------------------------------------

  readonly menu = signal<MenuTarget | null>(null);
  private menuFrom: HTMLElement | null = null;

  openMenu(target: MenuTarget): void {
    this.menuFrom = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.menu.set(target);
  }

  closeMenu(): void {
    const back = this.menuFrom;
    this.menuFrom = null;
    this.menu.set(null);
    setTimeout(() => back?.isConnected && back.focus({ preventScroll: true }));
  }

  /** The film the panel is open about, for its description; null for anything else. */
  readonly menuFilm = computed(() => {
    const target = this.menu();
    if (target?.kind === 'recent' && target.entry.type === 'vod') {
      return { streamId: target.entry.itemId, name: target.entry.name };
    }
    if (target?.kind === 'favourite' && target.favourite.type === 'vod') {
      return { streamId: target.favourite.stream.stream_id, name: target.favourite.stream.name };
    }
    if (target?.kind === 'added' && target.item.type === 'vod') {
      return { streamId: target.item.stream.stream_id, name: target.item.stream.name };
    }
    if (target?.kind === 'popular' && target.popular.type === 'vod' && target.popular.versions[0]) {
      return { streamId: target.popular.versions[0].stream_id, name: target.popular.versions[0].name };
    }
    return null;
  });

  readonly menuName = computed(() => {
    const target = this.menu();
    if (!target) return '';
    if (target.kind === 'popular') return target.popular.item.title;
    if (target.kind === 'added') return posterTitle(target.item.stream.name).title;
    return target.kind === 'recent' ? posterTitle(target.entry.name).title : channelDisplay(target.favourite.stream.name).title;
  });

  readonly menuIcon = computed(() => {
    const target = this.menu();
    if (!target) return null;
    if (target.kind === 'popular') return target.popular.poster || null;
    if (target.kind === 'added') return target.item.stream.stream_icon || null;
    return (target.kind === 'recent' ? target.entry.icon : target.favourite.stream.stream_icon) || null;
  });

  /** The film or episode whose subtitles are being chosen, or null. */
  readonly subtitleTarget = signal<{ item: SubtitleItem; name: string } | null>(null);

  readonly menuActions = computed<ItemAction[]>(() => {
    const target = this.menu();
    if (!target) return [];
    if (target.kind === 'popular') {
      return versionActions(target.popular);
    }
    // Recently added: its page, and a star -- what holding OK offers on
    // every other card (31 October: it opened the film instead).
    if (target.kind === 'added') {
      return [
        { id: 'play', icon: 'lucidePlay', label: target.item.type === 'series' ? t('actions.openShow') : t('actions.filmPage') },
        { id: 'star', icon: 'lucideStar', label: t('actions.addFavourite') }
      ];
    }
    if (target.kind === 'recent' && target.entry.type === 'series') {
      return [
        { id: 'play', icon: 'lucidePlay', label: t('actions.openShow') },
        { id: 'forget', icon: 'lucideX', label: t('actions.forget'), danger: true }
      ];
    }
    if (target.kind === 'recent') {
      const live = target.entry.type === 'live';
      const actions: ItemAction[] = [
        { id: 'play', icon: 'lucidePlay', label: live ? t('actions.playLive') : t('actions.resume') }
      ];
      // The film's own page, where all of this is too (19 October).
      if (target.entry.type === 'vod') {
        actions.push({ id: 'page', icon: 'lucideListVideo', label: t('actions.filmPage') });
      }
      // A film or episode somebody is part way through is exactly where they
      // notice it has no subtitles.
      if (!live) {
        actions.push({ id: 'subtitles', icon: 'lucideCaptions', label: t('actions.addSubtitles'), hint: t('actions.fromOpenSubtitles') });
      }
      actions.push({ id: 'forget', icon: 'lucideX', label: t('actions.forget'), danger: true });
      return actions;
    }
    return [
      { id: 'play', icon: 'lucidePlay', label: target.favourite.type === 'series' ? t('actions.openShow') : t('actions.play') },
      ...(target.favourite.type === 'vod' ? [{ id: 'page', icon: 'lucideListVideo', label: t('actions.filmPage') }] : []),
      { id: 'unstar', icon: 'lucideStar', label: t('actions.unstar'), danger: true }
    ];
  });

  onMenuAction(id: string): void {
    const target = this.menu();
    this.closeMenu();
    if (!target) return;

    // Every row of a popular title's panel is one of its copies.
    if (target.kind === 'popular') {
      if (id.startsWith('version:')) {
        openVersion(this.router, target.popular, Number(id.slice('version:'.length)));
      }
      return;
    }

    if (target.kind === 'added') {
      if (id === 'play') {
        this.openAdded(target.item);
      } else if (id === 'star') {
        this.xtream.setFavorite(target.item.stream, target.item.type, true).subscribe(() => {
          this.deviceSync.syncNow();
          this.load();
        });
      }
      return;
    }

    if (id === 'play') {
      if (target.kind === 'recent') {
        this.resume(target.entry);
      } else {
        this.openFavourite(target.favourite);
      }
      return;
    }

    if (id === 'page') {
      const streamId = target.kind === 'recent' ? target.entry.itemId : target.favourite.stream.stream_id;
      void this.router.navigate(['/film', `s${streamId}`]);
      return;
    }

    if (id === 'subtitles' && target.kind === 'recent') {
      const entry = target.entry;
      this.subtitleTarget.set({
        item: {
          type: entry.type === 'series' ? 'series' : 'vod',
          itemId: String(entry.itemId),
          seriesId: entry.seriesId ?? null,
          season: entry.season ?? null,
          episodeNum: entry.episodeNum ?? null,
          name: entry.name
        },
        name: entry.name
      });
      return;
    }

    if (id === 'forget' && target.kind === 'recent' && target.entry.type === 'series') {
      // Taken out until watched again; its history, and so its ticks, stay.
      const hidden = { ...this.hiddenShows(), [showOf(target.entry)]: new Date().toISOString() };
      this.settings.set(SETTING_KEYS.continueHidden, JSON.stringify(hidden));
      return;
    }

    if (id === 'forget' && target.kind === 'recent') {
      const entry = target.entry;
      const itemId = entry.itemId;
      this.xtream.removeProgress(entry.type, itemId).subscribe(() => {
        this.deviceSync.syncNow();
        this.load();
      });
      return;
    }

    if (id === 'unstar' && target.kind === 'favourite') {
      this.xtream.setFavorite(target.favourite.stream, target.favourite.type, false).subscribe(() => {
        this.deviceSync.syncNow();
        this.load();
      });
    }
  }
}
