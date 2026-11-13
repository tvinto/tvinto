import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked
} from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { XtreamService } from '../../services/xtream.service';
import { Episode, SeriesInfo, Stream, WatchProgress } from '@shared/types';
import { PlaybackProgress, VideoPlayerComponent } from '../video-player/video-player.component';
import { SeriesDetailStore } from '../../stores/series-detail.store';
import { BackButtonService } from '../../services/back-button.service';
import { EpisodeRun, NativePlayerService, PlaybackCheckpoint } from '../../services/native-player.service';
import { NativePlayResult } from '../../services/native/nativePlayer';
import { ProgressEntry } from '../../utils/playback-checkpoint.utils';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { DeviceSyncService } from '../../services/device-sync.service';
import { ToastService } from '../../services/toast.service';
import { describePlaybackFailure, withoutAddresses } from '../../utils/failure-messages.utils';
import { searchWordsFor } from '../../utils/other-versions.utils';
import { COPY_SWITCH_PAUSE_MS, CopyFallbackService } from '../../services/copy-fallback.service';
import { PlatformService } from '../../services/platform.service';
import { IntroSkipsService } from '../../services/intro-skips.service';
import { Skip } from '@shared/tmdb/introdb';
import { AheadEpisode, EpisodesAhead, FilmPresentation, ListedEpisode, ShowSeasons, bySeason, episodePresentation, episodesAfter } from '../../utils/film-presentation.utils';
import { firstValueFrom } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideCaptions,
  lucideCheck,
  lucideChevronRight,
  lucideEllipsis,
  lucideInfo,
  lucideListVideo,
  lucideLoaderCircle,
  lucidePlay,
  lucideStar,
  lucideX
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { FocusScopeDirective } from '../../directives/focus-scope.directive';
import { MarqueeDirective } from '../../directives/marquee.directive';
import { SubtitlePickerComponent } from '../subtitle-picker/subtitle-picker.component';
import { SubtitleItem } from '../../services/subtitle-library.service';
import {
  NextUp,
  SeriesFacts,
  episodeLabel,
  episodeMinutes,
  flattenEpisodes,
  formatTimecode,
  isComplete,
  nextUp,
  remainingLabel,
  resumePosition,
  posterTitle,
  seriesFacts,
  shortEpisodeTitle,
  watchedPercent
} from '../../utils';
import { t } from '../../utils/i18n';
import { TPipe } from '../../pipes/t.pipe';
import { DescriptionsService } from '../../services/descriptions.service';
import { ShowPage, ShowService } from '../../services/show.service';
import { AgeLockService } from '../../services/age-lock.service';
import { SlowWaitComponent } from '../slow-wait/slow-wait.component';
import { TrailerService } from '../../services/trailer.service';
import { FilmLink } from '../../services/film.service';
import { copyLabel } from '../film/film.component';
import { TMDB_LOGO } from '../description-settings/description-settings.component';
import { newsLine } from '../../utils/show-news.utils';
import { DescriptionReaderService } from '../description-reader/description-reader.component';
import { CardGesturesDirective } from '../../directives/card-gestures.directive';
import { CutOffDirective } from '../../directives/cut-off.directive';
import { ItemAction, ItemActionsComponent } from '../item-actions/item-actions.component';
import { ChosenDescription } from '@shared/tmdb/describe';

/** Episodes handed to the player at once; it is given more as it goes on to each. */
const EPISODES_AHEAD = 5;

/** How many other copies of a show are looked into for an episode that failed: each costs a request. */
const MOST_SHOWS_LOOKED_AT = 3;

/** The episode with this season and number in a show's list, if it has one. */
function episodeAt(info: SeriesInfo, season: number, number: number): Episode | null {
  for (const [key, list] of Object.entries(info.episodes ?? {})) {
    for (const episode of Array.isArray(list) ? list : []) {
      if (Number(episode.season ?? key) === season && Number(episode.episode_num) === number) {
        return episode;
      }
    }
  }
  return null;
}

@Component({
  selector: 'app-series-detail',
  imports: [
    SlowWaitComponent, TPipe,
    VideoPlayerComponent,
    NgIcon,
    HlmButton,
    FocusScopeDirective,
    MarqueeDirective,
    SubtitlePickerComponent,
    CardGesturesDirective,
    CutOffDirective,
    ItemActionsComponent
  ],
  standalone: true,
  providers: [
    SeriesDetailStore,
    provideIcons({
      lucideArrowLeft,
      lucideCaptions,
      lucideCheck,
      lucideChevronRight,
      lucideEllipsis,
      lucideInfo,
      lucideListVideo,
      lucideLoaderCircle,
      lucidePlay,
      lucideStar,
      lucideX
    })
  ],
  templateUrl: './series-detail.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SeriesDetailComponent implements OnInit {
  readonly store = inject(SeriesDetailStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly xtreamService = inject(XtreamService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly back = inject(BackButtonService);
  private readonly nativePlayer = inject(NativePlayerService);
  readonly tv = inject(TvNavigationService);
  private readonly deviceSync = inject(DeviceSyncService);
  private readonly toasts = inject(ToastService);
  private readonly copies = inject(CopyFallbackService);
  private readonly introSkips = inject(IntroSkipsService);
  private readonly platform = inject(PlatformService);

  /** An episode to play as soon as the list arrives: another copy's, after the one asked for failed. */
  private readonly copyEpisode = signal<{ season: number; episode: number; at: number; line: string | null } | null>(null);

  /** What the next player's opening panel says about why it opened. */
  private copyOpeningLine: string | null = null;

  seriesId = signal<string>('');
  seriesName = signal<string>('');

  /** Where every episode of this show was left, keyed by episode id. */
  readonly progressByEpisode = signal<Record<string, WatchProgress>>({});

  /** Set when arriving from a "continue watching" card, which plays on arrival. */
  private readonly autoResume = signal<boolean>(false);

  /** Whether the stored positions have come back, empty or not. */
  private readonly progressLoaded = signal<boolean>(false);

  /** What the "continue" button will play: the part-watched episode, or the next. */
  readonly nextUp = computed<NextUp | null>(() =>
    nextUp(flattenEpisodes(this.store.seriesInfo()?.episodes), this.progressByEpisode())
  );

  /**
   * The season's episodes as drawn: label, title, how far watched, the
   * caption, the picture, the "next" tag and the description. Worked out when
   * the season, the progress or the descriptions change, not per row at
   * every check.
   */
  readonly episodeRows = computed(() =>
    this.store.currentSeasonEpisodes().map(episode => {
      const percent = this.percentWatched(episode);
      const watched = this.isWatched(episode);
      return {
        episode,
        label: this.labelFor(episode),
        title: this.titleOf(episode),
        percent,
        watched,
        resumable: percent > 0 && !watched,
        caption: this.episodeCaption(episode),
        thumbnail: this.thumbnailOf(episode),
        tag: this.nextTag(episode),
        description: this.descriptionOf(episode)
      };
    })
  );

  /** The card above Continue, while an episode is part-way through. */
  readonly nextView = computed(() => {
    const next = this.nextUp();
    return next
      ? {
          next,
          label: this.labelFor(next.episode),
          title: this.titleOf(next.episode),
          percent: this.percentWatched(next.episode),
          remaining: this.remaining(next.episode)
        }
      : null;
  });

  /** Poster, synopsis, year, genre and rating, from whichever shape the info came in. */
  /**
   * The show's details, once they are this show's. A show opened from another's
   * "More like this" has its id at once and the first show's details for a
   * moment; looked up with both, the first show's banner went on the second,
   * and the second's on the first on the way back (a user's TV, 24
   * October). Everything that works from the details reads them here.
   */
  private readonly infoHere = computed(() => (this.store.loadedId() === this.seriesId() ? this.store.seriesInfo() : null));

  readonly facts = computed<SeriesFacts>(() => seriesFacts(this.infoHere()));

  private readonly descriptions = inject(DescriptionsService);

  /**
   * The show's description: the provider's, or TMDB's in the language the
   * account chose. The provider's until the answer comes.
   */
  readonly showDescription = signal<ChosenDescription | null>(null);

  /** The season's episode descriptions, by episode number. */
  readonly episodeDescriptions = signal<ReadonlyMap<number, ChosenDescription>>(new Map());

  readonly plot = computed(() => this.showDescription() ?? (this.facts().plot ? { text: this.facts().plot, source: 'provider' as const } : null));

  // --- What TMDB adds (round 6, TV-29) ------------------------------------------

  private readonly shows = inject(ShowService);
  readonly ages = inject(AgeLockService);

  /** Asks the provider for the episodes again, after a wait that went on too long. */
  reloadShow(): void {
    if (this.seriesId()) {
      this.store.loadSeriesInfo(this.seriesId());
    }
  }
  private readonly trailers = inject(TrailerService);

  trailer(): void {
    const show = this.tmdbShow();
    if (show) {
      this.trailers.open(show.title, show.trailers);
    }
  }

  /** The show's ratings, while the age lock is on, so the page can say it is locked. */
  private readonly learnRating = effect(() => {
    const id = this.tmdbShow()?.tmdbId;
    if (id && this.ages.engaged()) {
      untracked(() => void this.ages.learn('tv', [id]));
    }
  });
  readonly logo = TMDB_LOGO;
  readonly copyLabel = copyLabel;
  /** TMDB's side of the page; null without a key, or for a show TMDB does not know. */
  readonly tmdbShow = signal<ShowPage | null>(null);
  /** TMDB's recommendations kept to the library; shown only when there are enough. */
  readonly moreLikeThis = signal<FilmLink[]>([]);

  private readonly loadShowPage = effect(() => {
    const info = this.infoHere();
    const id = this.seriesId();
    const name = this.knownName();
    this.tmdbShow.set(null);
    this.moreLikeThis.set([]);
    if (!info || !id) {
      return;
    }
    untracked(() => {
      void this.shows
        .forSeries(id, name, info)
        .then(page => {
          if (this.store.seriesInfo() !== info || this.seriesId() !== id || !page) {
            return;
          }
          this.tmdbShow.set(page);
          void this.shows.moreLikeThis(page).then(links => this.store.seriesInfo() === info && this.moreLikeThis.set(links));
          void this.copiesOnceLibraryArrives(id, name, info);
        })
        .catch(() => undefined);
    });
  });

  /**
   * On a device that has never held its show library, the page found only the
   * copies in categories already opened: the library is downloaded once, as a
   * search would, and the copies fill in (as the film page does).
   */
  private async copiesOnceLibraryArrives(id: string, name: string, info: unknown): Promise<void> {
    if (!(await this.xtreamService.fetchLibraryIfNeverHeld('series').catch(() => false))) {
      return;
    }
    this.shows.forget(id);
    const again = await this.shows.forSeries(id, name, info).catch(() => null);
    if (again && this.store.seriesInfo() === info && this.seriesId() === id) {
      this.tmdbShow.set(again);
    }
  }

  /** The copy of the show this page is, as the copy button names it. */
  readonly currentCopy = computed(() => this.tmdbShow()?.copies.find(copy => String(copy.stream.stream_id) === String(this.seriesId())) ?? null);

  /** The line about the next episode (TV-29). */
  readonly newsLine = computed(() => newsLine(this.tmdbShow()?.news ?? null));

  /** The copies of the show, to choose which one episodes play in (TV-28's page, for a show). */
  openCopies(): void {
    void this.router.navigate(['/series', this.seriesId(), 'copies']);
  }

  /** A recommended show opens the copy the person's languages, or their choice, prefer. */
  async openLink(link: FilmLink): Promise<void> {
    const copy = await this.shows.preferredCopy(link.item);
    if (copy) {
      void this.router.navigate(['/series', copy.stream_id], { queryParams: { name: copy.name } });
    }
  }

  private readonly describeShow = effect(() => {
    const info = this.infoHere();
    const name = this.knownName();
    this.descriptions.language();
    this.showDescription.set(null);
    if (!info) {
      return;
    }
    untracked(() => {
      void this.descriptions
        .show(info, name)
        .then(found => {
          if (this.store.seriesInfo() === info) {
            this.showDescription.set(found);
          }
        })
        .catch(() => undefined);
    });
  });

  private readonly describeEpisodes = effect(() => {
    const info = this.infoHere();
    const episodes = this.store.currentSeasonEpisodes();
    const name = this.knownName();
    this.descriptions.language();
    this.episodeDescriptions.set(new Map());
    if (!info || !episodes.length) {
      return;
    }
    const season = Number(episodes[0].season);
    const ownWords = new Map(
      episodes.map(episode => {
        const details = (episode.info ?? {}) as { plot?: unknown; description?: unknown };
        const words = typeof details.plot === 'string' ? details.plot : typeof details.description === 'string' ? details.description : '';
        return [Number(episode.episode_num), words.trim()] as const;
      })
    );
    untracked(() => {
      void this.descriptions
        .episodes(info, name, season, ownWords)
        .then(found => {
          if (this.store.currentSeasonEpisodes() === episodes) {
            this.episodeDescriptions.set(found);
            // The cards just grew by two lines each; on a television the one
            // in focus can now run off the bottom of the screen.
            if (this.tv.isTelevision()) {
              requestAnimationFrame(() =>
                (document.activeElement as HTMLElement | null)
                  ?.closest<HTMLElement>('[data-show-episode]')
                  ?.scrollIntoView({ block: 'nearest' })
              );
            }
          }
        })
        .catch(() => undefined);
    });
  });

  private readonly reader = inject(DescriptionReaderService);

  readShow(described: ChosenDescription): void {
    this.reader.open({ title: this.displayName(), text: described.text, source: described.source });
  }

  /** An episode's description, whole: held on a phone or a television, the button with a pointer. */
  readEpisode(episode: Episode): void {
    const described = this.descriptionOf(episode);
    if (described) {
      this.reader.open({
        title: this.displayName(),
        subtitle: `${this.labelFor(episode)} · ${this.titleOf(episode)}`,
        text: described.text,
        source: described.source
      });
    }
  }

  /** "Continue" on the episode part-watched, "Up next" on the one to start; nothing on the rest. */
  private nextTag(episode: Episode): string {
    const next = this.nextUp();
    if (!next || String(next.episode.id) !== String(episode.id)) {
      return '';
    }
    return t(next.resuming ? 'show.continueTag' : 'show.upNextTag');
  }

  /** An episode's description, or null. */
  private descriptionOf(episode: Episode): ChosenDescription | null {
    return this.episodeDescriptions().get(Number(episode.episode_num)) ?? null;
  }

  /** The episode whose subtitles are being chosen, or null (stage 4). */
  readonly subtitleTarget = signal<{ item: SubtitleItem; name: string } | null>(null);

  /** "Subtitles" on an episode row: the show's id and this episode's numbers. */
  addSubtitles(episode: Episode): void {
    this.subtitleTarget.set({
      item: {
        type: 'series',
        itemId: String(episode.id),
        seriesId: String(this.seriesId()),
        season: episode.season,
        episodeNum: episode.episode_num,
        name: this.store.seriesInfo()?.name ?? ''
      },
      name: this.store.seriesInfo()?.name ?? ''
    });
  }

  /** "2016 · Drama · 3 seasons · 34 episodes", leaving out what is unknown. */
  readonly metaLine = computed(() => {
    const seasons = this.store.availableSeasons().length;
    const episodes = flattenEpisodes(this.store.seriesInfo()?.episodes).length;
    const facts = this.facts();
    // TMDB's, in the account's language, over the provider's own: the
    // owner's Supernatural read "Drame · Mystère" on an English page (31 October).
    const genre = this.tmdbShow()?.genres.slice(0, 2).join(', ') || facts.genre;
    return [
      facts.year,
      genre,
      seasons ? t('show.seasons', { count: seasons }) : '',
      episodes ? t('show.episodes', { count: episodes }) : ''
    ]
      .filter(Boolean)
      .join(' · ');
  });

  /** Whether the poster failed to load, so the monogram takes its place. */
  readonly coverFailed = signal(false);

  /** Episodes whose own picture would not load, drawn as a numbered plate instead. */
  private readonly brokenThumbnails = signal<ReadonlySet<string>>(new Set());

  /** The episode's own picture, where the provider has one that loads. */
  private thumbnailOf(episode: Episode): string | null {
    const picture = episode.info?.movie_image?.trim();
    return picture && !this.brokenThumbnails().has(String(episode.id)) ? picture : null;
  }

  thumbnailFailed(episode: Episode): void {
    this.brokenThumbnails.update(broken => new Set(broken).add(String(episode.id)));
  }

  readonly ratingDots = [1, 2, 3, 4, 5];

  /** Whether this show is starred, for the chip under its rating (D-5). */
  readonly isFavourite = signal(false);

  toggleFavourite(): void {
    const next = !this.isFavourite();
    this.isFavourite.set(next);
    const show = {
      stream_id: String(this.seriesId()),
      name: this.knownName(),
      icon: this.facts().cover,
      stream_icon: this.facts().cover
    } as Stream;
    this.xtreamService.setFavorite(show, 'series', next).subscribe({
      // As the section does: keeps this device's cursor past its own write.
      next: () => this.deviceSync.syncNow(),
      error: () => this.isFavourite.set(!next)
    });
  }

  /** "3 Body Problem" rather than the provider's "EX - 3 Body Problem (2024)"; the year is in the facts. */
  /**
   * The show's name: the one it was opened with, else the provider's own. Opened
   * without one -- by address, or a link -- the page was headed "Series" and the
   * episodes kept the provider's "EN - Friends (1994) (US) - S01E01 -".
   */
  readonly knownName = computed(() => {
    // The provider answers with the show's details under `info`, not at the top.
    const info = this.store.seriesInfo() as { name?: string; info?: { name?: string } } | null;
    return this.seriesName() || info?.info?.name || info?.name || t('show.series');
  });

  readonly displayName = computed(() => posterTitle(this.knownName()).title);

  // Video player state
  showPlayer = signal<boolean>(false);
  currentStreamUrl = signal<string>('');
  currentStreamName = signal<string>('');
  resumeAt = signal<number>(0);
  private readonly playingEpisode = signal<Episode | null>(null);

  constructor() {
    const moved = (event: KeyboardEvent) => {
      if (event.key.startsWith('Arrow') || event.key === 'Enter') {
        this.movedSinceOpening = true;
      }
    };
    document.addEventListener('keydown', moved, true);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', moved, true));

    // Back closes the player before it leaves the page.
    this.back.bindTo(this.showPlayer, () => this.closePlayer());
    this.back.bindTo(this.moreOpen, () => this.closeMore());

    // Resuming needs both halves: the episode list, which comes from the
    // provider, and the stored positions, which come from local disk and
    // almost always arrive first. Acting on whichever landed earlier meant
    // deciding what to play next from an empty episode list, and playing
    // nothing at all.
    effect(() => {
      const info = this.infoHere();
      const ready = this.autoResume() && this.progressLoaded() && !!info;
      if (!ready) {
        return;
      }
      untracked(() => {
        this.autoResume.set(false);
        this.continueWatching();
      });
    });

    // Another copy's episode, once this copy's list has arrived.
    effect(() => {
      const wanted = this.copyEpisode();
      const info = this.infoHere();
      if (!wanted || !info) {
        return;
      }
      untracked(() => {
        this.copyEpisode.set(null);
        const episode = episodeAt(info, wanted.season, wanted.episode);
        if (episode) {
          this.copyOpeningLine = wanted.line;
          this.playEpisode(episode, wanted.at);
        }
      });
    });
  }

  /**
   * A show opens where it was left: the season of the episode up next, and on
   * a television focus on that episode's row.
   *
   * It opened on season 1 with focus on whatever was drawn first -- the S1
   * tab, for a show watched to S4 E13 (26 September). Once per
   * show, once both the episodes and the positions are in, and not if the
   * person has already moved: by then they have chosen where to be.
   */
  private readonly openWhereLeft = effect(() => {
    const ready = this.progressLoaded() && !!this.infoHere() && !this.store.loading();
    if (!ready || this.openedAt === this.seriesId()) {
      return;
    }
    this.openedAt = this.seriesId();
    untracked(() => {
      const next = this.nextUp();
      const season = next ? this.seasonOf(next.episode) : null;
      if (season && season !== this.store.selectedSeason()) {
        this.store.selectSeason(season);
      }
      // On every device, not only a television: arriving from Continue
      // watching is arriving at the show to carry on with it (a user,
      // 2 October), and the episode to carry on with is the one to be on.
      setTimeout(() => this.focusEpisode(next ? 'show-start' : null));
    });
  });

  /** The show last opened where it was left, so a return from the player does not do it again. */
  private openedAt: string | null = null;

  /** Whether a key has been pressed since this page opened. */
  private movedSinceOpening = false;

  private focusEpisode(key: string | null): void {
    if (this.movedSinceOpening) {
      return;
    }
    const row =
      (key ? document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) : null) ??
      document.querySelector<HTMLElement>('[data-show-episode]');
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  }

  /** The season an episode is listed under. */
  private seasonOf(episode: Episode): string | null {
    const episodes = this.store.seriesInfo()?.episodes ?? {};
    for (const [season, list] of Object.entries(episodes)) {
      if ((list as Episode[]).some(one => String(one.id) === String(episode.id))) {
        return season;
      }
    }
    return episode.season != null ? String(episode.season) : null;
  }

  ngOnInit() {
    this.route.queryParams.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(queryParams => {
      this.seriesName.set(queryParams['name'] || '');
      this.autoResume.set(queryParams['resume'] === '1' || queryParams['resume'] === 1);
      // Sent here by another copy of the show whose episode did not play.
      const [season, episode] = String(queryParams['episode'] ?? '').split(':').map(Number);
      if (season >= 0 && episode > 0) {
        const line = (history.state as { openingLine?: unknown } | null)?.openingLine;
        this.copyEpisode.set({ season, episode, at: Number(queryParams['at']) || 0, line: typeof line === 'string' ? line : null });
      }
    });

    this.route.params.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const id = String(params['id'] ?? '');
      this.seriesId.set(id);

      if (!id) {
        return;
      }

      this.store.loadSeriesInfo(id);
      this.loadProgress();
      this.xtreamService
        .getFavoriteIds('series')
        .subscribe({ next: ids => this.isFavourite.set(ids.map(String).includes(String(id))), error: () => {} });
    });
  }

  private loadProgress(): void {
    this.xtreamService.getSeriesProgress(this.seriesId()).subscribe(progress => {
      this.progressByEpisode.set(progress);
      // The effect above decides whether this completes an auto-resume.
      this.progressLoaded.set(true);
    });
  }

  selectSeason(season: string) {
    this.store.selectSeason(season);
  }

  /** Plays whatever `nextUp` decided, at wherever it decided. */
  continueWatching(): void {
    const next = this.nextUp();
    if (next) {
      this.playEpisode(next.episode, next.resumeAt);
    }
  }

  /**
   * Plays an episode.
   *
   * With no explicit position it uses the stored one, so clicking an episode
   * you were part way through picks up rather than restarting -- the same rule
   * whether you arrive from the continue button or the grid.
   */
  playEpisode(episode: Episode, startAt?: number) {
    if (!this.xtreamService.isAuthenticated()) {
      return;
    }
    // A show rated over the age lock asks for the PIN first (TV-31).
    if (this.ages.engaged()) {
      const name = this.knownName();
      void this.ages
        .mayPlayShow(this.store.seriesInfo(), name, posterTitle(name).title || name)
        .then(open => open && this.startEpisode(episode, startAt));
      return;
    }
    this.startEpisode(episode, startAt);
  }

  private startEpisode(episode: Episode, startAt?: number) {

    const extension = episode.container_extension || 'mp4';
    const from = startAt ?? resumePosition(this.progressFor(episode));

    this.xtreamService.getPlaybackUrl('series', episode.id, extension).subscribe({
      next: streamUrl => {
        const title = [this.knownName(), this.labelFor(episode), this.titleOf(episode)]
          .filter(Boolean)
          .join(' · ');

        this.playingEpisode.set(episode);
        this.resumeAt.set(from);
        this.currentStreamUrl.set(streamUrl);
        this.currentStreamName.set(title);

        void this.playNativelyOrInPage(streamUrl, title, from, String(episode.id), episode);
      },
      error: err => console.error('Failed to start playback', err)
    });
  }

  /**
   * Hands the episode to the platform player when there is one.
   *
   * The same arrangement as the section view: the Activity takes the whole
   * screen, so the modal never opens, and the position it reports on the way
   * back is recorded exactly as the in-page player's would have been.
   */
  private async playNativelyOrInPage(
    url: string,
    title: string,
    startAt: number,
    episodeId: string,
    episode: Episode
  ): Promise<void> {
    const openingLine = this.copyOpeningLine ?? undefined;
    this.copyOpeningLine = null;
    const skips = await this.skipsOf(episode);
    const result = await this.nativePlayer.play({
      url,
      title,
      startAtSeconds: startAt,
      openingLine,
      skips,
      // Named so the subtitle chosen for this episode is there next time.
      item: { type: "series", id: episodeId, showId: String(this.seriesId()) },
      presentation: this.presentationOf(episode),
      checkpoint: this.checkpointFrom(episode),
      // The next episode plays in the same player (PL-TV-6b).
      episodes: this.episodeRun()
    });

    if (!result) {
      this.showPlayer.set(true);
      return;
    }

    if (!result.errorCode) {
      this.copies.played({ stream_id: this.seriesId(), name: this.knownName() });
    } else if (await this.triedAnotherCopy(episode, result, startAt)) {
      this.playingEpisode.set(null);
      return;
    }

    if (result.errorCode) {
      const said = describePlaybackFailure(result.errorCode, t('show.thisEpisode'));
      this.toasts.error(said.title, said.message, { detail: said.detail });
    }

    // After going on to later episodes inside the player, the one on screen at
    // the end is the one whose position came back.
    const last = flattenEpisodes(this.store.seriesInfo()?.episodes).find(one => String(one.id) === result.itemId);
    if (last) {
      this.playingEpisode.set(last);
    }

    if (result.played) {
      this.onPlaybackProgress({
        positionSeconds: result.positionSeconds,
        durationSeconds: result.durationSeconds
      });
    }

    this.playingEpisode.set(null);
    // The grid behind is now wrong about the episode just watched.
    this.loadProgress();
  }

  /**
   * After an episode failed to start, opens the same episode in another copy
   * of the show, from the same place, and says why on the player's opening
   * panel (a notice on the desktop). True when it did.
   *
   * The rules are the films' (CopyFallbackService). The difference is that
   * another copy of a show may not have this episode, which only its own list
   * says: each copy considered costs one request to the provider, so no more
   * than three are looked at.
   */
  private async triedAnotherCopy(episode: Episode, result: NativePlayResult, startAt: number): Promise<boolean> {
    const show = this.currentCopy()?.stream ?? ({ stream_id: this.seriesId(), name: this.knownName() } as Stream);
    const season = Number(episode.season ?? this.store.selectedSeason());
    const number = Number(episode.episode_num);
    if (!(season >= 0) || !(number > 0)) {
      return false;
    }
    const candidates = await this.showCopies(show);
    for (let looked = 0; looked < MOST_SHOWS_LOOKED_AT; looked++) {
      const next = this.copies.next(show, candidates, result, startAt);
      if (!next) {
        return false;
      }
      const info = await firstValueFrom(this.xtreamService.getSeriesInfo(next.stream_id)).catch(() => null);
      if (!info || !episodeAt(info, season, number)) {
        this.copies.passOver(next);
        continue;
      }
      console.info(`An episode did not play (${withoutAddresses(result.errorCode ?? '')}); trying another copy of the show`);
      const said = t('player.tryingCopy', { name: next.name });
      if (this.platform.platform === 'electron') {
        this.toasts.info(t('player.copyFailed'), said);
      }
      // A moment between one request to the provider and the next.
      await new Promise(resolve => setTimeout(resolve, COPY_SWITCH_PAUSE_MS));
      void this.router.navigate(['/series', next.stream_id], {
        queryParams: { name: next.name, episode: `${season}:${number}`, at: Math.floor(Math.max(startAt, result.positionSeconds || 0)) },
        state: { openingLine: said }
      });
      return true;
    }
    return false;
  }

  /** The other copies of the show: the ones its page found, and any the library's search finds. */
  private async showCopies(show: Stream): Promise<Stream[]> {
    const listed = this.tmdbShow()?.copies.map(copy => copy.stream) ?? [];
    const words = searchWordsFor(show.name);
    const found = words.length < 2 ? [] : await firstValueFrom(this.xtreamService.searchStreams(words, 'series', 100)).catch(() => []);
    const seen = new Set<string>();
    return [...listed, ...found].filter(copy => !seen.has(String(copy.stream_id)) && !!seen.add(String(copy.stream_id)));
  }

  /**
   * Records where the episode got to.
   *
   * The show's id rides along on every write: it is what groups these episodes
   * into one entry in "continue watching", and what lets the next episode be
   * worked out later.
   */
  onPlaybackProgress(progress: PlaybackProgress): void {
    const episode = this.playingEpisode();
    if (episode) {
      this.saveProgressFor(episode, progress);
    }
  }

  private saveProgressFor(episode: Episode, progress: PlaybackProgress): void {
    this.xtreamService
      .saveProgress({ ...this.progressEntry(episode), positionSeconds: progress.positionSeconds, durationSeconds: progress.durationSeconds })
      .subscribe();
  }

  /** What the history keeps about an episode, apart from how far it got. */
  private progressEntry(episode: Episode): ProgressEntry {
    return {
      type: 'series',
      itemId: String(episode.id),
      seriesId: String(this.seriesId()),
      season: Number(episode.season ?? this.store.selectedSeason()) || null,
      episodeNum: Number(episode.episode_num) || null,
      name: this.knownName(),
      episodeTitle: episode.title || null,
      // The show's poster: history names the show, not the episode, wherever
      // it is shown (Continue watching, 2 October).
      icon: this.facts().cover || episode.info?.movie_image || null,
      containerExtension: episode.container_extension || null
    };
  }

  /**
   * Saving an episode's progress while it plays, not only at the end
   * (PlaybackCheckpoint): every episode of the show, since Episodes in the
   * player (PX-TV-3) can go to any of them.
   */
  private checkpointFrom(episode: Episode): PlaybackCheckpoint {
    const all = flattenEpisodes(this.store.seriesInfo()?.episodes);
    const reachable = all.some(one => String(one.id) === String(episode.id)) ? all : [episode];
    return {
      entries: () => Object.fromEntries(reachable.map(one => [String(one.id), this.progressEntry(one)])),
      reached: (itemId, positionSeconds, durationSeconds) => {
        const now = reachable.find(one => String(one.id) === itemId);
        if (now) {
          this.saveProgressFor(now, { positionSeconds, durationSeconds });
        }
      }
    };
  }

  /** What the player's controls say about an episode. */
  private presentationOf(episode: Episode): FilmPresentation {
    return {
      ...episodePresentation(this.knownName(), this.labelFor(episode), this.titleOf(episode), episode.info?.movie_image || this.facts().cover),
      // The episode's own, else the show's: a long pause says what is paused (PX-TV-8).
      description: this.descriptionOf(episode)?.text || this.plot()?.text || undefined
    };
  }

  /**
   * The episodes that follow, for the player to go on to by itself: the next
   * few with their addresses, and whether the season ends there. Within the
   * season only (episodesAfter, tested).
   */
  private episodeRun(): EpisodeRun {
    const episodes = flattenEpisodes(this.store.seriesInfo()?.episodes);
    const show = this.displayName();
    return {
      ahead: async (itemId: string): Promise<EpisodesAhead> => {
        const { next, endOfSeason } = episodesAfter(episodes, itemId, EPISODES_AHEAD);
        const ahead = await Promise.all(next.map(episode => this.aheadOf(episode, show)));
        const end = endOfSeason === undefined
          ? undefined
          : [show, endOfSeason === null ? t('show.endOfSeason') : t('show.endOfSeasonN', { season: endOfSeason })].filter(Boolean).join(' · ');
        return { ahead, end };
      },
      left: (itemId: string, positionSeconds: number, durationSeconds: number) => {
        const left = episodes.find(one => String(one.id) === itemId);
        if (left && positionSeconds > 0) {
          this.saveProgressFor(left, { positionSeconds, durationSeconds });
        }
      },
      seasons: async (): Promise<ShowSeasons> => ({
        seasons: await Promise.all(
          bySeason(episodes).map(async ({ season, episodes: inSeason }) => ({
            label: season === null ? t('show.episodesHeading') : t('show.season', { season }),
            end: [show, season === null ? t('show.endOfSeason') : t('show.endOfSeasonN', { season })].filter(Boolean).join(' · '),
            episodes: await Promise.all(inSeason.map(episode => this.listedOf(episode, show)))
          }))
        )
      })
    };
  }

  /** One episode as the player's Episodes lists it (PX-TV-3): its card, and where OK starts it. */
  private async listedOf(episode: Episode, show: string): Promise<ListedEpisode> {
    const minutes = episodeMinutes(episode.info);
    const progress = this.progressFor(episode);
    return {
      ...(await this.aheadOf(episode, show)),
      number: episode.episode_num !== undefined && episode.episode_num !== null ? String(episode.episode_num) : '',
      name: this.titleOf(episode),
      length: minutes ? t('common.min', { count: minutes }) : '',
      watched: isComplete(progress) ? 1 : watchedPercent(progress) / 100,
      startAtSeconds: resumePosition(progress)
    };
  }

  /** One episode as the player's controls and card name it, with its address. */
  private async aheadOf(episode: Episode, show: string): Promise<AheadEpisode> {
    const url = await firstValueFrom(
      this.xtreamService.getPlaybackUrl('series', episode.id, episode.container_extension || 'mp4')
    );
    const presentation = this.presentationOf(episode);
    const label = episode.episode_num !== undefined && episode.episode_num !== null ? `E${episode.episode_num}` : '';
    const title = this.titleOf(episode);
    const skips = await this.skipsOf(episode);
    return {
      itemId: String(episode.id),
      url,
      showName: presentation.heading ?? show,
      title: presentation.title,
      cardHeading: [show, episode.season !== undefined && episode.season !== null ? `S${episode.season}` : ''].filter(Boolean).join(' · '),
      cardTitle: [label, title === t('show.episode', { number: episode.episode_num }) && label ? '' : title].filter(Boolean).join(' · '),
      label,
      poster: presentation.poster ?? null,
      description: presentation.description,
      skips: skips.length ? skips : undefined
    };
  }

  /** An episode's intro, recap and credits from TheIntroDB, when TMDB knows the show; [] otherwise or if slow. */
  private skipsOf(episode: Episode): Promise<Skip[]> {
    const minutes = episodeMinutes(episode.info);
    return this.introSkips.forEpisode(
      this.tmdbShow()?.tmdbId,
      Number(episode.season ?? this.store.selectedSeason()),
      Number(episode.episode_num),
      minutes ? minutes * 60_000 : 0
    );
  }

  closePlayer() {
    this.showPlayer.set(false);
    this.currentStreamUrl.set('');
    this.currentStreamName.set('');
    this.resumeAt.set(0);
    this.playingEpisode.set(null);

    // The player reports its final position as it is torn down, so the reload
    // is queued behind that write rather than racing it.
    setTimeout(() => this.loadProgress(), 250);
  }

  // --- Progress display ---------------------------------------------------

  progressFor(episode: Episode): WatchProgress | null {
    return this.progressByEpisode()[String(episode.id)] ?? null;
  }

  private percentWatched(episode: Episode): number {
    return watchedPercent(this.progressFor(episode));
  }

  private isWatched(episode: Episode): boolean {
    return isComplete(this.progressFor(episode));
  }

  private remaining(episode: Episode): string {
    return remainingLabel(this.progressFor(episode));
  }

  /** "52 min · watched", "51 min · 23 min left", "49 min". */
  private episodeCaption(episode: Episode): string {
    const minutes = episodeMinutes(episode.info);
    const length = minutes ? t('common.min', { count: minutes }) : '';
    const state = this.isWatched(episode) ? t('show.watched') : this.percentWatched(episode) > 0 ? this.remaining(episode) : '';
    return [length, state].filter(Boolean).join(' · ');
  }


  labelFor(episode: Episode): string {
    return episodeLabel(episode.season, episode.episode_num);
  }

  /**
   * The episode's title, with the show name and numbering stripped out --
   * both are already on the page. Falls back to the number when the provider
   * gave nothing else.
   */
  titleOf(episode: Episode): string {
    const name = this.knownName();
    const short = shortEpisodeTitle(name, episode.title);
    // The provider's own name for a show carries more than its episodes do
    // ("... (US) (FHD HEVC)"), so try the plain title when the full one missed.
    const shorter = short === String(episode.title ?? '').trim() ? shortEpisodeTitle(posterTitle(name).title, episode.title) : short;
    return shorter || t('show.episode', { number: episode.episode_num });
  }

  /** The caption on the continue button: what it will do, and from where. */
  readonly continueLabel = computed(() => {
    const next = this.nextUp();
    if (!next) {
      return '';
    }

    // Names the exact episode, so the remote never gambles (TV-6).
    const numbered = t('show.episode', { number: next.episode.episode_num });
    const label = this.labelFor(next.episode) || numbered;
    const title = this.titleOf(next.episode);
    const named = title && title !== numbered ? `${label} · ${title}` : label;
    return next.resuming && next.resumeAt > 0 ? t('show.resumeNamed', { name: named }) : t('show.playNamed', { name: named });
  });

  /** The first pill (NX-TV-5): "Resume S4 E7", the episode's name being on the line above. */
  readonly continueShort = computed(() => {
    const next = this.nextUp();
    if (!next) {
      return '';
    }
    const label = this.labelFor(next.episode) || t('show.episode', { number: next.episode.episode_num });
    return next.resuming && next.resumeAt > 0 ? t('show.resumeNamed', { name: label }) : t('show.playNamed', { name: label });
  });

  /** Episodes, from the pills: to the episode up next, in its season. */
  toEpisodes(): void {
    const next = this.nextUp();
    const key = next && this.store.currentSeasonEpisodes().some(episode => String(episode.id) === String(next.episode.id)) ? `episode-${next.episode.id}` : null;
    const row =
      (key ? document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) : null) ??
      document.querySelector<HTMLElement>('[data-show-episode]');
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'center' });
  }

  /** More's panel (NX-TV-5): the copy episodes play in, and the trailer. */
  readonly moreOpen = signal(false);
  readonly moreActions = computed<ItemAction[]>(() => {
    const actions: ItemAction[] = [];
    const show = this.tmdbShow();
    const copy = this.currentCopy();
    if (copy && show && show.copies.length > 1) {
      actions.push({ id: 'copy', label: copyLabel(copy), icon: 'lucideListVideo' });
    }
    if (show?.trailers?.length) {
      actions.push({ id: 'trailer', label: t('trailer.button'), hint: 'YouTube', icon: 'lucidePlay' });
    }
    return actions;
  });

  /** More's panel closed: focus back on More, where it was. */
  closeMore(): void {
    this.moreOpen.set(false);
    setTimeout(() => document.querySelector<HTMLElement>('[data-focus-key="show-more"]')?.focus({ preventScroll: true }));
  }

  onMore(id: string): void {
    this.moreOpen.set(false);
    if (id === 'copy') {
      this.openCopies();
    } else if (id === 'trailer') {
      this.trailer();
    }
  }

  /** "from 16:53" under the continue card, when picking up part-way. */
  readonly resumeFrom = computed(() => {
    const next = this.nextUp();
    return next?.resuming && next.resumeAt > 0 ? t('show.from', { time: formatTimecode(next.resumeAt) }) : '';
  });

  goBack() {
    this.location.back();
  }

  browseShows() {
    this.router.navigate(['/shows']);
  }
}
