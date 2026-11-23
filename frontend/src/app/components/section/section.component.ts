import { RecordingsService } from '../../services/recordings.service';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { CommonModule, Location } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { firstValueFrom, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { DescriptionReaderService } from '../description-reader/description-reader.component';
import {
  lucideArrowLeft,
  lucideArrowUpDown,
  lucideBell,
  lucideChevronDown,
  lucideChevronRight,
  lucideClock,
  lucideHistory,
  lucideInfo,
  lucideLayoutGrid,
  lucideLayoutPanelLeft,
  lucideList,
  lucideLoaderCircle,
  lucidePlay,
  lucideRefreshCw,
  lucideSatelliteDish,
  lucideSearch,
  lucideStar,
  lucideTv,
  lucideX,
  lucideCircleDot,
  lucideCircleStop
} from '@ng-icons/lucide';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import {
  CategorySort,
  RECENT_LIMIT,
  Stream,
  StreamSort,
  StreamType,
  WatchProgress
} from '@shared/types';
import { SearchFacets, resultsIn, searchFacets } from '@shared/xtream/searchFacets';
import { byCloseness } from '@shared/xtream/searchRanking';
import { LIVE_EDGE_MS, archiveDays, catchUpKind, catchUpStretch } from '@shared/xtream/catchUp';
import { XtreamService } from '../../services/xtream.service';
import { AgeLockService } from '../../services/age-lock.service';
import { ChannelPreviewService } from '../../services/channel-preview.service';
import { SlowWaitComponent } from '../slow-wait/slow-wait.component';
import { DiscoverComponent, DiscoverState } from '../discover/discover.component';
import { DiscoverPillsComponent } from '../discover/discover-pills.component';
import { firstPerTitle, oneCardPerTitle } from '../../utils/one-per-title.utils';
import { AgeCoverComponent } from '../age-cover/age-cover.component';
import { AccountService } from '../../services/account.service';
import { RemindersService } from '../../services/reminders.service';
import { SETTING_KEYS } from '@shared/types';
import { SettingsService } from '../../services/settings.service';
import { latestPerShow, readHiddenShows, showOf, watchedWhen } from '../../utils/for-you.utils';
import { CATEGORY_OPENS_KEY, mostOpened, withOpening } from '../../utils/category-opens.utils';
import { namePrefix } from '../../utils/series-display.utils';
import { ClockService } from '../../services/clock.service';
import { ParentalLockService } from '../../services/parental-lock.service';
import { ProviderAccessService } from '../../services/provider-access.service';
import { untagged } from '@shared/providers/providerRecord';
import { DeviceSyncService } from '../../services/device-sync.service';
import { BackButtonService } from '../../services/back-button.service';
import { ChannelEntry, ChannelRun, NativePlayerService, PlaybackCheckpoint } from '../../services/native-player.service';
import { NativePlayResult } from '../../services/native/nativePlayer';
import { ProgressEntry } from '../../utils/playback-checkpoint.utils';
import { channelBanner } from '../../utils/player-banner.utils';
import { WIDE_LAYOUT_QUERY, wideLayoutNow } from '../../utils/layout.utils';
import { DrawerService } from '../../services/drawer.service';
import { GUIDE_LEFTMOST, TvNavigationService } from '../../services/tv-navigation.service';
import { DashboardStore } from '../../stores/dashboard.store';
import {
  ChannelDisplay,
  ChannelStep,
  channelAfter,
  channelDisplay,
  isChannelStep,
  channelMonogram,
  clockTime,
  episodeLabel,
  formatTimecode,
  getStreamType,
  GUIDE_GRID_BACK_HOURS,
  guideDateLabel,
  isComplete,
  minutesLeft,
  percentThrough,
  PosterTitle,
  posterTitle,
  remainingLabel,
  resumePosition,
  shortEpisodeTitle,
  watchedPercent,
  withoutTags
} from '../../utils';
import { CategoryPickerComponent } from '../category-picker/category-picker.component';
import { ChannelGuidePickerComponent } from '../channel-guide-picker/channel-guide-picker.component';
import { GuideSourcesService } from '../../services/guide-sources.service';
import { GuideService } from '../../services/guide.service';
import { EpgComponent } from '../epg/epg.component';
import { ReorderDialogComponent, ReorderItem } from '../reorder-dialog/reorder-dialog.component';
import { SubtitlePickerComponent } from '../subtitle-picker/subtitle-picker.component';
import { SubtitleItem } from '../../services/subtitle-library.service';
import { PlaybackProgress, VideoPlayerComponent } from '../video-player/video-player.component';
import { SpotTarget, SpotlightComponent, SpotlightHostDirective } from '../spotlight/spotlight.component';
import { ItemAction, ItemActionsComponent } from '../item-actions/item-actions.component';
import { CardGesturesDirective } from '../../directives/card-gestures.directive';
import { ToastService } from '../../services/toast.service';
import { PlatformService } from '../../services/platform.service';
import {
  describePlaybackFailure,
  isDecodingFailure,
  tooBigToDecodeInSoftware,
  withoutAddresses
} from '../../utils/failure-messages.utils';
import { otherVersions, searchWordsFor } from '../../utils/other-versions.utils';
import { COPY_SWITCH_PAUSE_MS, CopyFallbackService } from '../../services/copy-fallback.service';
import { filmPresentation } from '../../utils/film-presentation.utils';
import { DescriptionsService } from '../../services/descriptions.service';
import { isEditing } from '../../utils/typing.utils';
import { FocusScopeDirective } from '../../directives/focus-scope.directive';
import { PlaceMemoryService } from '../../services/place-memory.service';
import { locale, t } from '../../utils/i18n';
import { ChoicePanelService } from '../../ui/choice-panel.service';
import { TPipe } from '../../pipes/t.pipe';
import { ProviderNamePipe } from '../../pipes/provider-name.pipe';
import { ChannelMonogramPipe, ChannelTitlePipe, PosterTitlePipe } from '../../pipes/format.pipes';
import { GuideByStream, LooseProgramme } from '../../utils/guide.utils';

type SectionFormModel = {
  selectedCategory: FormControl<string>;
  searchTerm: FormControl<string>;
};

/** Which of the phone's chips is on (P-2, P-4, P-7). */
type QuickFilter = 'all' | 'now' | 'progress' | 'fav';

/**
 * What the actions panel is open about.
 *
 * Two kinds, because the rails hold two different things. A card in the grid or
 * in Favourites is a channel and carries everything a channel has; a card in
 * Continue watching is a *position* in something, which may be an episode of a
 * show whose own id is not the one being listed.
 */
type MenuTarget =
  | { kind: 'stream'; stream: Stream }
  | { kind: 'recent'; entry: WatchProgress };

/** One programme as a guide row draws it. */
export interface GuideItem {
  prog: LooseProgramme;
  /** When it starts and stops, in milliseconds; NaN when the guide did not say. */
  start: number;
  stop: number;
  onAir: boolean;
  /** Over: drawn quieter, and played from catch-up where the channel keeps it. */
  finished: boolean;
  style: { [key: string]: string };
  /** "20:45 – 22:45". */
  time: string;
  /** "68 min left", on the programme on air only. */
  left: string | null;
  /** How far through it is, 0 to 100, for the meter on the programme on air. */
  percent: number;
}

/** A programme to play from the channel's past (see shared/xtream/catchUp.ts). */
export interface CatchUpProgramme {
  start: number;
  stop: number;
  title: string;
}

/** What the programme on air says in the actions panel (TV-3). */
export interface NowPlaying {
  title: string;
  time: string;
  left: string | null;
  percent: number;
}

/** What is currently in the player, so its position can be attributed. */
/** How long a film waits for its description before playing without it. */
const FILM_DESCRIPTION_WAIT_MS = 600;

interface PlayingItem {
  type: StreamType;
  itemId: string;
  name: string;
  /** The provider's channel number, for the switching panel. Absent from history entries. */
  number?: string;
  /** The channel as the provider listed it, which the guide is matched against. */
  source?: Stream;
  icon?: string | null;
  /**
   * The container the provider actually holds this in.
   *
   * Xtream serves a film at a path ending in its real extension, so asking for
   * an .mkv as .mp4 gets a 404 rather than the film. Episodes carried this from
   * the start and played; films did not and were requested as .mp4 whatever
   * they were, which is why every film in a container of any other kind failed
   * to open. Live has no extension of its own -- it is always the .m3u8 the
   * protocol layer supplies.
   */
  containerExtension?: string | null;
}

/** How long a channel change waits for the provider to let go of the stream just closed. */
const CHANNEL_CHANGE_PAUSE_MS = 1500;

/** A failure this soon after a change is taken to be the provider still holding the old stream. */
const CHANNEL_REFUSAL_WINDOW_MS = 15_000;

/** And the longer wait before that channel is tried once more. */
const CHANNEL_RETRY_PAUSE_MS = 3000;

/**
 * How much of a started-over programme must be newly recorded for asking for
 * it to be worth a playlist of its own; less than this, the channel itself is
 * what comes next.
 */
const CATCH_UP_CONTINUE_MIN_MS = 3 * 60 * 1000;

const SECTION_TITLES: Record<StreamType, string> = {
  live: 'nav.liveTv',
  vod: 'nav.movies',
  series: 'nav.shows'
};

/**
 * One library: TV, Movies or TV Shows.
 *
 * The same component serves all three; which one is a route matter, so the
 * stream type comes from the route's data rather than from a control the user
 * has to find and change.
 *
 * It opens on what the viewer is most likely to want -- what they were part
 * way through, and what they marked -- and only goes to the full category
 * browser once they ask for one.
 */
/** Where each library was last left on this device, by type: `xtream_last_category_live`. */
const LAST_CATEGORY_KEY = 'xtream_last_category_';

function readOpens(type: string): string | null {
  try {
    return localStorage.getItem(`${CATEGORY_OPENS_KEY}${type}`);
  } catch {
    return null;
  }
}

/**
 * Hours of programmes in the guide: those already gone that catch-up can
 * still play (GUIDE_GRID_BACK_HOURS), and four from the start of this one.
 */
const GUIDE_HOURS = GUIDE_GRID_BACK_HOURS + 4;

/** How many of them are on screen at once; the rest are scrolled to. */
const GUIDE_HOURS_SHOWN = 2;

@Component({
  selector: 'app-section',
  standalone: true,
  imports: [DiscoverComponent, DiscoverPillsComponent, SlowWaitComponent, AgeCoverComponent, TPipe, ProviderNamePipe, PosterTitlePipe, ChannelTitlePipe, ChannelMonogramPipe,
    CommonModule,
    ReactiveFormsModule,
    ScrollingModule,
    NgIcon,
    HlmButton,

    HlmInput,
    HlmLabel,
    CategoryPickerComponent,
    ChannelGuidePickerComponent,
    EpgComponent,
    ReorderDialogComponent,
    VideoPlayerComponent,
    ItemActionsComponent,
    SpotlightComponent,
    SpotlightHostDirective,
    CardGesturesDirective,
    FocusScopeDirective,
    SubtitlePickerComponent,
    RouterLink,
    RouterLinkActive
  ],
  providers: [
    provideIcons({
      lucideCircleDot, lucideCircleStop, lucideInfo,
      lucideArrowLeft,
      lucideArrowUpDown,
      lucideBell,
      lucideChevronDown,
      lucideChevronRight,
      lucideClock,
      lucideHistory,
      lucideLayoutGrid,
      lucideLayoutPanelLeft,
      lucideList,
      lucideLoaderCircle,
      lucidePlay,
      lucideRefreshCw,
      lucideSatelliteDish,
      lucideSearch,
      lucideStar,
      lucideTv,
      lucideX
    })
  ],
  templateUrl: './section.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SectionComponent {
  readonly store = inject(DashboardStore);
  private readonly xtreamService = inject(XtreamService);
  readonly ages = inject(AgeLockService);
  readonly preview = inject(ChannelPreviewService);

  /** The channel the remote is on in the guide, and the programme if it is on one. */
  private readonly guideFocus = signal<{ streamId: string; start: number | null } | null>(null);
  private readonly previewBox = viewChild<ElementRef<HTMLElement>>('previewBox');
  private readonly previewDescription = viewChild<ElementRef<HTMLElement>>('previewDescription');

  /** Whether the focused programme's description is longer than the header shows. */
  readonly previewDescriptionCut = signal(false);

  private readonly measurePreviewDescription = afterRenderEffect(() => {
    this.previewInfo();
    const shown = this.previewDescription()?.nativeElement;
    this.previewDescriptionCut.set(!!shown && shown.scrollHeight > shown.clientHeight + 1);
  });

  private readonly descriptionReader = inject(DescriptionReaderService);

  /** The whole description of the programme in the header. */
  readPreview(): void {
    const info = this.previewInfo();
    const focus = this.guideFocus();
    if (!info?.description) {
      return;
    }
    // Opened from the actions panel, which is gone by the time the reader
    // closes: focus goes back to the programme rather than to nothing.
    const key = focus ? (focus.start !== null ? `prog-${focus.streamId}-${focus.start}` : `guide-${focus.streamId}`) : null;
    requestAnimationFrame(() => {
      const programme = key ? document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) : null;
      programme?.focus({ preventScroll: true });
      this.descriptionReader.open({
        title: info.title,
        subtitle: info.time ? `${info.channel} · ${info.time}` : info.channel,
        text: info.description,
        source: 'provider'
      });
    });
  }

  /** TiviMate's preview above the guide: a television that has it, in the guide, with it switched on. */
  readonly previewShown = computed(
    () => this.television() && this.preview.enabled() && this.type() === 'live' && this.browsing() && this.listView()
  );

  /** What the panel beside the picture says: the programme in focus, else the one on air. */
  readonly previewInfo = computed(() => {
    const focus = this.guideFocus();
    const stream = focus ? this.shownStreams().find(candidate => String(candidate.stream_id) === focus.streamId) : null;
    if (!focus || !stream) {
      return null;
    }
    this.clockMinute();
    const items = this.getProgramsForStream(stream);
    const index = focus.start !== null ? items.findIndex(item => item.start === focus.start) : items.findIndex(item => item.onAir);
    const item = index >= 0 ? items[index] : null;
    const next = index >= 0 ? items[index + 1] : null;
    return {
      channel: this.display(stream).title,
      title: item?.prog?.title || this.display(stream).title,
      time: item?.time ?? '',
      left: item?.onAir ? item.left : null,
      percent: item?.onAir ? item.percent : null,
      description: String(item?.prog?.description ?? item?.prog?.desc ?? ''),
      next: next ? { time: next.time.split(' ')[0], title: next.prog?.title || '' } : null
    };
  });

  /** The guide hosts the preview while its box is on screen (ChannelPreviewService.host). */
  private readonly hostsPreview = effect(onCleanup => {
    if (this.previewShown()) {
      onCleanup(this.preview.host());
    }
  });

  /**
   * Back from full screen on another channel -- changed in the player -- the
   * guide's focus goes to that channel, so the box and the line beside it
   * describe what is playing rather than where the remote was before.
   */
  private readonly focusFollowsReturn = effect(() => {
    const back = this.preview.returned();
    if (!back) {
      return;
    }
    untracked(() => {
      const focus = this.guideFocus();
      if (focus?.streamId === back.streamId) {
        return;
      }
      requestAnimationFrame(() => {
        const cell = document.querySelector<HTMLElement>(`[data-focus-key="guide-${CSS.escape(back.streamId)}"]`);
        if (cell) {
          cell.focus({ preventScroll: true });
          cell.scrollIntoView({ block: 'nearest' });
        }
      });
    });
  });

  /**
   * And the preview goes when the guide does. The effect below stops it while
   * the guide is open; leaving the guide destroyed that effect with it, and the
   * picture stayed over whatever came next (22 October).
   */
  private readonly previewLeavesWithGuide = inject(DestroyRef).onDestroy(() => void this.preview.stop());

  /** Stops the preview when the guide goes, or a panel opens over it: nothing can be drawn over the picture. */
  private readonly previewEndsWithGuide = effect(() => {
    const shown = this.previewShown();
    // The description reader too: the picture is a native window, drawn over anything the page opens.
    const menuOpen = this.menuTarget() !== null || this.descriptionReader.reading() !== null;
    // Read too, so a stream handed back from full screen onto a page without the guide stops.
    const playing = this.preview.state() !== 'idle';
    if (playing && (!shown || menuOpen)) {
      untracked(() => void this.preview.stop());
    }
  });

  /**
   * OK on a channel in the guide, TiviMate's way: the first plays it in the
   * preview, the second takes it full screen -- the same stream, handed
   * over. Without the preview, straight to full screen as before.
   */
  guideActivate(stream: Stream): void {
    // OK again before the preview had a stream to hand over: let it go and
    // play full screen from scratch (ChannelPreviewService.pending).
    if (this.preview.pending(stream.stream_id)) {
      void this.preview.stop().then(() => this.openCard(stream));
      return;
    }
    // While a recording holds the connection the preview opens nothing, so
    // OK goes straight to full screen: the channel being recorded plays from
    // its recording there, and another says why it cannot. Before, OK on
    // either did nothing at all.
    if (!this.previewShown() || this.preview.showing(stream.stream_id) || this.preview.failed(stream.stream_id) || !this.recordings.mayOpen(String(stream.stream_id))) {
      this.openCard(stream);
      return;
    }
    void this.preview.start(stream, () => this.previewBox()?.nativeElement.getBoundingClientRect() ?? null);
  }

  onGuideFocus(event: FocusEvent): void {
    const key = (event.target as HTMLElement | null)?.closest('[data-focus-key]')?.getAttribute('data-focus-key') ?? '';
    const channel = /^guide-(.+)$/.exec(key);
    const programme = /^prog-(.+)-(\d+)$/.exec(key);
    if (channel) {
      this.guideFocus.set({ streamId: channel[1], start: null });
    } else if (programme) {
      this.guideFocus.set({ streamId: programme[1], start: Number(programme[2]) });
    }
  }
  private readonly guideSources = inject(GuideSourcesService);
  private readonly guide = inject(GuideService);
  private readonly back = inject(BackButtonService);
  private readonly nativePlayer = inject(NativePlayerService);
  private readonly lock = inject(ParentalLockService);
  readonly reminders = inject(RemindersService);

  /** Whether arranging and matching guides are offered: not to a kid at its own device. */
  readonly canChangeSetup = inject(AccountService).canChangeSetup;
  private readonly providerAccess = inject(ProviderAccessService);

  /** Each provider's name by slot tag, for the category list's group headers. */
  readonly providerLabels = computed(() =>
    Object.fromEntries(this.providerAccess.records().map(record => [record.tag, record.label]))
  );
  readonly providerKinds = computed(() =>
    Object.fromEntries(this.providerAccess.records().map(record => [record.tag, record.kind]))
  );
  private readonly tvNavigation = inject(TvNavigationService);

  /** Whether this is a television, for what the template leaves out there. */
  readonly television = this.tvNavigation.isTelevision;
  private readonly deviceSync = inject(DeviceSyncService);
  private readonly router = inject(Router);
  private readonly descriptions = inject(DescriptionsService);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);

  /** Which library this is. All three routes share this component. */
  readonly type = toSignal(this.route.data.pipe(map(data => data['type'] as StreamType)), {
    initialValue: 'live' as StreamType
  });

  readonly title = computed(() => t(SECTION_TITLES[this.type()]));

  readonly form = new FormGroup<SectionFormModel>({
    selectedCategory: new FormControl<string>('', { nonNullable: true }),
    searchTerm: new FormControl<string>('', { nonNullable: true })
  });

  /** Mirrors the category control, which a template cannot react to on its own. */
  readonly selectedCategory = signal<string>('');
  readonly searching = signal<boolean>(false);

  /** The full category browser is showing rather than the section's front page. */
  readonly browsing = computed(() => !!this.selectedCategory() || this.searching());


  // --- The drawer (TV-N-1) -------------------------------------------------

  /**
   * How far the panels on the left are pushed open, on a television.
   *
   * The screen used to be a plane: categories beside the guide, and the arrows
   * moving between them by geometry. That is correct and unusable -- Up from
   * the middle of the guide climbed the programme rows, crossed into the
   * category list, climbed *those*, and only then reached the toolbar, which is
   * thirty presses at worst.
   *
   * TV-N-1 makes it a stack instead. Closed, the categories are an 80px rail:
   * not zero, because a zero-width edge gives the D-pad nothing to aim at and
   * the current category would have nowhere to live. Left opens them; Left
   * again opens the navigation; Right or Back closes one level, never both, so
   * two Rights return to the exact programme you started from.
   *
   * A stack that pushes rather than covers. An earlier attempt at a drawer laid
   * it over the channel names and was reverted -- see the note by
   * `[data-tv-columns]` in styles.css -- because focus moves by geometry and a
   * panel on top of a row makes Right from a category land underneath it. The
   * boards answer that: the guide shrinks and slides, it does not hide, so
   * every row on screen is still a row on screen.
   */
  private readonly drawers = inject(DrawerService);
  private readonly toasts = inject(ToastService);
  private readonly platform = inject(PlatformService);
  private readonly copies = inject(CopyFallbackService);
  readonly recordings = inject(RecordingsService);

  openRecordings(): void {
    void this.router.navigate(['/recordings']);
  }

  /** The recording running on this channel, matched by its name as the recorder keeps it. */
  private recordingOf(stream: Stream) {
    const name = this.display(stream).title;
    return this.recordings.running().find(one => one.channel === name) ?? null;
  }

  /**
   * Records what is on a channel now, to its end in the guide. Its preview
   * lets go first: the recording needs the connection the preview holds.
   */
  private async recordNow(stream: Stream): Promise<void> {
    const onAir = this.getProgramsForStream(stream).find(item => item.onAir);
    const name = this.display(stream).title;
    try {
      if (this.preview.state() !== 'idle') {
        await this.preview.stop();
      }
      const started = await this.recordings.recordNow(stream, name, onAir?.prog.title ?? '', onAir && Number.isFinite(onAir.stop) ? onAir.stop : null);
      if (started) {
        this.toasts.info(t('recordings.started', { title: started.title }), t('recordings.until', { time: clockTime(started.endsAt) }), {
          label: t('recordings.title'),
          run: () => void this.router.navigate(['/recordings'])
        });
      }
    } catch (error) {
      this.toasts.error(t('recordings.couldNot'), undefined, { detail: withoutAddresses(String(error)) });
    }
  }

  /** The level, which this screen shares with the shell that draws the navigation. */
  readonly drawer = this.drawers.level;

  /** The drawer only exists on a television; a pointer has the whole screen. */
  readonly drawerState = computed(() =>
    this.tvNavigation.isTelevision() ? this.drawer() : null
  );

  private readonly picker = viewChild(CategoryPickerComponent);

  /**
   * What the collapsed rail says, set vertically: the category you are in.
   *
   * The rail is 80 pixels of otherwise empty edge, and TV-N-1a gives it this
   * job so "the screen states both where you are and what Left does". Without
   * the name, collapsing the list would take away the only thing on screen
   * saying which of 830 categories these channels belong to.
   */
  readonly railName = computed(() => {
    if (this.searching()) {
      return t('nav.search');
    }
    if (this.selectedCategory() === this.FAVORITES_CATEGORY) {
      return t('cat.favourites');
    }
    const found = this.store
      .categories()
      .find(category => String(category.category_id) === this.selectedCategory());
    return found ? withoutTags(found.category_name) : '';
  });

  /**
   * Where focus was in the guide when the drawer opened, so Right can give it
   * back. The item's key rather than the element, which a virtual scroller
   * recycles out from under anything holding it.
   */
  private cameFrom: string | null = null;


  // --- Rails --------------------------------------------------------------

  readonly recent = signal<WatchProgress[]>([]);

  private readonly settings = inject(SettingsService);

  /** Shows taken out of Continue watching, each until it is watched again. */
  private readonly hiddenShows = computed(() => readHiddenShows(this.settings.get(SETTING_KEYS.continueHidden)));

  /**
   * Continue watching as the page shows it: on TV Shows a card per show, the
   * show itself and never an episode (2 October), opening the
   * show's page on what is next in it.
   */
  /**
   * Continue watching, by For You's rule: a film finished is not carried on
   * with, so it is not here -- it was, marked "Watched", beside the ones that
   * were (a user's Movies, 31 October). Channels and shows as before.
   */
  readonly continueShown = computed(() => {
    const type = this.type();
    if (type === 'live') {
      return this.recent();
    }
    const shown = type === 'series' ? latestPerShow(this.recent(), this.hiddenShows()) : this.recent().filter(entry => !isComplete(entry));
    // One card per title: the copy last watched, where two copies of it were started.
    return firstPerTitle(shown, entry => entry.name);
  });
  readonly favorites = signal<Stream[]>([]);
  readonly favoriteIds = signal<Set<string>>(new Set());

  /**
   * The number beside Favourites. The stars, as a rule; the list itself while
   * a category is locked, which leaves out what it holds, or the count would
   * give away a favourite the list is keeping out of sight.
   */
  readonly favouritesShown = computed(() =>
    this.lock.lockedOutOf(this.type()).length ? this.favorites().length : this.favoriteIds().size
  );

  /** How far the currently listed items were watched, keyed by id. */
  readonly progressByItem = signal<Record<string, WatchProgress>>({});

  readonly RECENT_LIMIT = RECENT_LIMIT;

  /** Sentinel category id for the favourites list. */
  readonly FAVORITES_CATEGORY = '__favorites__';

  // --- Grid virtualisation ------------------------------------------------

  /**
   * Card height plus the padding below its row, in CSS pixels.
   *
   * On a desktop `h-[168px]` and `pb-3`. On a television the card is 216
   * *design* pixels (`.tv .h-\[168px\]` in styles.css) and `pb-3` is twelve of
   * them, converted by the TV scale -- the scroller positions rows from this
   * number, so it has to come from the same scale as the card or the rows
   * drift out of step with it.
   */
  readonly GRID_ROW_HEIGHT_PX = computed(() => {
    const tv = this.tvNavigation.isTelevision();
    if (this.posterGrid()) {
      // A 2:3 poster and two lines under it (TV-5, TV-13): `h-[292px]` and
      // `pb-3` here, 400 and 24 design pixels on a television, and 236 on a
      // phone, where three share the width (P-4, P-7).
      return tv ? this.tvNavigation.designPx(400 + 24) : this.wideEnoughToDock() ? 292 + 12 : 236 + 12;
    }
    return tv ? this.tvNavigation.designPx(216 + 12) : 180;
  });
  /**
   * A guide row's height, which the virtual scroller places rows by.
   *
   * `h-[57px]` on a desktop -- the 56 lane and its border -- and on a
   * television `calc(6rem + 1px)` (styles.css): the board's 96 design pixels
   * and a one-pixel border that does not scale. Not rounded, because 6rem is
   * exactly 96 design pixels and a rounded figure would drift a pixel a row
   * down a list of three hundred.
   */
  readonly GUIDE_ROW_HEIGHT_PX = computed(() =>
    this.tvNavigation.isTelevision() ? 96 * this.tvNavigation.designPixel() + 1 : 57
  );

  private readonly guideViewport = viewChild<CdkVirtualScrollViewport>('guideViewport');

  /**
   * A new category starts at its first channel. The scroller keeps its offset
   * across a change of data, so without this a category opened half way down
   * the last one, with focus looking for a first row that was not drawn.
   */
  private readonly guideStartsAtTop = effect(() => {
    this.store.streams();
    untracked(() => {
      const viewport = this.guideViewport();
      viewport?.scrollToOffset(0);
      // And at the first of its hours, not wherever the last category was left.
      viewport?.elementRef.nativeElement.scrollTo({ left: 0 });
    });
  });

  private readonly minCardWidthPx = computed(() => {
    const tv = this.tvNavigation.isTelevision();
    if (this.posterGrid()) {
      return tv ? this.tvNavigation.designPx(200) : this.wideEnoughToDock() ? 150 : 100;
    }
    return tv ? this.tvNavigation.designPx(340) : 196;
  });
  private readonly gridGapPx = computed(() => {
    const tv = this.tvNavigation.isTelevision();
    return tv ? this.tvNavigation.designPx(this.posterGrid() ? 24 : 12) : 12;
  });

  /** Films and shows are posters; channels are logos, and keep their cards. */
  readonly posterGrid = computed(() => this.type() !== 'live');

  readonly gridColumns = signal<number>(1);

  // `read: ElementRef` is required: the ref points at a component, so without
  // it the query hands back CdkVirtualScrollViewport and nativeElement is
  // undefined, leaving the column count stuck at its initial value.
  private readonly gridViewport = viewChild('gridViewport', { read: ElementRef });

  /** A phone, as opposed to a narrow window on a television (P-1 – P-7). */
  readonly phone = computed(() => !this.wideEnoughToDock() && !this.tvNavigation.isTelevision());

  /**
   * The chips over a list on a phone (P-2, P-4, P-7): everything, what is on
   * air or part-watched, or what is starred. Applied to what is already in
   * hand; nothing is fetched.
   */
  readonly quickFilter = signal<QuickFilter>('all');

  private matchesQuick(stream: Stream, filter: QuickFilter): boolean {
    switch (filter) {
      case 'now':
        return !!this.nowPlayingOn(stream);
      case 'progress': {
        const entry = this.progressByItem()[String(stream.stream_id)];
        return !!entry && entry.positionSeconds > 0 && !isComplete(entry);
      }
      case 'fav':
        return this.favoriteIds().has(String(stream.stream_id));
      default:
        return true;
    }
  }

  /**
   * Which categories a search's results came from, and the families those fall
   * in. Only for a search: inside one category the answer is the category.
   */
  readonly facets = computed<SearchFacets>(() =>
    this.store.isGlobalSearch()
      ? searchFacets(this.store.streams(), this.store.categories())
      : { categories: [], families: [], uncategorised: 0 }
  );

  /** The chip pressed, if any: a family key or a category id. */
  readonly facetChosen = signal<{ kind: 'family' | 'category'; key: string } | null>(null);

  /**
   * A new set of results starts with everything shown.
   *
   * Without this a chip chosen for "x-men" survives into the next search,
   * which for another film means a list filtered by a category it has nothing
   * in -- an empty screen with no obvious cause.
   */
  private readonly forgetFacets = effect(() => {
    this.store.streams();
    const searching = this.store.isGlobalSearch();
    untracked(() => {
      this.facetChosen.set(null);
      this.showAllFacets.set(false);

      // A search answers with the closest first: alphabetical puts the film
      // somebody asked for in the middle of its own sequels. Only the screen's
      // own signal changes, so the order they browse categories in is theirs
      // and is not overwritten by searching.
      if (searching && this.streamSort() !== 'closest') {
        this.streamSort.set('closest');
      }
    });
  });

  /** The categories the chosen chip stands for, or none for "everything". */
  private readonly facetCategoryIds = computed<string[]>(() => {
    const chosen = this.facetChosen();
    if (!chosen) {
      return [];
    }
    if (chosen.kind === 'category') {
      return [chosen.key];
    }
    return this.facets().families.find(family => family.key === chosen.key)?.categoryIds ?? [];
  });

  /** How many categories to offer before "More"; the rest are behind it. */
  readonly FRONT_FACETS = 6;

  readonly showAllFacets = signal(false);

  readonly shownFacetCategories = computed(() => {
    const categories = this.facets().categories;
    return this.showAllFacets() ? categories : categories.slice(0, this.FRONT_FACETS);
  });

  readonly shownStreams = computed<Stream[]>(() => {
    const filter = this.quickFilter();
    const streams = this.store.streams();
    const narrowed = filter === 'all' ? streams : streams.filter(stream => this.matchesQuick(stream, filter));

    const wanted = this.facetCategoryIds();
    const chosen = wanted.length ? resultsIn(narrowed, wanted) : narrowed;

    // "Closest" is the only sort that needs the query, so it happens here
    // rather than where the rest of the ordering does.
    return this.store.isGlobalSearch() && this.streamSort() === 'closest'
      ? byCloseness(chosen, this.store.searchTerm())
      : chosen;
  });

  private readonly categoryNames = computed<Map<string, string>>(
    () => new Map(this.store.categories().map(category => [String(category.category_id), category.category_name]))
  );

  /** The category a result is in, for the line under its name in a search. */
  categoryOf(stream: Stream): string {
    const id = String((stream as unknown as Record<string, unknown>)['category_id'] ?? '');
    return id ? (this.categoryNames().get(id) ?? '') : '';
  }

  chooseFacet(kind: 'family' | 'category', key: string): void {
    const chosen = this.facetChosen();
    // A second press on the same chip is how somebody gets back to everything.
    this.facetChosen.set(chosen && chosen.kind === kind && chosen.key === key ? null : { kind, key });
  }

  readonly quickCounts = computed(() => {
    const streams = this.store.streams();
    const count = (filter: QuickFilter) => streams.filter(stream => this.matchesQuick(stream, filter)).length;
    return {
      all: streams.length,
      now: this.type() === 'live' ? count('now') : 0,
      progress: this.type() === 'live' ? 0 : count('progress'),
      fav: count('fav')
    };
  });

  trackByStream(_index: number, stream: Stream): string {
    return String(stream.stream_id);
  }

  /** "until 21:00", from a programme's "20:45 – 21:00". */
  untilOf(time: string): string {
    const parts = time.split('–');
    return parts.length > 1 ? 'until ' + parts[1].trim() : '';
  }

  readonly streamRows = computed<Stream[][]>(() => {
    const streams = this.shownStreams();
    const columns = Math.max(1, this.gridColumns());
    const rows: Stream[][] = [];
    for (let i = 0; i < streams.length; i += columns) {
      rows.push(streams.slice(i, i + columns));
    }
    return rows;
  });

  // --- Player and dialogs -------------------------------------------------

  readonly showPlayer = signal<boolean>(false);
  readonly currentStreamUrl = signal<string>('');
  readonly currentStreamName = signal<string>('');
  readonly resumeAt = signal<number>(0);
  private readonly playing = signal<PlayingItem | null>(null);

  readonly selectedStream = signal<Stream | null>(null);
  readonly showEPG = signal<boolean>(false);

  /** The stream whose guide channel is being chosen, if any. */
  readonly mappingStream = signal<Stream | null>(null);
  /**
   * The guide, or the grid of cards.
   *
   * Two things at once, because the answer has a default that depends on the
   * section and an override that does not.
   *
   * **The guide is what Live TV opens on.** It is the reason somebody goes to
   * a television at all -- what is on now, on every channel, without opening
   * anything -- and the grid of logos was answering a question nobody asks of
   * live television. Movies and shows have no guide, so for them this is not a
   * preference but an impossibility: the template has no branch for it, and a
   * `true` there would draw an empty pane.
   */
  private readonly gridWanted = signal<boolean>(false);

  readonly listView = computed(() => this.type() === 'live' && !this.gridWanted());

  // --- The actions panel --------------------------------------------------

  /**
   * What holding a card opens, and what it is about.
   *
   * A channel and something half-watched are different things with different
   * answers -- one can be starred and has a guide, the other has a place in
   * Continue watching to be rid of -- so the panel is told what to offer
   * rather than working it out.
   */
  readonly menuTarget = signal<MenuTarget | null>(null);

  /** The film the panel is open about, for its description; null for anything else. */
  readonly menuFilm = computed(() => {
    const target = this.menuTarget();
    if (target?.kind === 'stream' && this.type() === 'vod') {
      return { streamId: target.stream.stream_id, name: target.stream.name };
    }
    if (target?.kind === 'recent' && target.entry.type === 'vod') {
      return { streamId: target.entry.itemId, name: target.entry.name };
    }
    return null;
  });

  readonly menuActions = computed<ItemAction[]>(() => {
    const target = this.menuTarget();

    if (!target) {
      return [];
    }

    return target.kind === 'stream'
      ? this.actionsForStream(target.stream)
      : this.actionsForRecent(target.entry);
  });

  readonly categorySort = signal<CategorySort>('name_asc');
  readonly streamSort = signal<StreamSort>('name_asc');

  /**
   * What the sort menu shows. The setting is shared by all three libraries, and
   * films and shows have no channel numbers -- sorting by number falls back to
   * the name there, so that is what the menu says rather than offering a
   * choice that means nothing.
   */
  readonly shownStreamSort = computed<StreamSort>(() => {
    const sort = this.streamSort();
    if (this.type() !== 'live' && sort === 'number') {
      return 'name_asc';
    }
    // Closeness means nothing without a query, and the option is not offered
    // outside a search; a preference left on it reads as name order.
    if (sort === 'closest' && !this.store.isGlobalSearch()) {
      return 'name_asc';
    }
    return sort;
  });
  /** The film whose subtitles are being chosen, or null (ST-D-2, ST-P-1). */
  readonly subtitleTarget = signal<{ item: SubtitleItem; name: string; poster: string | null } | null>(null);

  /** The category list, as a sheet, because a phone has no sidebar for it. */
  readonly showCategorySheet = signal(false);

  readonly showReorder = signal<boolean>(false);
  readonly reorderKind = signal<'category' | 'stream'>('category');
  readonly reorderItems = signal<ReorderItem[]>([]);
  readonly savingOrder = signal<boolean>(false);

  // --- EPG guide view -----------------------------------------------------

  private readonly slotMinutes = 30;

  /** Now, to the minute: what is on, the time header, the now-label. */
  private readonly clockMinute = inject(ClockService).minute;

  /** The search box's text. A signal, so what the page says about it redraws. */
  readonly searchTerm = toSignal(this.form.controls.searchTerm.valueChanges, {
    initialValue: this.form.controls.searchTerm.value
  });

  /**
   * One card or row as drawn: a channel's name, number and tags, a film's
   * title and caption, whether it is a favourite, how far it was watched.
   * What is on now is a computed signal of its own, worked out only for a
   * card that is drawn: a category of six hundred channels is a list of six
   * hundred cards and a screenful of them on screen.
   */
  private card(stream: Stream, now: () => NowPlaying | null) {
    const live = this.type() === 'live';
    const progress = live ? null : this.progressFor(stream);
    return {
      stream,
      id: String(stream.stream_id),
      display: this.display(stream),
      poster: this.poster(stream),
      caption: live ? '' : this.posterCaption(stream),
      number: this.channelNumberOf(stream),
      hasGuide: live && this.hasGuideFor(stream),
      favourite: this.isFavorite(stream),
      showProgress: !!progress && progress.durationSeconds > 0 && !isComplete(progress),
      percent: watchedPercent(progress),
      now: computed(() => {
        this.clockMinute();
        return live ? now() : null;
      })
    };
  }

  /** Continue watching on a section's front page. */
  readonly continueRows = computed(() => {
    this.clockMinute();
    const live = this.type() === 'live';
    return this.continueShown().map(entry => {
      const title = this.recentTitle(entry);
      return {
        entry,
        title,
        year: this.recentYear(entry),
        prefix: namePrefix(entry.name),
        when: this.menuWhen(entry),
        monogram: channelMonogram(title),
        percent: watchedPercent(entry),
        remaining: remainingLabel(entry),
        now: live ? this.frontNow(entry.itemId, entry.name) : null
      };
    });
  });

  /** The favourites on the front page. */
  readonly favouriteRows = computed(() =>
    this.frontFavourites().map(stream => this.card(stream, () => this.frontNow(stream.stream_id, stream.name)))
  );

  /** A phone's list of channels, with "until 21:00" under what is on. */
  readonly listRows = computed(() =>
    this.shownStreams().map(stream => {
      const card = this.card(stream, () => this.nowPlayingOn(stream));
      return { ...card, until: computed(() => this.untilOf(card.now()?.time ?? '')) };
    })
  );

  /** The grid, row by row. */
  readonly gridRows = computed(() =>
    this.streamRows().map(row => row.map(stream => this.card(stream, () => this.nowPlayingOn(stream))))
  );

  /**
   * The guide's rows: the channel cell as drawn, and the programme blocks and
   * the no-guide band as computed signals, so only the rows the scroller has
   * built work them out -- a block's place, the shift that keeps its words in
   * view, whether it plays again or has a reminder.
   */
  readonly laneRows = computed(() => {
    this.clockMinute();
    return this.store.streams().map(stream => {
      const catchUp = this.hasCatchUp(stream);
      return {
        stream,
        id: String(stream.stream_id),
        display: this.display(stream),
        meta: this.channelMeta(stream),
        favourite: this.isFavorite(stream),
        catchUp,
        catchUpTitle: catchUp ? this.catchUpTitle(stream) : '',
        byHand: !!this.guideMappingFor(stream),
        blocks: computed(() => {
          this.clockMinute();
          return this.getProgramsForStream(stream).map(item => {
            const replay = this.replayable(stream, item);
            return {
              item,
              shift: this.programmeWordsShift(item),
              width: this.programmeWordsWidth(item),
              replay,
              reminded: !replay && this.reminders.has(stream.stream_id, item.start)
            };
          });
        }),
        gap: computed(() => {
          this.clockMinute();
          return this.guideGap(stream);
        })
      };
    });
  });

  trackByCard(_index: number, card: { id: string }): string {
    return card.id;
  }

  /** The family and the category chosen among a search's facets, if either is. */
  readonly chosenFamily = computed(() => {
    const chosen = this.facetChosen();
    return chosen?.kind === 'family' ? chosen.key : null;
  });
  readonly chosenFacetCategory = computed(() => {
    const chosen = this.facetChosen();
    return chosen?.kind === 'category' ? chosen.key : null;
  });

  /**
   * How much of the day the guide spans: four hours, two of them on screen.
   *
   * TV-1 drew four hours across the screen, and a user found it hard to
   * read (26 September): a half-hour programme was a sliver with no room for
   * its name. So the lanes are twice as wide as the room they have, and the
   * other two hours are scrolled to -- by moving right on a remote, and
   * sideways with a mouse or a trackpad on a desktop, which used to have only
   * the two hours and nothing past them.
   */
  private epgWindowHours(): number {
    return GUIDE_HOURS;
  }

  /** How wide the lanes are, all four hours of them, once the guide has been measured. */
  readonly guideLanesPx = signal<number | null>(null);
  /** The channel column and the lanes together: a row's whole width. */
  readonly guideRowPx = signal<number | null>(null);
  /** The part of the lanes on screen at once. */
  readonly guideShownPx = signal<number | null>(null);
  /** The channel names' column, stuck to the left: where a programme's words stop sliding. */
  readonly guideColumnPx = signal(0);

  private readonly guideHeadLanes = viewChild<ElementRef<HTMLElement>>('guideHeadLanes');

  /**
   * Keeps the lanes at twice the room they are shown in, and the time header
   * over them wherever they are scrolled to.
   *
   * The header is outside the rows' scroller -- see the note on it in the
   * template -- so it cannot scroll with them; it is moved by the same amount
   * instead, outside Angular, since a scroll fires many times a second and
   * changes nothing Angular draws.
   */
  private readonly guideSpansWider = effect(onCleanup => {
    const viewport = this.guideViewport();
    const head = this.guideHeadLanes()?.nativeElement;
    // Each category opens at the current hour, wherever the last one was left.
    this.selectedCategory();
    if (!viewport || !head) {
      return;
    }
    const scroller = viewport.elementRef.nativeElement;
    const rows = scroller.querySelector<HTMLElement>('.cdk-virtual-scroll-content-wrapper');
    const channelColumn = head.parentElement?.previousElementSibling as HTMLElement | null;

    const measure = () => {
      const column = channelColumn?.offsetWidth ?? 0;
      const room = scroller.clientWidth - column;
      if (room <= 0) {
        return;
      }
      const lanes = Math.round(room * (GUIDE_HOURS / GUIDE_HOURS_SHOWN));
      this.guideLanesPx.set(lanes);
      this.guideShownPx.set(room);
      this.guideRowPx.set(column + lanes);
      this.guideColumnPx.set(column);
      lastLanes = lanes;
      // A remote goes no further back than this, the current hour (TvNavigationService).
      scroller.setAttribute(GUIDE_LEFTMOST, String(Math.round(lanes * (GUIDE_GRID_BACK_HOURS / GUIDE_HOURS))));
      requestAnimationFrame(() => keepPlace(10));
    };
    let lastLanes = 0;
    /** Where the viewer left the lanes, once they have moved them; until then, the current hour. */
    let viewerLeft = -1;
    /** Where the lanes were last put or left, to tell a move from the layout's doing. */
    let placedAt = -1;
    /** A hand on the lanes -- a wheel, a drag -- until a moment after it lets go. */
    let handUntil = 0;

    const wanted = () => (viewerLeft >= 0 ? viewerLeft : Math.round(lastLanes * (GUIDE_GRID_BACK_HOURS / GUIDE_HOURS)));
    // Wide enough to be scrolled to a place: not squeezed under the category
    // drawer, and not emptied while a category's rows load. The browser cuts
    // a scroll short to whatever width there is, and on a television the
    // grid was left at the start of the window -- six hours ago -- with the
    // rows of a channel whose guide starts now drawn empty.
    const roomFor = (left: number) => scroller.scrollWidth - scroller.clientWidth >= left - 1;

    const keepPlace = (tries: number) => {
      if (lastLanes <= 0) {
        return;
      }
      const target = wanted();
      if (Math.abs(scroller.scrollLeft - target) <= 1) {
        placedAt = scroller.scrollLeft;
        return;
      }
      if (!roomFor(target)) {
        // Put back once the rows are wide again: they are watched below.
        return;
      }
      scroller.scrollLeft = target;
      placedAt = scroller.scrollLeft;
      follow();
      if (Math.abs(placedAt - target) > 1 && tries > 0) {
        requestAnimationFrame(() => keepPlace(tries - 1));
      }
    };
    // Only when the lanes moved sideways. Every Down in the guide scrolls the
    // rows, and setting the variable again -- even to the same value -- had
    // the WebView restyle every programme on screen that reads it: half a
    // second of style work in twenty-five presses on the TV emulator at a
    // television's speed (10 October).
    let followedLeft = Number.NaN;
    const follow = () => {
      const left = scroller.scrollLeft;
      if (left === followedLeft) {
        return;
      }
      followedLeft = left;
      head.style.transform = `translateX(${-left}px)`;
      scroller.style.setProperty('--guide-scroll', `${left}px`);
    };
    const byHand = () => (handUntil = Date.now() + 2000);
    const onScroll = () => {
      follow();
      if (placedAt < 0 || Math.abs(scroller.scrollLeft - placedAt) <= 1) {
        return;
      }
      // Cut short by the layout shrinking, not moved by anybody.
      if (!roomFor(placedAt)) {
        return;
      }
      // Somebody going through the guide: a programme in focus, which a
      // remote only reaches by pressing, or a hand on the lanes.
      const focused = (document.activeElement as HTMLElement | null)?.getAttribute('data-focus-key') ?? '';
      if (focused.startsWith('prog-') || Date.now() < handUntil) {
        viewerLeft = scroller.scrollLeft;
        placedAt = viewerLeft;
        return;
      }
      // Moved by something else: focus put back on a channel's name scrolls
      // the lanes too, though the name itself is stuck to the left.
      keepPlace(3);
    };

    const resized = new ResizeObserver(() => measure());
    resized.observe(scroller);
    if (channelColumn) {
      resized.observe(channelColumn);
    }
    if (rows) {
      resized.observe(rows);
    }
    scroller.addEventListener('scroll', onScroll, { passive: true });
    for (const event of ['wheel', 'pointerdown', 'touchstart', 'touchmove'] as const) {
      scroller.addEventListener(event, byHand, { passive: true });
    }
    measure();
    follow();
    onCleanup(() => {
      resized.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      for (const event of ['wheel', 'pointerdown', 'touchstart', 'touchmove'] as const) {
        scroller.removeEventListener(event, byHand);
      }
    });
  });

  /**
   * From GUIDE_GRID_BACK_HOURS before the start of the current hour: the grid
   * opens scrolled to the current hour, as the boards draw it, and going left
   * reaches what has finished, for catch-up.
   *
   * Worked out each time rather than once, because this screen stays open on a
   * television for hours and the window used to stay where it was when the
   * component was made -- with the now-line walking off its right edge.
   */
  private get windowStartMs(): number {
    // Once a minute rather than a new Date per call: it was asked for per
    // programme, per row, on every key press, and showed in the profile.
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.windowStartMinute) {
      const start = new Date();
      start.setMinutes(0, 0, 0);
      this.windowStartMinute = minute;
      this.windowStartCached = start.getTime() - GUIDE_GRID_BACK_HOURS * 60 * 60 * 1000;
    }
    return this.windowStartCached;
  }
  private windowStartMinute = -1;
  private windowStartCached = 0;

  private get windowEndMs(): number {
    return this.windowStartMs + this.epgWindowHours() * 60 * 60 * 1000;
  }

  constructor() {
    // Back from a show arrives with the category open again, but the grid only
    // builds the rows on screen: the show's card is not there to be found
    // until its row is scrolled in.
    inject(PlaceMemoryService).revealWith(key => this.reveal(key));

    // A guide that finishes loading -- by hand on the Guides page, or on its
    // own because it was running out -- changes what every row on this screen
    // has to draw. Nothing told the listing, so a reload that worked still
    // showed "No guide" until the category was opened again.
    //
    // The first run is skipped: the report already there on arrival describes
    // a load this screen's own data was fetched after.
    let seenReport = this.guide.lastReport();
    effect(() => {
      const report = this.guide.lastReport();
      if (report === seenReport) {
        return;
      }
      seenReport = report;
      if (report && this.type() === 'live') {
        untracked(() => this.refreshGuide());
      }
    });

    this.categorySort.set(this.xtreamService.getCategorySort());
    this.streamSort.set(this.xtreamService.getStreamSort());

    // What the back key should close. Which is topmost is decided by the order
    // they were opened in, not the order they are listed here.
    this.back.bindTo(this.showPlayer, () => this.closePlayer());
    this.back.bindTo(this.showEPG, () => this.closeEPG());
    this.back.bindTo(this.showReorder, () => this.closeReorder());
    // The phone's category sheet. Unbound, Back went past it and closed the
    // category underneath, leaving the sheet open over the library's front
    // page (the phone walk, 22 September).
    this.back.bindTo(this.showCategorySheet, () => this.showCategorySheet.set(false));
    this.back.bindTo(
      computed(() => this.menuTarget() !== null),
      () => this.closeMenu()
    );

    // Browsing a category is a place you can be, not just a state, so back
    // should leave it before it leaves the section. Registered last of these
    // but opened first in practice, which puts it underneath the dialogs --
    // exactly where it belongs.
    // "Right or Back closes one level -- never both" (TV-N-1c), and back's
    // registry is newest-first, so the drawer needs a layer per level rather
    // than one for the whole thing. With one, the first press closed a level
    // and took the layer with it, and the second left the screen: Back closed
    // everything at once, which is precisely what the board rules out.
    //
    // Registered before `browsing` so that a press with the drawer open never
    // reaches "leave the screen" -- that one is the last resort, which is what
    // "Back at the rail exits the screen" means.
    // The navigation's own layer is the shell's, which has one on every screen.
    this.back.bindTo(
      computed(() => this.drawer() !== 'closed'),
      () => this.closeDrawer()
    );

    this.back.bindTo(this.browsing, () => this.backToHome());

    // The categories are a level of the drawer only while this screen is
    // showing them. Left goes straight to the navigation everywhere else, and
    // a level that outlived its panel would be a press that opened nothing.
    effect(() => this.drawers.offersCategories.set(this.browsing()));
    inject(DestroyRef).onDestroy(() => {
      this.drawers.offersCategories.set(false);
      this.drawers.shut();
    });

    // Moving between libraries is a fresh start: the category, the search and
    // both rails belong to the section that was left behind.
    effect(() => {
      const type = this.type();
      untracked(() => this.enterSection(type));
    });

    // Something starred or watched on another device. The rails are what would
    // be wrong, and they are cheap to fetch again.
    effect(() => {
      this.deviceSync.remoteChanges();
      untracked(() => {
        if (this.type()) {
          this.refreshRails(this.type());
        }
      });
    });

    // The grid's column count is a layout fact, not a breakpoint: the browse
    // column is resizable and the card list has to regroup with it.
    effect(onCleanup => {
      const viewport = this.gridViewport()?.nativeElement;
      if (!viewport) {
        return;
      }
      // Read so the count is worked out again when the TV scale arrives: the
      // width does not change then, but the size of a card does.
      this.minCardWidthPx();
      this.gridGapPx();
      this.measureGridColumns(viewport.clientWidth);
      const observer = new ResizeObserver(entries => {
        this.measureGridColumns(entries[0].contentRect.width);
      });
      observer.observe(viewport);
      onCleanup(() => observer.disconnect());
    });

    // Whether there is room to dock the actions panel follows the window.
    const wide = window.matchMedia(WIDE_LAYOUT_QUERY);
    const onWidth = () => this.wideEnoughToDock.set(wideLayoutNow());
    wide.addEventListener('change', onWidth);

    document.addEventListener('keydown', this.onNumberKey);

    inject(DestroyRef).onDestroy(() => {
      wide.removeEventListener('change', onWidth);
      document.removeEventListener('keydown', this.onNumberKey);
      if (this.numberTimer !== null) {
        clearTimeout(this.numberTimer);
      }
    });

    // Resume bars on the cards need a position per listed item, and the list
    // changes for reasons this component does not always initiate.
    effect(() => {
      const streams = this.store.streams();
      const type = untracked(() => this.type());
      if (type === 'live' || streams.length === 0) {
        return;
      }
      untracked(() => this.loadProgressFor(type, streams));
    });
  }

  // --- Section lifecycle --------------------------------------------------

  private enterSection(type: StreamType): void {
    this.form.reset({ selectedCategory: '', searchTerm: '' });
    this.selectedCategory.set('');
    this.searching.set(false);
    this.progressByItem.set({});

    // Only passing through, to play what a film's page or a search asked
    // for and go straight back: a library's whole category list is not
    // needed for that, and on a television it was still loading -- and on
    // screen -- when the player closed (29 October). Live channels
    // load it all the same: Channel Up and Down step through it.
    const params = this.route.snapshot.queryParamMap;
    const passingThrough = !!params.get('play') && params.get('return') === '1' && type !== 'live';

    // Back to the category this library last showed -- from a film's page, a
    // show's -- finds its list still in the store: kept on screen while it is
    // read again, rather than "Loading…" over an empty page each time (the
    // owner, 29 October). And a play passing through leaves it there for that.
    const returningTo = params.get('category');
    const keep =
      passingThrough ||
      (!!returningTo &&
        this.store.selectedType() === type &&
        this.store.selectedCategory() === returningTo &&
        !this.store.isGlobalSearch() &&
        this.store.allStreams().length > 0);

    this.store['setSelectedType'](type);
    // The sort these categories are drawn with: an arrangement made on another
    // device, or in this account's setup elsewhere, can be the newer decision.
    this.categorySort.set(this.xtreamService.categorySortFor(type));
    if (!keep) {
      this.store['setSelectedCategory']('');
      this.store['setStreams']([]);
    }
    this.store['setSearchTerm']('');
    if (!passingThrough) {
      this.store['loadCategories'](type);
      this.refreshRails(type);
    }

    // Back from a show's page lands here with the category or search it was
    // opened from in the address (see `markWhereWeAre`), and reopens it
    // rather than the front page.
    const category = params.get('category');
    const query = params.get('q');
    if (params.get('play')) {
      this.playOnArrival(type);
    } else if (category) {
      this.onCategorySelected(category, keep);
    } else if (query) {
      this.form.controls.searchTerm.setValue(query);
      this.searchStreams();
    }
  }

  /** "Starting HRT 1", while a play asked for from another page gets going. */
  readonly starting = signal<string | null>(null);

  /** The player has closed and this page is about to go back to the one that asked: covered. */
  readonly leaving = signal(false);

  /** Set when playback was asked for by another page, which it returns to afterwards. */
  private returnAfterPlayback = false;

  /**
   * Plays what another page asked for, then goes back to it.
   *
   * For You (FY-TV, FY-D) offers a channel, a film and an episode side by
   * side, but playing one takes everything this section already does for it
   * -- the native player, the saved position, the channel keys stepping
   * through a list, the retry when the provider is slow to let go of a stream
   * -- so rather than a second copy of all that, For You opens this section
   * with `?play=<id>&kind=recent|favourite|stream` and this does it the same
   * way a card here would. The history entry For You made stays behind the
   * section's, so the player closing goes back there.
   */
  private playOnArrival(type: StreamType): void {
    const params = this.route.snapshot.queryParamMap;
    const itemId = params.get('play') ?? '';
    const kind = params.get('kind');
    const name = params.get('name') ?? '';
    const icon = params.get('icon') ?? '';

    this.returnAfterPlayback = params.get('return') === '1';
    this.starting.set(posterTitle(name).title || name);

    forkJoin({
      recent: this.xtreamService.getRecentlyWatched(type).pipe(catchError(() => of([] as WatchProgress[]))),
      favourites: this.xtreamService.getFavorites(type).pipe(catchError(() => of([] as Stream[])))
    }).subscribe(({ recent, favourites }) => {
      this.recent.set(recent);
      this.favorites.set(favourites);

      // Compared as text: the address carries text, and history can hold an id
      // as a number -- which failed to match, and a film started from 0:00.
      const entry = recent.find(candidate => String(candidate.itemId) === itemId && candidate.type === type);
      if (kind === 'recent' && entry) {
        this.resumeEntry(entry);
        return;
      }

      const stream =
        favourites.find(candidate => String(candidate.stream_id) === itemId) ??
        ({ stream_id: itemId, name, icon, stream_icon: icon } as Stream);
      // "Start over" on a film's page (TV-27): from 0:00, whatever was saved.
      if (params.get('from') === 'start' && type === 'vod') {
        this.play(this.asPlayingItem(stream, type), 0);
        return;
      }
      // From Search: the channel keys step through what that search found,
      // so the player opens in the live layout with somewhere to go (the
      // owner, 31 October) rather than with the favourites, or nothing.
      const found = (history.state as { channels?: Stream[] } | null)?.channels;
      if (kind === 'search' && type === 'live' && Array.isArray(found) && found.length > 1) {
        const chosen = found.find(candidate => String(candidate.stream_id) === itemId) ?? stream;
        this.channelList = found.map(item => this.asPlayingItem(item, 'live'));
        this.channelListTitle = t('nav.search');
        this.play(this.asPlayingItem(chosen, 'live'), 0);
        return;
      }
      // On the front page a channel steps through the favourites, which is
      // what an On-now card on For You is one of.
      this.onStreamClick(stream);
    });
  }

  /**
   * After a play asked for by another page: back to it, failed or not.
   *
   * A failure used to stay here, to say why -- which left whoever pressed Play
   * on a film's page or a search result looking at this section's front page
   * behind the error, focus in the menu, the page they came from a Back away
   * (26 October). The error is a dialog, which shows over any page.
   */
  private returnIfAsked(): boolean {
    this.starting.set(null);
    if (!this.returnAfterPlayback) {
      return false;
    }
    this.returnAfterPlayback = false;
    this.returnedToCaller = true;
    this.location.back();
    return true;
  }

  /** Whether this section went back to the page that asked it to play: its own player is no longer behind the screen. */
  private returnedToCaller = false;

  /**
   * Writes the open category or search into this page's address, in place.
   *
   * The section keeps what is open in memory, so a show's Back button -- which
   * goes back in history -- used to arrive at a fresh TV Shows front page,
   * however deep in a category the show had been found. With this, the entry
   * it goes back to says where that was.
   *
   * As soon as a category or a search opens, not only on the way into a show:
   * any other way out -- Guides from the menu, a channel's guide, the next
   * library -- came Back to the front page too.
   */
  private markWhereWeAre(): Promise<boolean> {
    const searching = this.searching() && !this.selectedCategory();
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        category: this.selectedCategory() || null,
        q: searching ? this.form.controls.searchTerm.value || null : null
      },
      replaceUrl: true
    });
  }

  /** Reloads what the front page shows: history and favourites. */
  private refreshRails(type: StreamType): void {
    this.xtreamService.getRecentlyWatched(type).subscribe(entries => this.recent.set(entries));
    this.crossRecent.set(null);
    if (type !== 'live') {
      const other: StreamType = type === 'vod' ? 'series' : 'vod';
      this.xtreamService.getRecentlyWatched(other, 1).subscribe({
        next: entries => this.crossRecent.set(entries.find(entry => !isComplete(entry)) ?? null),
        error: () => this.crossRecent.set(null)
      });
    }
    this.xtreamService.getFavorites(type).subscribe({
      next: streams => this.favorites.set(streams),
      error: () => this.favorites.set([])
    });
    this.xtreamService.getFavoriteIds(type).subscribe({
      next: ids => this.favoriteIds.set(new Set(ids)),
      error: () => this.favoriteIds.set(new Set())
    });
  }

  private loadProgressFor(type: StreamType, streams: Stream[]): void {
    const ids = streams.map(s => String(s.stream_id));
    this.xtreamService.getProgressFor(type, ids).subscribe(map => this.progressByItem.set(map));
  }

  // --- Browsing -----------------------------------------------------------

  /**
   * Left, from somewhere in the guide or the grid.
   *
   * Only when the press had nowhere else to go. `TvNavigationService` listens
   * in the capture phase and calls `preventDefault` when it moves focus, so a
   * press that arrives here unprevented is one that found nothing to its left:
   * the edge of the row. Left in the middle of a row still walks the row, which
   * is what it is for, and Left at the edge opens the panel -- one key doing
   * the obvious thing in both places, without this component having to know
   * where the edge is.
   */
  onDrawerKey(event: KeyboardEvent): void {
    // Typing: Left is the caret's, from the on-screen keyboard's "<" (isEditing).
    if (event.defaultPrevented || !this.tvNavigation.isTelevision() || isEditing(event.target)) {
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.openDrawer();
    }
  }

  /**
   * Right or Back, from inside an open panel: close one level.
   *
   * Same rule, read the same way. While the categories are open they are a
   * focus scope, so the arrows cannot leave them; a Right that finds nothing to
   * its right arrives here unprevented, and that is the press that means
   * "done with this panel".
   */
  onPanelKey(event: KeyboardEvent): void {
    // Typing in the categories' filter: Right and Backspace edit it.
    if (event.defaultPrevented || !this.tvNavigation.isTelevision() || isEditing(event.target)) {
      return;
    }

    if (event.key === 'ArrowRight' || event.key === 'Escape' || event.key === 'Backspace') {
      event.preventDefault();
      this.closeDrawer();
    }

    // Left is deliberately not answered here. Beyond the categories is the
    // navigation, and that belongs to the shell now -- so the press is left
    // unprevented and carries on up to it. Answering it here and finding
    // nowhere to go is what made the second Left do nothing at all.
  }

  /**
   * One level further open, remembering where the guide was.
   *
   * "Second Left pushes again rather than stacking" (TV-N-1c): the navigation
   * does not lie over the categories, it moves them along, so all three are on
   * screen at once and the arrows never cross a gap.
   */
  openDrawer(): void {
    if (this.drawer() !== 'closed') {
      return;
    }

    this.cameFrom = this.focusedKey();
    this.drawers.deeper();
  }

  /**
   * Focus follows the level, whoever changed it.
   *
   * It used to be placed by whichever method moved the drawer, which worked
   * only while this screen moved it. The navigation is the shell's now and the
   * shell closes it without knowing what is underneath -- so Right out of the
   * navigation left focus on the panel that had just been removed, and the next
   * press had nothing to move from. Watching the level instead means every
   * route into a level lands the same way: the one the shell takes, the one
   * this screen takes, and Back.
   */
  private readonly landsOnLevel = effect(() => {
    const level = this.drawer();
    if (!this.tvNavigation.isTelevision()) {
      return;
    }

    untracked(() => {
      if (level === 'categories') {
        // After the panel has been given its width, or the row it wants to
        // focus is still eighty pixels wide and clipped.
        requestAnimationFrame(() => this.picker()?.showSelected());
        return;
      }

      if (level === 'closed' && this.cameFrom) {
        const key = this.cameFrom;
        this.cameFrom = null;
        requestAnimationFrame(() => this.tvNavigation.focusItem(key));
      }
    });
  });

  /**
   * Hiding, locking and unlocking change what this screen may show.
   *
   * The categories, favourites and history are asked for again, and filtered
   * again on the way. A category that has just locked is closed, and a locked
   * channel still playing in the page is stopped -- IPTVnator's rule, and the
   * point of locking: what is behind the PIN is not on screen. A category that
   * has only been hidden stays open until it is left; hiding it was a choice
   * made from inside it.
   *
   * The same for the account's providers changing -- one added, replaced or
   * switched off, here or on another device: the lists are asked for again,
   * and a category of a provider no longer switched on is closed.
   */
  private lockSeen = false;
  private readonly followsTheLock = effect(() => {
    this.lock.revision();
    this.providerAccess.revision();
    if (!this.lockSeen) {
      this.lockSeen = true;
      return;
    }
    untracked(() => {
      const type = this.type();
      if (!type) {
        return;
      }
      this.store['loadCategories'](type);
      this.refreshRails(type);

      const open = this.selectedCategory();
      // No records at all is a browser, which never reads them.
      const providerGone =
        !!open &&
        open !== this.FAVORITES_CATEGORY &&
        this.providerAccess.records().length > 0 &&
        !this.providerAccess.records().some(record => record.enabled && record.tag === untagged(open).tag);
      if (open && (this.lock.lockedOutOf(type).includes(open) || providerGone)) {
        this.backToHome();
      } else if (open === this.FAVORITES_CATEGORY) {
        this.loadStreams();
      }

      const playing = this.playing();
      if (this.showPlayer() && playing) {
        void this.xtreamService.isLockedOut(playing.type, playing.itemId).then(out => {
          if (out && this.playing() === playing) {
            this.closePlayer();
          }
        });
      }
    });
  });

  /**
   * One level back, and at the last one focus returns where it came from.
   *
   * "Right or Back closes one level — never both" (TV-N-1c), which is what
   * makes two Rights land on the exact programme you started from rather than
   * somewhere near it.
   */
  closeDrawer(): void {
    this.drawers.shallower();
  }

  /**
   * The category's own first channel, once it has loaded.
   *
   * Not the first thing in the page straight away: until the new category
   * arrives, the rows on screen are still the old one's, and focusing one of
   * those only lost focus again when they were replaced. So focus is let go
   * now, and put on the new rows when the streams that are showing are no
   * longer the ones that were showing here.
   */
  private landOnFirstChannel(): void {
    if (!this.tvNavigation.isTelevision()) {
      return;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    this.landingFrom.set({ streams: this.store.streams() });
  }

  private readonly landingFrom = signal<{ streams: unknown } | null>(null);

  private readonly landsOnNewCategory = effect(() => {
    const landing = this.landingFrom();
    const streams = this.store.streams();
    if (!landing || this.store.loading() || streams === landing.streams) {
      return;
    }
    untracked(() => {
      this.landingFrom.set(null);
      // After the rows for them have been drawn.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active && active !== document.body) {
            return;
          }
          this.tvNavigation.focusContentWhenReady();
        })
      );
    });
  });

  /** The keyed item focus is on now, if it is on one. */
  private focusedKey(): string | null {
    const active = document.activeElement as HTMLElement | null;
    return active?.closest<HTMLElement>('[data-focus-key]')?.getAttribute('data-focus-key') ?? null;
  }

  /** `quietly`: its list is already on screen, and is read again behind it. */
  onCategorySelected(categoryId: string, quietly = false): void {
    // Chosen from the open panel: the row focus was on goes with the panel,
    // and nothing put it anywhere, so the first press after choosing only
    // found it again. Before the load starts, so the rows it replaces are the
    // ones noted.
    if (this.drawer() !== 'closed') {
      this.landOnFirstChannel();
    }
    const type = this.type();
    this.chosenCategory.update(chosen => ({ ...chosen, [type]: categoryId }));
    try {
      localStorage.setItem(`${LAST_CATEGORY_KEY}${type}`, categoryId);
    } catch {
      // Storage unavailable: remembered for this run only.
    }
    this.quickFilter.set('all');
    this.form.patchValue({ selectedCategory: categoryId });
    this.selectedCategory.set(categoryId);
    this.searching.set(false);
    this.loadStreams(quietly);
    void this.markWhereWeAre();

    // "OK loads the category and collapses in one press" (TV-N-1b). Choosing is
    // the end of what the panel was open for, and leaving it open would put the
    // list somebody has finished with in front of the answer they asked for.
    if (this.drawer() !== 'closed') {
      this.drawer.set('closed');
      this.cameFrom = null;
    }
  }

  /** Back to the section's front page. */
  backToHome(): void {
    this.form.reset({ selectedCategory: '', searchTerm: '' });
    this.selectedCategory.set('');
    this.searching.set(false);
    this.store['setSelectedCategory']('');
    this.store['setStreams']([]);
    this.refreshRails(this.type());
    if (this.route.snapshot.queryParamMap.keys.length) {
      void this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
    }

    // Back out of a category took the guide or the grid away and left focus on
    // nothing, so the first press on the front page only found it again (the
    // QA walk, 21 September). Land on the tile the category was entered from,
    // which is where somebody who pressed Back was last on this page.
    if (this.tvNavigation.isTelevision()) {
      (document.activeElement as HTMLElement | null)?.blur();
      this.landOnBrowseTile();
    }
  }

  /** The front page's "Browse" tile once it is drawn and enabled, or its first card. */
  private landOnBrowseTile(triesLeft = 20): void {
    requestAnimationFrame(() => {
      const tile = document.querySelector<HTMLElement>('[data-tv-browse-tile]:not([disabled])');
      if (tile) {
        tile.focus({ preventScroll: false });
        return;
      }
      if (triesLeft > 0) {
        this.landOnBrowseTile(triesLeft - 1);
      } else {
        this.tvNavigation.focusContentWhenReady();
      }
    });
  }

  loadStreams(quietly = false): void {
    const categoryId = this.form.controls.selectedCategory.value;
    const type = this.type();
    if (!categoryId) {
      return;
    }

    this.store['setSelectedCategory'](categoryId);

    if (categoryId === this.FAVORITES_CATEGORY) {
      this.xtreamService.getFavorites(type).subscribe({
        next: streams => this.store['setStreams'](streams),
        error: err => console.error('Failed to load favourites', err)
      });
      return;
    }

    // Per category: one arranged since this device last chose a sort follows
    // its arrangement, as the list itself now does (XtreamService.streamSortFor).
    this.streamSort.set(this.xtreamService.streamSortFor(type, categoryId));
    this.store['loadStreams']({ categoryId, type, quietly });
  }

  /**
   * The search somebody most likely meant, when theirs carried provider marks:
   * "sjeverni ⱽᴵᴾ" is "sjeverni". Null when taking them off changes nothing.
   */
  readonly searchRescue = computed(() => {
    const term = (this.searchTerm() ?? '').trim();
    const plain = withoutTags(term).replace(/^\s*[A-Za-z]{2,3}\s*[|:-]\s*/, '').trim();
    return plain && plain !== term && plain.length >= 3 ? plain : null;
  });

  /** The library being indexed for search, if one is. */
  readonly indexing = this.xtreamService.indexing;

  /** When this library's search index was last built on this device. */
  private readonly searchIndexedAt = signal<string | null>(null);

  /** "Search index from today at 19:40", or that there is none yet. */
  readonly searchIndexLabel = computed(() => {
    const at = this.searchIndexedAt();
    if (!at) {
      return t('section.notIndexed');
    }
    const when = new Date(at);
    const today = new Date();
    const clock = clockTime(when.getTime());
    const sameDay = when.toDateString() === today.toDateString();
    return sameDay ? t('section.indexToday', { time: clock }) : t('section.indexFrom', { date: when.toLocaleDateString(locale()), time: clock });
  });

  /** Read once a search's results are in, since the search may have just built the index. */
  private readonly readIndexAgeAfterSearch = effect(() => {
    if (this.store.isGlobalSearch() && !this.store.loading() && !this.indexing()) {
      untracked(() => this.refreshSearchIndexedAt());
    }
  });

  private refreshSearchIndexedAt(): void {
    this.xtreamService.libraryIndexedAt(this.type()).subscribe(at => this.searchIndexedAt.set(at));
  }

  /** The Reindex button: fetch the whole library again now, then search again. */
  reindexSearch(): void {
    const type = this.type();
    this.xtreamService.reindexLibrary(type).subscribe(() => {
      this.refreshSearchIndexedAt();
      this.searchStreams();
    });
  }

  searchFor(term: string): void {
    this.form.controls.searchTerm.setValue(term);
    this.searchStreams();
  }

  searchStreams(): void {
    const term = this.form.controls.searchTerm.value?.trim();
    if (!term) {
      return;
    }

    // Within a category the list is already in hand, so filter it rather than
    // going back to the server for a subset of what is on screen.
    if (this.selectedCategory() && this.store.allStreams().length > 0) {
      this.store['filterStreams'](term);
      return;
    }

    if (term.length < 3) {
      return;
    }

    this.searching.set(true);
    this.store['setSearchTerm'](term);
    this.store['searchStreams']({ query: term, types: [this.type()] });
    void this.markWhereWeAre();
  }

  clearSearch(): void {
    this.form.controls.searchTerm.patchValue('');
    this.store['clearSearch']();
    if (!this.selectedCategory()) {
      this.searching.set(false);
      this.store['setStreams']([]);
    }
  }

  // --- Favourites ---------------------------------------------------------

  isFavorite(stream: Stream): boolean {
    return this.favoriteIds().has(String(stream.stream_id));
  }

  toggleFavorite(stream: Stream, event: Event): void {
    // The card itself starts playback; the star must not.
    event.stopPropagation();
    this.setFavourite(stream, !this.isFavorite(stream));
  }

  /**
   * Stars or unstars, whoever asked.
   *
   * Split out from the star on a card once the actions panel could ask for the
   * same thing: the panel has no event to stop, and the two must not be able to
   * disagree about what starring does.
   */
  private setFavourite(stream: Stream, nowFavorite: boolean): void {
    const type = this.type();
    const id = String(stream.stream_id);

    // Reflect the click straight away; the request is a formality.
    const next = new Set(this.favoriteIds());
    if (nowFavorite) {
      next.add(id);
    } else {
      next.delete(id);
    }
    this.favoriteIds.set(next);

    this.xtreamService.setFavorite(stream, type, nowFavorite).subscribe({
      next: () => {
        // Keeps this device's cursor past its own write, so the next pull does
        // not report the change back as though another device had made it.
        this.deviceSync.syncNow();
        this.xtreamService.getFavorites(type).subscribe(streams => this.favorites.set(streams));
        // Un-starring from within the favourites list should remove the row.
        if (!nowFavorite && this.selectedCategory() === this.FAVORITES_CATEGORY) {
          this.loadStreams();
        }
      },
      error: err => {
        console.error('Failed to update favourite', err);
        this.xtreamService
          .getFavoriteIds(type)
          .subscribe(ids => this.favoriteIds.set(new Set(ids)));
      }
    });
  }

  openFavorites(): void {
    this.onCategorySelected(this.FAVORITES_CATEGORY);
  }

  /**
   * "834 categories · guide from 2 sources" or "363 categories · 4 part-watched"
   * under the front page's title (D-1, D-4, TV-12).
   *
   * The boards also count every channel and film; the device only knows the
   * categories it has opened, and counting the rest would mean asking the
   * provider for all of them, which is a sweep.
   */
  readonly frontCounts = computed(() => {
    const categories = this.store.categories().length;
    const parts = [categories ? t('section.categoriesCount', { count: categories }) : ''];
    if (this.type() === 'live') {
      const guides = this.guideSources.sources().filter(source => source.enabled).length;
      parts.push(guides ? t('section.guideFrom', { count: guides }) : '');
    } else {
      // Shows counted as shows, as Continue watching lists them.
      const started = this.type() === 'series' ? this.continueShown().length : this.recent().filter(entry => !isComplete(entry)).length;
      parts.push(started ? t('section.partWatched', { count: started }) : '');
    }
    return parts.filter(Boolean).join(' · ');
  });

  readonly searchPlaceholder = computed(() =>
    t(this.type() === 'live' ? 'section.searchChannels' : this.type() === 'vod' ? 'section.searchFilms' : 'section.searchShows')
  );

  /** How many favourites the front page shows before "+ N more" (D-1, D-4). */
  readonly FRONT_FAVOURITES = 6;

  /** The favourites one per title -- a film starred in 4K and in HD is one card -- in the order starred. */
  readonly favouriteTitles = computed(() => (this.type() === 'live' ? this.favorites() : firstPerTitle(this.favorites(), stream => stream.name)));

  readonly frontFavourites = computed(() => this.favouriteTitles().slice(0, this.FRONT_FAVOURITES));

  /**
   * The most recent thing part-watched in the other library -- a show on
   * Movies, a film on TV Shows -- for "Continue a show instead" (D-4).
   */
  readonly crossRecent = signal<WatchProgress | null>(null);

  /** "34 min left", for that card. */
  readonly crossRemaining = computed(() => remainingLabel(this.crossRecent()));

  /** "FR" of "FR - Supernatural": two copies of a show told apart. */
  prefix(name: string): string {
    return namePrefix(name);
  }

  /** "Watched last night", for a show's card. */
  menuWhen(entry: WatchProgress): string {
    return t('fy.watched', { when: watchedWhen(entry.updatedAt, new Date()) });
  }

  /** A history entry's name without the provider's tags and year. */
  recentTitle(entry: WatchProgress): string {
    return posterTitle(entry.name).title;
  }

  recentYear(entry: WatchProgress): string {
    return posterTitle(entry.name).year;
  }

  monogramOf(title: string): string {
    return channelMonogram(title);
  }

  /** A history entry's logo that did not load; the initials take its place. */
  iconFailed(itemId: string): void {
    const next = new Set(this.brokenLogos());
    next.add(String(itemId));
    this.brokenLogos.set(next);
  }

  channelNumberOf(stream: Stream): string {
    const num = (stream as unknown as Record<string, unknown>)['num'];
    return num === null || num === undefined || num === '' ? '' : String(num);
  }

  /**
   * The category this library was last left in, on this device, if it still
   * exists -- the one "Browse" opens.
   *
   * It opened the first in the list every time, which on this provider is
   * "4K RELAX 1920P": every evening began with a trip through eight hundred
   * categories to reach the one watched the evening before (22
   * September). Per device rather than synced: a television and a phone are
   * used for different things.
   */
  readonly lastCategory = computed(() => {
    const categories = this.store.categories();
    const remembered = this.rememberedCategory();
    if (remembered === this.FAVORITES_CATEGORY) {
      return { id: remembered, name: t('cat.favourites') };
    }
    const found = categories.find(category => String(category.category_id) === remembered);
    return found ? { id: String(found.category_id), name: withoutTags(found.category_name) } : null;
  });

  /** Chosen in this run, by library; storage is read only for one not chosen yet. */
  private readonly chosenCategory = signal<Record<string, string>>({});

  private readonly rememberedCategory = computed(() => {
    const type = this.type();
    const chosen = this.chosenCategory()[type];
    if (chosen !== undefined) {
      return chosen;
    }
    try {
      return localStorage.getItem(`${LAST_CATEGORY_KEY}${type}`);
    } catch {
      return null;
    }
  });

  /** Into the categories: where this library was last left, or the first in the list. */
  browseCategories(): void {
    const first = this.lastCategory()?.id ?? this.store.categories()[0]?.category_id;
    if (first !== undefined) {
      // The tile focus was on is about to go, and nothing else would put it
      // anywhere: the guide opened with nothing focused and the first press
      // was spent finding it (the QA walk, 21 September).
      this.landOnFirstChannel();
      this.onCategorySelected(String(first));
    }
  }

  // --- Rows by category, and what was added (NX-TV-7) -------------------------

  /** Category rows on a library's front page, at most. */
  readonly FRONT_CATEGORY_ROWS = 4;
  /** Posters in each before the row ends in "All". */
  readonly FRONT_ROW_POSTERS = 12;

  /**
   * The category rows: the ones opened most on this device (1
   * November), then the one this library was left in and the next in its
   * order -- each only if this device already holds it, so the front page
   * asks the provider nothing. A hidden or locked
   * category is never one of them.
   */
  readonly categoryRows = signal<{ id: string; name: string; count: number; streams: Stream[] }[]>([]);

  /** Where the films in the category rows were left, for their meters. */
  private readonly rowProgress = signal<Record<string, WatchProgress>>({});

  /** How far a row's film got, or 0 when it was never started or was finished. */
  rowPercent(stream: Stream): number {
    const percent = watchedPercent(this.rowProgress()[String(stream.stream_id)] ?? null);
    return percent < 100 ? percent : 0;
  }

  /**
   * Whether TMDB's rows are on the page ('rows'), or there is no TMDB and the
   * category rows stand in ('none'); null until it is known, for each library.
   */
  readonly discoverState = linkedSignal<StreamType, DiscoverState | null>({ source: this.type, computation: () => null });

  /**
   * What the library added lately, newest first, from this device's index:
   * one card per title, as a provider adds 4K, HD and each language of a
   * film together (The Odyssey twice in a row, 14 November).
   */
  readonly addedRow = signal<Stream[]>([]);

  private readonly loadFrontRows = effect(() => {
    const type = this.type();
    const categories = this.store.categories();
    const last = this.lastCategory();
    // The category rows only stand in for TMDB's; with TMDB, nothing is read for them.
    const withRows = this.discoverState() === 'none';
    this.lock.revision();
    if (type === 'live' || !categories.length) {
      this.categoryRows.set([]);
      this.addedRow.set([]);
      return;
    }
    untracked(() => {
      const known = new Set(categories.map(category => String(category.category_id)));
      const opened = mostOpened(readOpens(type)).filter(id => known.has(id));
      const ids = (withRows ? [...opened, last && last.id !== this.FAVORITES_CATEGORY ? last.id : null, ...known] : [])
        .filter((id): id is string => !!id && !this.lock.keepsOut(type, id))
        .filter((id, index, all) => all.indexOf(id) === index)
        .slice(0, this.FRONT_CATEGORY_ROWS + 2);
      void (async () => {
        const rows: { id: string; name: string; count: number; streams: Stream[] }[] = [];
        for (const id of ids) {
          if (rows.length >= this.FRONT_CATEGORY_ROWS) {
            break;
          }
          const streams = await firstValueFrom(this.xtreamService.heldStreams(id, type));
          const category = categories.find(one => String(one.category_id) === id);
          if (streams.length && category) {
            rows.push({ id, name: withoutTags(category.category_name), count: streams.length, streams: this.oneEach(streams) });
          }
        }
        if (this.type() === type) {
          this.categoryRows.set(rows);
          const ids = rows.flatMap(row => row.streams.map(stream => String(stream.stream_id)));
          if (ids.length) {
            this.xtreamService.getProgressFor(type, ids).subscribe(map => this.type() === type && this.rowProgress.set(map));
          }
        }
      })();
      // Asked for four times over, as copies of one title come in together.
      this.xtreamService.recentlyAdded(type, this.FRONT_ROW_POSTERS * 4).subscribe(added => {
        if (this.type() === type) {
          this.addedRow.set(this.oneEach(added.filter(stream => !this.lock.keepsOut(type, stream.category_id))));
        }
      });
    });
  });

  /**
   * A row's posters, one per title (the copy Play would choose, where the
   * first of them stood), from the head of the list: grouping a category of
   * thousands would hold up a television for the sake of twelve posters.
   */
  private oneEach(streams: readonly Stream[]): Stream[] {
    return oneCardPerTitle(streams.slice(0, this.FRONT_ROW_POSTERS * 4), stream => stream.name).slice(0, this.FRONT_ROW_POSTERS);
  }

  /**
   * The front page's spotlight before focus rests on a card (NX-TV-7): its
   * first title -- what is being watched, else a favourite, else the first
   * category row's, else what was added.
   */
  readonly frontSpot = computed<SpotTarget | null>(() => {
    const type = this.type();
    if (type === 'live') {
      return null;
    }
    const recent = this.continueRows().find(row => row.entry.type !== 'live');
    if (recent) {
      const entry = recent.entry;
      return { kind: entry.type, id: entry.type === 'series' ? (entry.seriesId ?? entry.itemId) : entry.itemId, name: recent.title, poster: entry.icon ?? '', line: '' };
    }
    const rows = this.discoverState() === 'none' ? this.categoryRows() : [];
    const stream = this.frontFavourites()[0] ?? rows[0]?.streams[0] ?? this.addedRow()[0];
    return stream ? { kind: type, id: String(stream.stream_id), name: posterTitle(stream.name).title, poster: stream.stream_icon ?? '', line: '' } : null;
  });

  /** "All 1 240": the whole category, in the browser. */
  openRowCategory(categoryId: string): void {
    this.landOnFirstChannel();
    this.chooseCategory(categoryId);
  }

  /** A category somebody picked, counted for the rows; one the app reopens by itself is not. */
  chooseCategory(categoryId: string): void {
    if (categoryId !== this.FAVORITES_CATEGORY) {
      const type = this.type();
      try {
        localStorage.setItem(`${CATEGORY_OPENS_KEY}${type}`, withOpening(readOpens(type), categoryId, Date.now()));
      } catch {
        // Storage unavailable: the rows keep their order.
      }
    }
    this.onCategorySelected(categoryId);
  }

  // --- The front page's guide ----------------------------------------------

  /**
   * Programmes for the channels on the front page -- favourites and the ones
   * watched lately -- read from this device's guide, never the provider.
   *
   * Kept apart from the store's, which belongs to whatever category is open
   * and is replaced when one is.
   */
  private readonly frontGuide = signal<GuideByStream>({});

  private readonly loadFrontGuide = effect(() => {
    if (this.type() !== 'live') {
      return;
    }
    const favourites = this.favorites();
    const recent = this.recent().filter(entry => entry.type === 'live');
    untracked(() => {
      const seen = new Set<string>();
      const streams: Stream[] = [];
      for (const stream of [
        ...favourites,
        ...recent.map(entry => ({ stream_id: entry.itemId, name: entry.name, icon: entry.icon ?? '' }) as Stream)
      ]) {
        const id = String(stream.stream_id);
        if (!seen.has(id)) {
          seen.add(id);
          streams.push(stream);
        }
      }
      if (!streams.length) {
        return;
      }
      this.xtreamService.guideForStreams(streams).subscribe({
        next: guide => this.frontGuide.set(guide ?? {}),
        error: () => this.frontGuide.set({})
      });
    });
  });

  /** What is on a front-page channel now, or null. */
  frontNow(streamId: string | number, name: string): NowPlaying | null {
    if (!this.frontGuide()[String(streamId)]?.length) {
      return null;
    }
    return this.nowPlayingOn({ stream_id: String(streamId), name } as Stream, this.frontGuide());
  }

  // --- Playback -----------------------------------------------------------

  // Opening a card from the keyboard used to be here. It moved into
  // `CardGesturesDirective`, which has to own the whole of Enter anyway: a
  // press that is held means something else now, and that cannot be decided
  // until the key comes back up.

  /**
   * A card's OK: a film opens its own page (round 6, TV-27), where the copy
   * is chosen and Play starts it; a channel or a show as before.
   */
  openCard(stream: Stream): void {
    const type = getStreamType(stream, this.type()) ?? this.type();
    if (type === 'vod' && this.xtreamService.isAuthenticated()) {
      void this.markWhereWeAre().then(() =>
        this.router.navigate(['/film', `s${stream.stream_id}`], {
          queryParams: { name: stream.name },
          state: { film: { name: stream.name, poster: stream.stream_icon || stream.icon || '' } }
        })
      );
      return;
    }
    this.onStreamClick(stream);
  }

  onStreamClick(stream: Stream): void {
    if (!this.xtreamService.isAuthenticated()) {
      return;
    }

    const type = getStreamType(stream, this.type()) ?? this.type();

    // A show is a list of episodes, not something to play; its own page is
    // where an episode gets chosen and where the resume point lives.
    if (type === 'series') {
      void this.markWhereWeAre().then(() =>
        this.router.navigate(['/series', stream.stream_id], {
          queryParams: { name: stream.name }
        })
      );
      return;
    }

    if (type === 'live') {
      // Where the channel keys will step through: the list on screen, or the
      // favourites rail it was opened from on the front page.
      this.channelList = (this.browsing() ? this.store.streams() : this.favorites()).map(item =>
        this.asPlayingItem(item, 'live')
      );
      this.channelListTitle = this.browsing() ? this.browseTitle() : t('cat.favourites');
    }

    const saved = this.progressByItem()[String(stream.stream_id)];
    this.play(this.asPlayingItem(stream, type), resumePosition(saved));
  }

  private asPlayingItem(stream: Stream, type: StreamType): PlayingItem {
    return {
      type,
      itemId: String(stream.stream_id),
      name: stream.name,
      icon: stream.stream_icon || stream.icon,
      number: (stream as { num?: string | number }).num != null ? String((stream as { num?: string | number }).num) : undefined,
      source: stream,
      containerExtension: (stream as { container_extension?: string }).container_extension
    };
  }

  // --- Number keys ------------------------------------------------------------

  /** The digits typed so far, shown as "12_" until they are acted on. */
  readonly numberTyped = signal('');

  /** "No channel 12", briefly, when the typed number matched nothing. */
  readonly numberMissing = signal<string | null>(null);

  private numberTimer: ReturnType<typeof setTimeout> | null = null;

  /** How long after the last digit the number is acted on. */
  private readonly NUMBER_PAUSE_MS = 1500;

  private readonly gridScroller = viewChild(CdkVirtualScrollViewport);
  private readonly posterRows = viewChild('gridViewport', { read: CdkVirtualScrollViewport });

  /**
   * The age lock's covers on the posters the scroller has drawn (TV-31):
   * their titles looked up on TMDB as they come into view, only while the
   * lock is on.
   */
  private readonly lockedPosters = effect(onCleanup => {
    const grid = this.posterRows();
    const type = this.type();
    if (!grid || !this.ages.engaged() || type === 'live') {
      return;
    }
    const seen = grid.renderedRangeStream.subscribe(range => {
      const streams = untracked(() => this.streamRows()).slice(range.start, range.end).flat();
      void this.ages.learnStreams(type, streams);
    });
    onCleanup(() => seen.unsubscribe());
  });

  /**
   * Scrolls a card or a guide row into the rendered range, for
   * `PlaceMemoryService` to find and put back where it was. False while the
   * item is not in the list -- the category may still be loading.
   */
  private reveal(key: string): boolean {
    const card = /^stream-(.+)$/.exec(key)?.[1];
    if (card !== undefined) {
      const index = this.shownStreams().findIndex(stream => String(stream.stream_id) === card);
      const grid = this.posterRows();
      if (index < 0 || !grid) {
        return false;
      }
      grid.scrollToIndex(Math.floor(index / Math.max(1, this.gridColumns())));
      return true;
    }
    const row = /^guide-(.+)$/.exec(key)?.[1] ?? /^prog-(.+)-\d+$/.exec(key)?.[1];
    if (row !== undefined) {
      const index = this.store.streams().findIndex(stream => String(stream.stream_id) === row);
      const guide = this.guideViewport();
      if (index < 0 || !guide) {
        return false;
      }
      guide.scrollToIndex(index);
      return true;
    }
    return false;
  }

  /**
   * A digit on the remote, in a category on a television.
   *
   * Typed a digit at a time, as on any television: 1, then 2, and a moment
   * later the ring is on channel 12. Not in a text field -- the filter takes
   * digits of its own -- and not before a D-pad has made this a television,
   * where a desktop keyboard's digits mean nothing to this screen.
   */
  private readonly onNumberKey = (event: KeyboardEvent): void => {
    if (!/^[0-9]$/.test(event.key) || !this.tvNavigation.isTelevision() || !this.browsing()) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
      return;
    }

    event.preventDefault();
    this.numberMissing.set(null);
    this.numberTyped.set((this.numberTyped() + event.key).slice(-4));

    if (this.numberTimer !== null) {
      clearTimeout(this.numberTimer);
    }
    this.numberTimer = setTimeout(() => this.goToTypedNumber(), this.NUMBER_PAUSE_MS);
  };

  private goToTypedNumber(): void {
    this.numberTimer = null;
    const typed = this.numberTyped();
    this.numberTyped.set('');
    if (!typed) {
      return;
    }

    const wanted = Number(typed);
    const streams = this.store.streams();
    const index = streams.findIndex(
      stream => Number((stream as unknown as Record<string, unknown>)['num']) === wanted
    );

    if (index < 0) {
      this.numberMissing.set(t('section.noChannel', { number: wanted }));
      setTimeout(() => this.numberMissing.set(null), this.NUMBER_PAUSE_MS);
      return;
    }

    const id = String(streams[index].stream_id);
    if (!this.listView()) {
      // The grid only builds the rows on screen: scroll the row in first.
      this.gridScroller()?.scrollToIndex(Math.floor(index / Math.max(1, this.gridColumns())));
    }
    setTimeout(() => {
      const element = document.querySelector<HTMLElement>(
        `[data-focus-key="guide-${id}"], [data-focus-key="stream-${id}"]`
      );
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: 'center' });
    }, 120);
  }

  // --- Changing channel from inside the player -----------------------------

  /** The channels the remote's channel keys step through, in order. */
  private channelList: PlayingItem[] = [];

  /** What that list is called, heading the mini guide in the player (PL-TV-4). */
  private channelListTitle = '';

  /** The channel watched before the current one, for the last-channel key. */
  private previousChannel: PlayingItem | null = null;

  /**
   * Opens the channel a channel key asked for, or returns false for none.
   *
   * The player has already closed -- that is how it says a key was pressed --
   * so the old stream is gone before this asks for the next, which the
   * provider's single connection requires.
   */
  private changeChannel(from: PlayingItem, step: ChannelStep): boolean {
    const ids = this.channelList.map(item => item.itemId);
    const target = channelAfter(ids, from.itemId, step, this.previousChannel?.itemId ?? null);
    if (!target) {
      return false;
    }

    const next =
      this.channelList.find(item => item.itemId === target) ??
      (this.previousChannel?.itemId === target ? this.previousChannel : null);
    if (!next) {
      return false;
    }

    this.previousChannel = from;
    this.channelChanging.set(this.display({ stream_id: next.itemId, name: next.name } as Stream).title);
    this.changedChannelAt = Date.now();
    this.retriedChannel = false;
    setTimeout(() => this.play(next, 0), CHANNEL_CHANGE_PAUSE_MS);
    return true;
  }

  /** "Changing to RTL LIVING", while the pause below runs. */
  readonly channelChanging = signal<string | null>(null);

  /** When the last channel change asked for its stream, to recognise a refusal that follows it. */
  private changedChannelAt = 0;
  private retriedChannel = false;

  /**
   * Whether a failure is the provider still holding the channel just closed.
   *
   * The subscription allows one connection, and the provider goes on counting
   * a stream for a moment after it is closed. On the TV emulator Channel Up
   * opened the next channel straight away and the provider answered with
   * something that was not a playlist; the same channel played perfectly on
   * its own a few seconds later. So a change waits before asking, and a
   * failure soon after a change is tried once more, after a longer wait.
   */
  private refusedAfterChange(result: { errorCode: string | null }): boolean {
    return (
      !!result.errorCode &&
      !this.retriedChannel &&
      Date.now() - this.changedChannelAt < CHANNEL_REFUSAL_WINDOW_MS
    );
  }

  /**
   * After the last channel of a run of channel changes, focus that channel.
   *
   * Somebody who pressed Channel Up four times and then Back expects to be on
   * the fourth channel in the guide, not on the one they started from.
   */
  private focusChannel(itemId: string): void {
    // The kind of card playback was started from comes first: a channel opened
    // from Favourites is also in Recently watched by the time the player
    // closes, and the page-order first match put the ring in the wrong rail.
    const origin = this.playStartedFrom?.replace(/(recent-live-|[a-z]+-)[^-]*$/, '$1') ?? '';
    const keys = [origin, 'guide-', 'stream-', 'favourite-', 'recent-live-']
      .filter((prefix, index, all) => prefix && all.indexOf(prefix) === index)
      .map(prefix => `${prefix}${itemId}`);

    setTimeout(() => {
      // Not from under a dialog: the player's failure opened one as it
      // closed, and OK on Close went to the dead channel behind it (the walk,
      // 23 November). The dialog hands focus back when it goes.
      if (document.querySelector('[data-dialog-shell]')) {
        return;
      }
      const element = keys
        .map(key => document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`))
        .find(found => !!found);
      if (element) {
        element.focus({ preventScroll: true });
        element.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  /** Plays whatever a "continue watching" card stands for. */
  resumeEntry(entry: WatchProgress): void {
    if (entry.type === 'series') {
      // The show's page, opened on what is next in it; nothing starts by itself.
      this.router.navigate(['/series', showOf(entry)], { queryParams: { name: entry.name } });
      return;
    }

    if (entry.type === 'live') {
      this.channelListTitle = t('section.recentlyWatched');
      this.channelList = this.recent()
        .filter(recent => recent.type === 'live')
        .map(recent => ({ type: 'live' as StreamType, itemId: recent.itemId, name: recent.name, icon: recent.icon }));
    }

    this.play(
      {
        type: entry.type,
        itemId: entry.itemId,
        name: entry.name,
        icon: entry.icon,
        // Recorded when it was first played, which is the only place a resume
        // can learn it -- the history entry is all this card has.
        containerExtension: entry.containerExtension
      },
      resumePosition(entry)
    );
  }

  /** The focus key of the card a run of playback began from, for putting focus back on its kind. */
  private playStartedFrom: string | null = null;

  /** Set while `play` goes on past a category-lock check it just made. */
  private lockChecked = false;

  private play(item: PlayingItem, startAt: number): void {
    // The preview's connection let go first -- the provider allows one --
    // unless it is this channel, which the full player takes over.
    if (this.preview.state() !== 'idle' && !(item.type === 'live' && this.preview.showing(item.itemId))) {
      void this.preview.stop().then(() => this.play(item, startAt));
      return;
    }
    // Something in a locked category asks for the PIN, however it got here:
    // the lists leave it out, but a link, a reminder or a page kept open when
    // the lock went on all arrive with its id (shared/categoryLock.ts).
    if (!this.lockChecked && this.lock.lockedOutOf(item.type).length) {
      void this.xtreamService.isLockedOut(item.type, item.itemId).then(async out => {
        if (out && !(await this.lock.unlock(item.name))) {
          this.returnIfAsked();
          return;
        }
        this.lockChecked = true;
        try {
          this.play(item, startAt);
        } finally {
          this.lockChecked = false;
        }
      });
      return;
    }
    // A film rated over the age lock asks for the PIN first (TV-31); turned
    // away, a page that sent it here gets it back.
    if (item.type === 'vod' && this.ages.engaged()) {
      void this.ages.mayPlayFilm(item.itemId, item.name, posterTitle(item.name).title || item.name).then(open => {
        if (open) {
          this.startPlaying(item, startAt);
        } else {
          this.returnIfAsked();
        }
      });
      return;
    }
    this.startPlaying(item, startAt);
  }

  private startPlaying(item: PlayingItem, startAt: number): void {
    // Only when started from a card; a channel change starts with nothing focused.
    const from = document.activeElement?.getAttribute('data-focus-key');
    if (from) {
      this.playStartedFrom = from;
    }

    this.xtreamService
      .getPlaybackUrl(item.type, item.itemId, item.containerExtension || undefined)
      .subscribe({
      next: url => {
        this.playing.set(item);
        this.resumeAt.set(startAt);
        this.currentStreamUrl.set(url);
        this.currentStreamName.set(item.name);

        void this.playNativelyOrInPage(item, url, startAt);
      },
      error: err => {
        console.error('Failed to start playback', err);
        this.starting.set(null);
        this.returnAfterPlayback = false;
      }
    });
  }

  /**
   * A film's description for the screen a long pause brings up (PX-TV-8):
   * the one its page has already read, as a rule, so it is at hand. Never
   * worth holding the film up for -- without it the screen says the rest.
   */
  private async filmDescription(item: PlayingItem): Promise<string | undefined> {
    const lookup = this.descriptions
      .film(item.itemId, item.name)
      .then(found => found?.text || undefined)
      .catch(() => undefined);
    return Promise.race([lookup, new Promise<undefined>(done => setTimeout(done, FILM_DESCRIPTION_WAIT_MS))]);
  }

  /**
   * Hands playback to the platform when there is a platform to hand it to.
   *
   * On a device this is not a nicety: a great many live channels are raw
   * MPEG-TS, which the WebView player cannot play at all. When the native
   * player takes it, the modal never opens -- the Activity is the whole screen
   * -- and the position it reports on the way back is recorded exactly as the
   * in-page player's would have been.
   */
  private async playNativelyOrInPage(
    item: PlayingItem,
    url: string,
    startAt: number
  ): Promise<void> {
    const description = item.type === 'vod' ? await this.filmDescription(item) : undefined;
    const openingLine = this.copyOpeningLine ?? undefined;
    this.copyOpeningLine = null;
    const result = await this.nativePlayer.play({
      url,
      title: item.name,
      startAtSeconds: startAt,
      openingLine,
      // Named so the tracks it plays with can be remembered against it, and
      // used again the next time this one is opened.
      item: { type: item.type, id: item.itemId },
      presentation:
        item.type === 'vod'
          ? { ...filmPresentation(item.name, item.icon), description }
          : item.type === 'series'
            ? { kind: 'episode', title: item.name, poster: item.icon ?? null }
            : undefined,
      checkpoint: this.checkpointFor(item),
      channelKeys: item.type === 'live' && this.channelList.length > 1,
      channels: item.type === 'live' ? this.channelRun(item) : undefined
    });

    this.channelChanging.set(null);
    this.starting.set(null);

    if (result && item.type === 'vod' && (await this.triedAnotherCopy(item, result, startAt))) {
      return;
    }

    // Going back to the page that asked: covered until then, rather than this
    // page showing for the moment between the player closing and the return.
    this.leaving.set(this.returnAfterPlayback && !!result);

    if (!result) {
      this.showPlayer.set(true);
      return;
    }

    if (item.type === 'live' && this.refusedAfterChange(result)) {
      this.leaving.set(false);
      this.retriedChannel = true;
      this.playing.set(null);
      this.channelChanging.set(this.display({ stream_id: item.itemId, name: item.name } as Stream).title);
      setTimeout(() => this.play(item, 0), CHANNEL_RETRY_PAUSE_MS);
      return;
    }

    // After switching inside the player, the channel on screen at the end.
    item = this.channelById(result.itemId) ?? item;
    this.playing.set(item);

    if (result.errorCode) {
      // Otherwise the player simply vanishes and nothing anywhere says why,
      // which is exactly how a whole section failing went unnoticed.
      void this.sayWhyItStopped(item, result.errorCode);
    }

    if (result.played) {
      this.onPlaybackProgress({
        positionSeconds: result.positionSeconds,
        durationSeconds: result.durationSeconds
      });
    }

    this.playing.set(null);

    const step = result.channelStep;
    if (item.type === 'live' && isChannelStep(step) && this.changeChannel(item, step)) {
      this.leaving.set(false);
      return;
    }

    if (this.returnIfAsked()) {
      return;
    }

    // Back from the Activity: the rails behind it are now out of date about
    // the very thing that was just watched.
    this.refreshRails(this.type());
    if (item.type === 'live') {
      this.focusChannel(item.itemId);
    }
  }

  /**
   * A toast saying why playback stopped, in words about the viewer's device,
   * and for a film this device cannot decode, the offer of another version.
   *
   * It was a line of red at the top of the page carrying the player's own
   * code -- "no decoder on this device managed dolby-vision 3840x1600
   * (ERROR_CODE_DECODING_FAILED)" -- or, for a 4K film, a black screen and
   * then nothing (24 September).
   */
  private async sayWhyItStopped(item: PlayingItem, errorCode: string): Promise<void> {
    const what = t(item.type === 'live' ? 'section.thisChannel' : item.type === 'vod' ? 'section.thisFilm' : 'show.thisEpisode');
    const said = describePlaybackFailure(errorCode, what);

    const other =
      item.type === 'vod' && isDecodingFailure(errorCode) ? await this.anotherVersionOf(item) : null;
    if (!other) {
      this.toasts.error(
        said.title,
        item.type === 'vod' && tooBigToDecodeInSoftware(errorCode)
          ? `${said.message.replace(t('playback.lowerQualityWillPlay'), '').trim()} ${t('section.noOtherVersion')}`
          : said.message,
        { detail: said.detail }
      );
      return;
    }

    this.toasts.error(said.title, t('section.otherVersion', { name: other.name }), {
      action: {
        label: t('section.playThatVersion'),
        // Gone back to the film's page by now, if that is where Play was
        // pressed: asked for again the way that page asks, so it comes back
        // there too.
        run: () =>
          this.returnedToCaller
            ? void this.router.navigate(['/movies'], {
                queryParams: { play: String(other.stream_id), kind: 'stream', name: other.name, icon: other.stream_icon ?? '', from: 'start', return: 1 }
              })
            : this.play(this.asPlayingItem(other, 'vod'), 0)
      },
      detail: said.detail
    });
  }

  /**
   * The same film in a version this device can decode, if the library has one.
   *
   * Searched for in this device's index of the library -- the one search
   * already uses -- by the title alone, then matched by title and year.
   */
  private async anotherVersionOf(item: PlayingItem): Promise<Stream | null> {
    return otherVersions({ stream_id: item.itemId, name: item.name }, await this.versionsOf(item)).find(
      version => !this.copies.tried(version)
    ) ?? null;
  }

  /** Every copy of a film the library might hold, found by its title in this device's index. */
  private async versionsOf(item: PlayingItem): Promise<Stream[]> {
    const words = searchWordsFor(item.name);
    if (words.length < 2) {
      return [];
    }
    try {
      return await firstValueFrom(this.xtreamService.searchStreams(words, 'vod', 100));
    } catch {
      return [];
    }
  }

  /** What the next player's opening panel says about why it opened. */
  private copyOpeningLine: string | null = null;

  /**
   * After a film failed to start, opens the next copy of it by itself, and
   * says so on the player's opening panel (on the desktop, which has no such
   * panel, in a notice). True when it did, and the failure is not to be
   * reported: the next copy reports its own.
   *
   * Only a copy that failed within its first minute: a later stall is not a
   * dead copy, and another copy may be a different cut where the position
   * would be wrong. Not when the provider refused the account or could not be
   * reached, which every copy would meet alike (other-versions.utils.ts).
   */
  private async triedAnotherCopy(item: PlayingItem, result: NativePlayResult, startAt: number): Promise<boolean> {
    if (!result.errorCode) {
      this.copies.played({ stream_id: item.itemId, name: item.name });
      return false;
    }
    const failed = { stream_id: item.itemId, name: item.name };
    const next = this.copies.next(failed, await this.versionsOf(item), result, startAt);
    if (!next) {
      return false;
    }
    console.info(`A copy did not play (${withoutAddresses(result.errorCode)}); trying another`);

    const said = t('player.tryingCopy', { name: next.name });
    if (this.platform.platform === 'electron') {
      this.toasts.info(t('player.copyFailed'), said);
    }
    this.copyOpeningLine = said;
    this.starting.set(posterTitle(next.name).title || next.name);
    // A moment between one request to the provider and the next.
    await new Promise(resolve => setTimeout(resolve, COPY_SWITCH_PAUSE_MS));
    this.play(this.asPlayingItem(next, 'vod'), Math.max(startAt, result.positionSeconds || 0));
    return true;
  }

  /**
   * What switching inside the player needs from here: the list, names as the panel shows them, addresses, and history.
   */
  private channelRun(item: PlayingItem): ChannelRun {
    const entry = (channel: PlayingItem): ChannelEntry => {
      const shown = this.display({ stream_id: channel.itemId, name: channel.name } as Stream);
      return { itemId: channel.itemId, name: shown.title, number: channel.number ?? '', monogram: shown.monogram };
    };
    // One read of the device's guide for the whole list, on first use: matching
    // walks every guide channel, which is too much to repeat on each press.
    let guide: Promise<GuideByStream> | null = null;
    const guideFor = () =>
      (guide ??= firstValueFrom(
        this.xtreamService
          .guideForStreams(
            [item, ...this.channelList].map(channel => channel.source ?? ({ stream_id: channel.itemId, name: channel.name } as Stream))
          )
          .pipe(catchError(() => of({} as GuideByStream)))
      ).then(found => found ?? {}));

    return {
      current: entry(item),
      list: this.channelList.map(entry),
      directory: async () => {
        const found = await guideFor().catch(() => ({}) as GuideByStream);
        const now = Date.now();
        return {
          title: this.channelListTitle,
          channels: this.channelList.map(channel => {
            const banner = channelBanner(channel.name, found[channel.itemId], now);
            return { ...entry(channel), tags: banner.tags, hasGuide: banner.hasGuide, now: banner.now, next: banner.next };
          })
        };
      },
      bannerFor: async itemId => {
        const channel = this.channelById(itemId);
        const found = await guideFor().catch(() => ({}) as GuideByStream);
        return channelBanner(channel?.name ?? '', found[itemId], Date.now());
      },
      previous: this.previousChannel ? entry(this.previousChannel) : null,
      addressOf: itemId => firstValueFrom(this.xtreamService.getPlaybackUrl('live', itemId)),
      left: left => {
        const channel = this.channelById(left.itemId);
        if (channel) {
          // Each channel watched is in the history, as a separate playback
          // would have put it. Live has no position worth keeping.
          this.previousChannel = channel;
          this.recordWatched(channel);
        }
      },
      arrived: arrived => {
        const channel = this.channelById(arrived.itemId);
        if (channel) {
          this.playing.set(channel);
        }
      }
    };
  }

  /** A channel this page can name, by id: in the list, the one before, or the one playing. */
  private channelById(itemId: string | null | undefined): PlayingItem | null {
    if (!itemId) {
      return null;
    }
    const id = String(itemId);
    return (
      this.channelList.find(channel => channel.itemId === id) ??
      [this.previousChannel, this.playing()].find(channel => channel?.itemId === id) ??
      null
    );
  }

  private recordWatched(item: PlayingItem): void {
    this.xtreamService
      .saveProgress({
        type: item.type,
        itemId: item.itemId,
        name: item.name,
        icon: item.icon ?? null,
        containerExtension: item.containerExtension ?? null,
        positionSeconds: 0,
        durationSeconds: 0
      })
      .subscribe();
  }

  /** Stores where the player has got to, so it can be picked up again. */
  onPlaybackProgress(progress: PlaybackProgress): void {
    const item = this.playing();
    if (item) {
      this.saveProgressOf(item, progress);
    }
  }

  private saveProgressOf(item: PlayingItem, progress: PlaybackProgress): void {
    // A live stream reports a duration -- the length of the sliding window it
    // keeps buffered, typically a minute. Stored as a runtime it would give a
    // channel a progress bar and have it read "almost done" a minute in. The
    // player cannot tell the difference; this is the layer that asked for the
    // channel and knows there is no end to measure against.
    const duration = item.type === 'live' ? 0 : progress.durationSeconds;

    this.xtreamService
      .saveProgress({ ...this.progressEntry(item), positionSeconds: progress.positionSeconds, durationSeconds: duration })
      .subscribe();
  }

  /** What the history keeps about an item, apart from how far it got. */
  private progressEntry(item: PlayingItem): ProgressEntry {
    return {
      type: item.type,
      itemId: item.itemId,
      name: item.name,
      icon: item.icon ?? null,
      // Carried into the history so that resuming from a card can ask for the
      // film by the name it is actually stored under. Without it the resume
      // guesses .mp4 and a film in any other container will not open.
      containerExtension: item.containerExtension ?? null
    };
  }

  /** Saving a film's progress while it plays, not only at the end (PlaybackCheckpoint). Nothing for live. */
  private checkpointFor(item: PlayingItem): PlaybackCheckpoint | undefined {
    if (item.type === 'live') {
      return undefined;
    }
    return {
      entries: () => ({ [item.itemId]: this.progressEntry(item) }),
      reached: (itemId, positionSeconds, durationSeconds) => {
        if (itemId === item.itemId) {
          this.saveProgressOf(item, { positionSeconds, durationSeconds });
        }
      }
    };
  }

  closePlayer(): void {
    if (this.returnIfAsked()) {
      this.showPlayer.set(false);
      return;
    }
    this.showPlayer.set(false);
    this.currentStreamUrl.set('');
    this.currentStreamName.set('');
    this.resumeAt.set(0);
    this.playing.set(null);

    // The player reports its final position as it is torn down, so the reload
    // is queued behind that write rather than racing it.
    setTimeout(() => {
      this.refreshRails(this.type());
      const streams = this.store.streams();
      if (this.type() !== 'live' && streams.length) {
        this.loadProgressFor(this.type(), streams);
      }
    }, 250);
  }

  // --- The actions panel --------------------------------------------------

  /** Holding a card, or right-clicking it. */
  openMenu(target: MenuTarget): void {
    this.menuOpenedFrom = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.menuTarget.set(target);
  }

  /**
   * Shuts the panel and puts focus back on what it was opened from.
   *
   * A sheet's focus scope used to leave focus on nothing when it closed, and
   * the next arrow found somewhere near the middle of the screen. With the
   * panel docked beside the guide that is worse: the guide window changes
   * width as the panel goes, and "near where it was" is a different programme.
   */
  closeMenu(): void {
    const back = this.menuOpenedFrom;
    this.menuOpenedFrom = null;
    this.menuTarget.set(null);
    if (back) {
      // The card itself, or the one that replaced it. Docking the panel
      // regroups the grid into fewer columns and undocking regroups it back,
      // which rebuilds the rows -- so the element the panel was opened from is
      // usually gone by now, and focus used to land on nothing, leaving a
      // remote with nowhere to move from. The channel's focus key finds its
      // new card.
      const key = back.closest('[data-focus-key]')?.getAttribute('data-focus-key');
      const restore = (triesLeft: number) => {
        if (document.activeElement?.closest('[data-focus-scope]')) {
          return;
        }
        const target = back.isConnected
          ? back
          : key
            ? document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)
            : null;
        if (target) {
          target.focus({ preventScroll: false });
        } else if (triesLeft > 0) {
          setTimeout(() => restore(triesLeft - 1), 100);
        }
      };
      setTimeout(() => restore(5));
    }
  }

  private menuOpenedFrom: HTMLElement | null = null;

  /** Left out of the docked panel: back to what it was opened from, panel still open. */
  returnFromMenu(): void {
    if (this.menuOpenedFrom?.isConnected) {
      this.menuOpenedFrom.focus({ preventScroll: true });
    }
  }

  /**
   * Docked beside the category browser (TV-3, D-3); a sheet everywhere else.
   *
   * The front page has nothing to push aside, and a phone has no room for a
   * third column -- below `md` the browser is a single column already, so a
   * docked panel would have been hidden with the sidebar.
   */
  readonly menuDocked = computed(() => this.browsing() && this.wideEnoughToDock());

  private readonly wideEnoughToDock = signal(wideLayoutNow());

  /** A programme block pressed: the channel's programme guide, as a click on the block always did. */
  openProgramme(stream: Stream): void {
    this.selectedStream.set(stream);
    this.showEPG.set(true);
  }

  /**
   * OK on a programme block: a finished one on a channel with catch-up plays
   * from its start, as in any IPTV app; anything else opens the channel's
   * programme guide, where the programme on air can be started over.
   */
  onProgrammeBlock(stream: Stream, item: GuideItem): void {
    if (this.replayable(stream, item)) {
      void this.catchUp(stream, { start: item.start, stop: item.stop, title: item.prog.title || '' });
      return;
    }
    this.openProgramme(stream);
  }

  /** Whether catch-up can be offered here at all: it plays only in the device's own player. */
  readonly catchUpHere = this.nativePlayer.available;

  /** Whether a channel keeps its past, for the mark beside its name. */
  hasCatchUp(stream: Stream): boolean {
    return this.catchUpHere && archiveDays(stream) > 0;
  }

  /** "Catch-up: 3 days", for that mark. */
  catchUpTitle(stream: Stream): string {
    return t('catchUp.days', { count: archiveDays(stream) });
  }

  /** Whether a block is a finished programme this channel can play again. */
  replayable(stream: Stream, item: GuideItem): boolean {
    if (!this.catchUpHere) {
      return false;
    }
    // Once per block: asked of every block on screen at every check, which
    // was a third of a second in twenty-five presses on the TV emulator. The
    // blocks are made again each minute (getProgramsForStream), so the
    // answer is never older than that.
    let replay = this.replayableBlocks.get(item);
    if (replay === undefined) {
      replay = catchUpKind(stream, item, Date.now()) === 'replay';
      this.replayableBlocks.set(item, replay);
    }
    return replay;
  }

  private readonly replayableBlocks = new WeakMap<GuideItem, boolean>();

  /** From the programme guide panel: a finished programme, or the one on air from its start. */
  catchUpFromGuide(programme: CatchUpProgramme): void {
    const stream = this.selectedStream();
    if (stream) {
      void this.catchUp(stream, programme);
    }
  }

  /**
   * Plays a programme from the channel's past, or the one on air from its
   * start.
   *
   * In the device's player as an episode would be -- the channel above the
   * programme's name, a bar to seek along -- and not as the channel: no channel
   * keys, no saved position, nothing in the history. It is not the channel
   * being watched, and nothing about it would make sense to go back to.
   *
   * A programme started over plays up to where it had got when it was asked
   * for, because that is where the provider's playlist stops. Reaching that
   * end asks for the rest, from there, for as long as the programme has any
   * left that is already over; once it has caught up with the programme as
   * it airs, it goes on with the channel itself.
   */
  async catchUp(stream: Stream, programme: CatchUpProgramme, from = programme.start): Promise<void> {
    const kind = catchUpKind(stream, programme, Date.now());
    if (!kind || !this.xtreamService.isAuthenticated()) {
      return;
    }

    const stretch = catchUpStretch(programme, Date.now(), from);
    let url: string;
    try {
      url = await firstValueFrom(this.xtreamService.catchUpAddress(String(stream.stream_id), stretch.startMs, stretch.minutes));
    } catch {
      this.toasts.error(t('catchUp.failed'), t('catchUp.noAddress'));
      return;
    }

    const channel = this.display(stream).title;
    const result = await this.nativePlayer.play({
      url,
      title: programme.title || channel,
      startAtSeconds: 0,
      presentation: {
        kind: 'episode',
        heading: channel,
        title: programme.title || t('section.noProgramme'),
        meta: `${guideDateLabel(programme.start)} · ${clockTime(programme.start)} – ${clockTime(programme.stop)}`,
        poster: null
      }
    });
    this.channelChanging.set(null);

    if (!result) {
      this.toasts.error(t('catchUp.failed'), t('catchUp.needsDevice'));
      return;
    }
    if (result.errorCode) {
      const said = describePlaybackFailure(result.errorCode, t('catchUp.thisProgramme'));
      this.toasts.error(said.title, said.message, { detail: said.detail });
      return;
    }

    // Played to the end of a programme started over: the rest of it, or the
    // channel itself once there is too little of it recorded to be worth a
    // playlist of its own.
    const reached = stretch.startMs + stretch.minutes * 60_000;
    const toTheEnd = result.durationSeconds > 0 && result.positionSeconds >= result.durationSeconds - 5;
    if (kind !== 'startOver' || !toTheEnd || reached >= programme.stop) {
      return;
    }
    this.channelChanging.set(this.display(stream).title);
    await new Promise(resolve => setTimeout(resolve, CHANNEL_CHANGE_PAUSE_MS));
    if (Date.now() - LIVE_EDGE_MS - reached >= CATCH_UP_CONTINUE_MIN_MS) {
      void this.catchUp(stream, programme, reached);
    } else {
      this.channelChanging.set(null);
      this.onStreamClick(stream);
    }
  }

  readonly menuMonogram = computed(() => {
    const target = this.menuTarget();
    return target?.kind === 'stream' ? this.display(target.stream).monogram : '';
  });

  readonly menuNowPlaying = computed(() => {
    this.clockMinute();
    const target = this.menuTarget();
    return target?.kind === 'stream' && this.type() === 'live' ? this.nowPlayingOn(target.stream) : null;
  });

  /** What can be done to a channel, a film or a show. */
  private actionsForStream(stream: Stream): ItemAction[] {
    const progress = this.progressFor(stream);
    const resumeAt = progress ? resumePosition(progress) : 0;
    const starred = this.isFavorite(stream);

    const live = this.type() === 'live';
    const actions: ItemAction[] = [
      {
        id: 'play',
        icon: 'lucidePlay',
        label: resumeAt > 0 ? t('actions.resume') : live ? t('actions.playLive') : t('actions.play'),
        // The one thing a card cannot say for itself, and the reason somebody
        // hesitates before pressing OK on something half-watched.
        hint: resumeAt > 0 ? t('actions.from', { time: formatTimecode(resumeAt) }) : undefined
      },
      {
        id: 'favourite',
        icon: 'lucideStar',
        label: starred ? t('actions.unstar') : t('actions.addFavourite')
      }
    ];

    // Films only: an episode's subtitles are added from the show's page, where
    // the season and episode are known.
    if (this.type() === 'vod') {
      actions.splice(1, 0, { id: 'page', icon: 'lucideListVideo', label: t('actions.filmPage') });
      actions.push({
        id: 'subtitles',
        icon: 'lucideCaptions',
        label: t('actions.addSubtitles'),
        hint: t('actions.fromOpenSubtitles')
      });
    }

    // The rest of the focused programme's description, which the header
    // above the guide cuts at two lines. Its Read more is out of a remote's
    // way -- Up from a channel goes up the list (21 October) --
    // so it is here, where holding OK or Menu already leads.
    const described = this.previewInfo();
    if (live && this.previewShown() && this.previewDescriptionCut() && described?.channel === this.display(stream).title) {
      actions.splice(1, 0, { id: 'describe', icon: 'lucideInfo', label: t('preview.readMore') });
    }

    if (live && this.recordings.available()) {
      // What is on now, to its end in the guide; a recording already running on this channel can be stopped.
      const recording = this.recordingOf(stream);
      const onAir = this.getProgramsForStream(stream).find(item => item.onAir);
      actions.push(
        recording
          ? { id: 'stopRecording', icon: 'lucideCircleStop', label: t('recordings.stop'), hint: recording.title }
          : {
              id: 'record',
              icon: 'lucideCircleDot',
              label: t('recordings.record'),
              hint: onAir && Number.isFinite(onAir.stop) ? t('recordings.recordHint', { title: onAir.prog.title || '', time: clockTime(onAir.stop) }) : t('recordings.recordHour')
            }
      );
    }

    if (live) {
      actions.push({ id: 'guide', icon: 'lucideTv', label: t('section.programmeGuide') });
      actions.push({
        id: 'mapGuide',
        icon: 'lucideListVideo',
        label: t('cgp.title'),
        hint: this.guideMappingFor(stream) ? t('actions.chosenByHand') : t('actions.guideMisses')
      });
    }

    if (progress) {
      actions.push({
        id: 'forget',
        icon: 'lucideTrash2',
        label: t('actions.forget'),
        danger: true
      });
    }

    return actions;
  }

  /** What can be done to a place somebody got to. */
  private actionsForRecent(entry: WatchProgress): ItemAction[] {
    if (entry.type === 'series') {
      return [
        { id: 'play', icon: 'lucidePlay', label: t('actions.openShow') },
        { id: 'forget', icon: 'lucideTrash2', label: t('actions.forget'), danger: true }
      ];
    }
    const resumeAt = resumePosition(entry);

    const actions: ItemAction[] = [
      {
        id: 'play',
        icon: 'lucidePlay',
        label: resumeAt > 0 ? t('actions.resume') : t('actions.play'),
        hint: resumeAt > 0 ? t('actions.from', { time: formatTimecode(resumeAt) }) : undefined
      }
    ];

    // Continue watching is where somebody notices a film has no subtitles --
    // they started it. A live channel has nothing to add them to.
    if (entry.type === 'vod') {
      actions.push({ id: 'page', icon: 'lucideListVideo', label: t('actions.filmPage') });
      actions.push({
        id: 'subtitles',
        icon: 'lucideCaptions',
        label: t('actions.addSubtitles'),
        hint: t('actions.fromOpenSubtitles')
      });
    }

    actions.push({
      id: 'forget',
      icon: 'lucideTrash2',
      label: t('actions.forget'),
      danger: true
    });

    return actions;
  }

  /**
   * What the picker is opened for, from a place somebody got to.
   *
   * An episode carries its show and numbers, which is what an episode is
   * searched by; a film is its own stream.
   */
  private subtitleTargetFor(entry: WatchProgress): { item: SubtitleItem; name: string; poster: string | null } {
    return {
      item: {
        type: entry.type === 'series' ? 'series' : 'vod',
        itemId: String(entry.itemId),
        seriesId: entry.seriesId ?? null,
        season: entry.season ?? null,
        episodeNum: entry.episodeNum ?? null,
        name: entry.name
      },
      name: entry.name,
      poster: entry.icon ?? null
    };
  }

  /**
   * Does the chosen thing, and shuts the panel first.
   *
   * First, because two of these open a panel of their own -- and the guide
   * opening behind this one would leave a remote with two focus scopes on the
   * screen and the newer of them underneath.
   */
  onMenuAction(id: string): void {
    const target = this.menuTarget();
    if (!target) {
      return;
    }

    this.closeMenu();

    if (target.kind === 'recent') {
      if (id === 'play') {
        this.resumeEntry(target.entry);
      } else if (id === 'page') {
        void this.markWhereWeAre();
        void this.router.navigate(['/film', `s${target.entry.itemId}`]);
      } else if (id === 'subtitles') {
        this.subtitleTarget.set(this.subtitleTargetFor(target.entry));
      } else if (id === 'forget') {
        this.forgetProgress(target.entry);
      }
      return;
    }

    const stream = target.stream;

    switch (id) {
      case 'play':
        this.onStreamClick(stream);
        return;
      case 'favourite':
        this.setFavourite(stream, !this.isFavorite(stream));
        return;
      case 'page':
        this.openCard(stream);
        return;
      case 'guide':
        this.selectedStream.set(stream);
        this.showEPG.set(true);
        return;
      case 'record':
        void this.recordNow(stream);
        return;
      case 'stopRecording': {
        const recording = this.recordingOf(stream);
        if (recording) {
          void this.recordings.stop(recording.id);
        }
        return;
      }
      case 'subtitles':
        this.subtitleTarget.set({
          item: { type: 'vod', itemId: String(stream.stream_id), name: stream.name },
          name: stream.name,
          poster: stream.stream_icon ?? null
        });
        return;
      case 'mapGuide':
        this.mappingStream.set(stream);
        return;
      case 'describe':
        this.readPreview();
        return;
      case 'forget': {
        const progress = this.progressFor(stream);
        if (progress) {
          this.forgetProgress(progress);
        }
        return;
      }
    }
  }

  /** The name and picture the panel is headed with. */
  readonly menuName = computed(() => {
    const target = this.menuTarget();
    if (!target) {
      return '';
    }
    // A live channel's tags are in the subtitle beneath (TV-3), so its name is
    // the display title; anything else keeps the name it came with.
    return target.kind === 'stream'
      ? this.type() === 'live'
        ? this.display(target.stream).title
        : target.stream.name
      : target.entry.name;
  });

  readonly menuIcon = computed(() => {
    const target = this.menuTarget();
    if (!target) {
      return null;
    }
    return target.kind === 'stream'
      ? (target.stream.stream_icon ?? null)
      : (target.entry.icon ?? null);
  });

  readonly menuSubtitle = computed(() => {
    const target = this.menuTarget();
    if (!target) {
      return '';
    }

    if (target.kind === 'recent') {
      const entry = target.entry;
      if (entry.type === 'series') {
        return t('fy.watched', { when: watchedWhen(entry.updatedAt, new Date()) });
      }
      return entry.durationSeconds > 0
        ? `${formatTimecode(entry.positionSeconds)} / ${formatTimecode(entry.durationSeconds)}`
        : '';
    }

    if (this.type() !== 'live') {
      return '';
    }

    // "Channel 101 · ⱽᴵᴾ ᴿᴬᵂ · Sport", as TV-3 heads the panel.
    const meta = this.channelMeta(target.stream);
    return [meta ? t('section.channelMeta', { meta }) : t('section.liveChannel'), this.browsing() ? this.browseTitle() : '']
      .filter(Boolean)
      .join(' · ');
  });

  /** Drops an entry from the watch history. */
  forgetEntry(entry: WatchProgress, event: Event): void {
    event.stopPropagation();
    this.forgetProgress(entry);
  }

  private forgetProgress(entry: WatchProgress): void {
    if (entry.type === 'series') {
      // Taken out until watched again; its history, and so its ticks, stay.
      const hidden = { ...this.hiddenShows(), [showOf(entry)]: new Date().toISOString() };
      this.settings.set(SETTING_KEYS.continueHidden, JSON.stringify(hidden));
      return;
    }
    const id = entry.itemId;

    this.recent.update(entries => entries.filter(e => e !== entry));
    this.xtreamService.removeProgress(entry.type, id).subscribe(() => {
      this.xtreamService.getRecentlyWatched(this.type()).subscribe(e => this.recent.set(e));
    });
  }

  // --- Progress display ---------------------------------------------------

  progressFor(stream: Stream): WatchProgress | null {
    return this.progressByItem()[String(stream.stream_id)] ?? null;
  }

  percentWatched(progress: WatchProgress | null): number {
    return watchedPercent(progress);
  }

  remaining(progress: WatchProgress | null): string {
    return remainingLabel(progress);
  }

  watched(progress: WatchProgress | null): boolean {
    return isComplete(progress);
  }

  timecode(seconds: number): string {
    return formatTimecode(seconds);
  }

  episodeTag(entry: WatchProgress): string {
    return episodeLabel(entry.season, entry.episodeNum);
  }

  /** The episode's own title, without the show name the card already carries. */
  episodeSubtitle(entry: WatchProgress): string {
    return shortEpisodeTitle(entry.name, entry.episodeTitle);
  }

  // --- Sorting and arrangement --------------------------------------------

  onCategorySortChange(event: Event): void {
    const sort = (event.target as HTMLSelectElement).value as CategorySort;
    this.categorySort.set(sort);
    this.xtreamService.setCategorySort(sort);
    // Force a reload: the order is decided by the backend.
    this.store['loadCategories'](this.type());
  }

  private readonly panels = inject(ChoicePanelService);

  /** The sorts this list offers, as the panel lists them. */
  private readonly streamSorts = computed(() => {
    const sorts: { value: StreamSort; label: string }[] = [];
    if (this.store.isGlobalSearch()) {
      // Search only: closeness has nothing to be close to otherwise.
      sorts.push({ value: 'closest', label: t('search.best') });
    }
    sorts.push({ value: 'name_asc', label: t('search.az') }, { value: 'name_desc', label: t('search.za') });
    if (this.type() === 'live') {
      sorts.push({ value: 'number', label: t('section.byNumber') });
    }
    sorts.push(
      { value: 'added_desc', label: t('fy.recentlyAdded') },
      { value: 'added_asc', label: t('section.oldest') },
      { value: 'manual', label: t('section.custom') }
    );
    return sorts;
  });

  /** The sort in use, on its pill. */
  readonly streamSortLabel = computed(() => this.streamSorts().find(sort => sort.value === this.shownStreamSort())?.label ?? '');

  /** The sort, through the panel (DS-TV-4, DS-TV-6) rather than a dropdown. */
  async chooseStreamSort(): Promise<void> {
    const chosen = await this.panels.choose(t('search.sort'), this.streamSorts(), this.shownStreamSort());
    if (chosen) {
      this.applyStreamSort(chosen.value);
    }
  }

  private applyStreamSort(sort: StreamSort): void {
    this.streamSort.set(sort);
    this.xtreamService.setStreamSort(sort);
    this.loadStreams();
  }

  readonly hasChannelNumbers = computed(() =>
    this.store.streams().some(s => s.num !== null && s.num !== undefined)
  );

  openReorder(kind: 'category' | 'stream'): void {
    const items =
      kind === 'category'
        ? this.store.categories().map(c => ({ id: String(c.category_id), name: c.category_name }))
        : this.store.streams().map(s => ({ id: String(s.stream_id), name: s.name }));

    this.reorderKind.set(kind);
    this.reorderItems.set(items);
    this.arrangeOpenedFrom = document.activeElement as HTMLElement | null;
    this.showReorder.set(true);
  }

  /** The button Arrange was opened from, to go back to when it closes. */
  private arrangeOpenedFrom: HTMLElement | null = null;

  closeReorder(): void {
    this.showReorder.set(false);

    // Back on the button that opened it. Closing left focus on nothing, since
    // what had it was inside the page that just went (22 September).
    const from = this.arrangeOpenedFrom;
    this.arrangeOpenedFrom = null;
    if (this.tvNavigation.isTelevision()) {
      requestAnimationFrame(() => {
        if (from?.isConnected && !(from as HTMLButtonElement).disabled) {
          from.focus({ preventScroll: true });
        } else {
          this.tvNavigation.focusContentWhenReady();
        }
      });
    }
  }

  /**
   * Persists an arrangement.
   *
   * Categories are arranged in the picker and channels in the dialog, so the
   * kind is taken from whichever is open: the dialog sets it when it opens,
   * and the picker only ever arranges categories.
   */
  onReorderSave(itemIds: string[]): void {
    const kind = this.showReorder() ? this.reorderKind() : 'category';
    const type = this.type();
    const categoryId = kind === 'stream' ? this.selectedCategory() : undefined;

    this.savingOrder.set(true);
    this.xtreamService.saveManualOrder(kind, type, itemIds, categoryId || undefined).subscribe({
      next: () => {
        this.savingOrder.set(false);
        this.closeReorder();

        // Saving an arrangement is only useful if the list then uses it.
        if (kind === 'category') {
          this.categorySort.set('manual');
          this.xtreamService.setCategorySort('manual');
          this.store['loadCategories'](type);
        } else {
          this.streamSort.set('manual');
          this.xtreamService.setStreamSort('manual');
          this.loadStreams();
        }
      },
      error: err => {
        this.savingOrder.set(false);
        console.error('Failed to save order', err);
      }
    });
  }

  // --- Guide --------------------------------------------------------------

  showStreamEPG(stream: Stream, event: Event): void {
    event.stopPropagation();
    this.selectedStream.set(stream);
    this.showEPG.set(true);
  }

  closeEPG(): void {
    this.showEPG.set(false);
    this.selectedStream.set(null);
  }

  /** "Watch now" in the programme guide: shut it and play the channel. */
  watchFromGuide(): void {
    const stream = this.selectedStream();
    this.closeEPG();
    if (stream) {
      this.onStreamClick(stream);
    }
  }

  /**
   * Opens the picker for a channel the guide says nothing about.
   *
   * Offered from the empty row rather than from a settings screen, because
   * that is where a person notices the guide is missing and where they know
   * which channel it should be.
   */
  pickGuideChannel(stream: Stream, event: Event): void {
    event.stopPropagation();
    if (!this.canChangeSetup()) {
      return;
    }
    this.mappingStream.set(stream);
  }

  /** Whether this row's guide was chosen by hand, for the marker on it. */
  guideMappingFor(stream: Stream) {
    return this.guideSources.mappingFor(stream.stream_id);
  }

  closeGuidePicker(): void {
    this.mappingStream.set(null);
  }

  /** Fills in the newly matched row, leaving the list where it was. */
  guideMappingChanged(): void {
    this.store.rereadGuideForVisible();
  }

  toggleListView(): void {
    this.gridWanted.set(this.listView());
  }

  toKey(value: string | number): string {
    return String(value);
  }

  /** A row is identified by its first channel, which is stable as long as the list is. */
  trackByRowKey(index: number, row: { id: string }[]): string {
    return row.length ? row[0].id : String(index);
  }

  private measureGridColumns(width: number): void {
    const gap = untracked(() => this.gridGapPx());
    const fit = Math.floor((width + gap) / (untracked(() => this.minCardWidthPx()) + gap));
    this.gridColumns.set(Math.max(1, fit));
  }

  /** The time header's half-hour marks, in 24-hour time. The last is the window's end, and is not drawn. */
  readonly epgSlots = computed(() => {
    this.clockMinute();
    this.epgWindowHours();
    const slots: string[] = [];
    const stepMs = this.slotMinutes * 60 * 1000;
    for (let t = this.windowStartMs; t < this.windowEndMs; t += stepMs) {
      slots.push(clockTime(t));
    }
    return slots;
  });

  /** "TUE 8 SEP", over the channel column. */
  readonly guideDate = computed(() => guideDateLabel(this.clockMinute()));

  /** "20:37", the label on the now-line. */
  readonly nowLabel = computed(() => clockTime(this.clockMinute()));

  // --- How a channel is written --------------------------------------------

  private readonly displays = new Map<string, ChannelDisplay & { monogram: string }>();

  /**
   * The name, its tags and its monogram, worked out once per channel.
   *
   * A guide row asks for these on every change detection, and the regular
   * expressions behind them are not free across a few hundred rows.
   */
  display(stream: Stream): ChannelDisplay & { monogram: string } {
    const key = `${stream.stream_id}:${stream.name}`;
    let found = this.displays.get(key);
    if (!found) {
      const parts = channelDisplay(stream.name);
      found = { ...parts, monogram: channelMonogram(parts.title) };
      this.displays.set(key, found);
    }
    return found;
  }

  /** "101 · ⱽᴵᴾ ᴿᴬᵂ" -- the number and the tags, whichever exist. */
  channelMeta(stream: Stream): string {
    // `num` is not on the Stream type: Xtream sends it on live channels and
    // mostly nowhere else (see `channelNumber` in shared/xtream/ordering.ts).
    const num = (stream as unknown as Record<string, unknown>)['num'];
    const number = num === null || num === undefined || num === '' ? '' : String(num);
    return [number, this.display(stream).tags].filter(Boolean).join(' · ');
  }

  /**
   * Logos that failed to load, by stream.
   *
   * A broken logo drew nothing, which on a row reads as "this channel has no
   * picture" rather than "the picture did not arrive" -- and a row of logos
   * with gaps in it is harder to scan than one where every gap is filled with
   * the channel's initials. So a failure swaps in the monogram tile.
   */
  readonly brokenLogos = signal<ReadonlySet<string>>(new Set());

  logoFailed(stream: Stream): void {
    const next = new Set(this.brokenLogos());
    next.add(String(stream.stream_id));
    this.brokenLogos.set(next);
  }

  private readonly posterTitles = new Map<string, PosterTitle>();

  /** "3 Body Problem", "2024" -- once per title, for the same reason as `display`. */
  poster(stream: Stream): PosterTitle & { monogram: string } {
    const key = `${stream.stream_id}:${stream.name}`;
    let found = this.posterTitles.get(key) as (PosterTitle & { monogram: string }) | undefined;
    if (!found) {
      const parts = posterTitle(stream.name);
      found = { ...parts, monogram: channelMonogram(parts.title) };
      this.posterTitles.set(key, found);
    }
    return found;
  }

  /** The line under a poster: "2019 · 34 min left", "2004 · Watched", "2016". */
  posterCaption(stream: Stream): string {
    const progress = this.progressFor(stream);
    const state = progress && progress.durationSeconds > 0 ? this.remaining(progress) : '';
    // In a search the category is the missing fact: the same film is filed in
    // several of them, and four identical cards say nothing about which is
    // which without it.
    const where = this.store.isGlobalSearch() ? this.categoryOf(stream) : '';
    return [this.poster(stream).year, state, where].filter(Boolean).join(' · ');
  }

  /** Whether the open category's guide has anything for this channel. */
  hasGuideFor(stream: Stream): boolean {
    return !!this.store.shortEpgByStreamId()[String(stream.stream_id)]?.length;
  }

  hasLogo(stream: Stream): boolean {
    return !!stream.stream_icon && !this.brokenLogos().has(String(stream.stream_id));
  }

  // --- The title row -------------------------------------------------------

  /** What the open list is called: the category, Favourites, or a search. */
  readonly browseTitle = computed(() => {
    if (this.store.isGlobalSearch()) {
      return t('section.searchResults');
    }
    const id = this.selectedCategory();
    if (id === this.FAVORITES_CATEGORY) {
      return t('cat.favourites');
    }
    const name = this.store.categories().find(category => category.category_id === id)?.category_name;
    return name ? withoutTags(name) : this.title();
  });

  /** "37 channels · 19 with guide", as TV-1 heads the list. */
  readonly browseCounts = computed(() => {
    const streams = this.store.streams();
    const total = t(this.type() === 'live' ? 'section.channels' : this.type() === 'vod' ? 'section.films' : 'section.shows', { count: streams.length });

    if (this.type() !== 'live') {
      // "86 films · 12 in progress", as TV-5 heads the grid.
      const progress = this.progressByItem();
      const started = streams.filter(stream => {
        const entry = progress[String(stream.stream_id)];
        return entry && entry.positionSeconds > 0 && !isComplete(entry);
      }).length;
      return started ? `${total} · ${t('section.inProgress', { count: started })}` : total;
    }

    const guide = this.store.shortEpgByStreamId();
    const withGuide = streams.filter(stream => guide[String(stream.stream_id)]?.length).length;
    return `${total} · ${t('section.withGuide', { count: withGuide })}`;
  });

  // --- Guide / Grid / Search -----------------------------------------------

  showGuide(): void {
    this.gridWanted.set(false);
  }

  showGrid(): void {
    this.gridWanted.set(true);
  }

  /**
   * "Search": the one search page, narrowed to this library (SR-TV-3).
   *
   * It opened a search of this library's own, which looked and behaved unlike
   * the search page; there is one search now. Filtering an open category's
   * list stays in the field beside the button: that narrows what is on screen
   * rather than searching.
   */
  openSearch(): void {
    void this.router.navigate(['/search'], { queryParams: { in: this.type() } });
  }

  programStyle(prog: LooseProgramme): { [key: string]: string } {
    const start = this.parseTime(prog.start_timestamp ?? prog.start);
    let stop = this.parseTime(prog.stop_timestamp ?? prog.stop ?? prog.end);
    // Ensure stop is after start; some providers return equal/overlapping boundaries
    if (!Number.isFinite(stop) || stop <= start) {
      stop = start + 5 * 60 * 1000;
    }
    const windowStart = this.windowStartMs;
    const windowEnd = this.windowEndMs;
    // Shrink the visible end slightly to avoid edge-overlap due to source rounding
    const epsilonMs = 15000;
    const visibleStart = Math.max(start, windowStart);
    const visibleEnd = Math.max(visibleStart, Math.min(stop - epsilonMs, windowEnd));
    const totalWindow = windowEnd - windowStart;
    const leftPct = Math.max(0, Math.min(99.5, ((visibleStart - windowStart) / totalWindow) * 100));
    const gapPct = 0.25;
    const widthPct = Math.max(1, ((visibleEnd - visibleStart) / totalWindow) * 100 - gapPct);
    return { left: leftPct + '%', width: widthPct + '%' };
  }

  /**
   * Where the now-line sits, as a percentage of the window.
   *
   * A value that changes once a minute rather than a method every row calls on
   * every check: at thirty rows and several checks a key press it was among
   * the heaviest things a press in the guide did (profiled on the TV emulator,
   * 23 September). A minute moves the line about 0.4% of a four-hour window,
   * which is two pixels.
   */
  readonly nowLineLeft = computed(() => {
    this.minuteTick();
    return this.nowLineStyle()['left'];
  });

  private readonly minuteTick = signal(0);
  private readonly ticksEveryMinute = (() => {
    const timer = setInterval(() => this.minuteTick.update(tick => tick + 1), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    return timer;
  })();

  nowLineStyle(): { [key: string]: string } {
    const now = Date.now();
    const pct = Math.max(
      0,
      Math.min(100, ((now - this.windowStartMs) / (this.windowEndMs - this.windowStartMs)) * 100)
    );
    // The same object while the line has not moved a visible amount, so the
    // style binding on each of thirty rows has nothing to diff.
    const left = pct.toFixed(2) + '%';
    if (this.nowLine['left'] !== left) {
      this.nowLine = { left };
    }
    return this.nowLine;
  }
  private nowLine: { [key: string]: string } = { left: '' };

  private parseTime(value: unknown): number {
    if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
    const n = Number(value);
    if (!Number.isNaN(n)) return n > 1e12 ? n : n * 1000;
    return new Date(String(value)).getTime();
  }

  private toPercent(value: string): number {
    if (!value) return 0;
    const n = parseFloat(String(value).replace('%', ''));
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Where a row's "no guide" band begins, and the time its guide stops: null
   * when something is on now or still to come.
   *
   * Not only for a channel with nothing in the window. With the grid reaching
   * back into the afternoon, a channel whose schedule ended at 22:00 had
   * programmes to draw -- all of them hours ago, out of sight to the left --
   * and showed an empty row from the current hour on, with nothing to say why
   * or to fix it (ARENA SPORT on a user's desktop, 6 October).
   */
  guideGap(stream: Stream): { left: string; width: string; until: string | null } | null {
    const items = this.getProgramsForStream(stream);
    const now = Date.now();
    if (items.some(item => !Number.isFinite(item.stop) || item.stop > now)) {
      return null;
    }
    const last = items[items.length - 1];
    const shown = this.guideShownPx() ?? 0;
    if (!last) {
      return { left: '0%', width: `${shown}px`, until: null };
    }
    const right = this.toPercent(last.style['left']) + this.toPercent(last.style['width']);
    const rightPx = Math.round((right / 100) * (this.guideLanesPx() ?? 0));
    return {
      left: `${right}%`,
      // The words and the button in what shows of the band: all of the lanes
      // on screen once it reaches the names, less while it starts further
      // right -- where it ran its button off the edge.
      width: `calc(${shown}px - max(0px, ${rightPx}px - var(--guide-scroll, 0px)))`,
      until: clockTime(last.stop)
    };
  }

  /**
   * How wide a programme's words may be: no wider than the part of it on
   * screen, so that words stuck beside the channel names fit in what shows of
   * the programme and end in an ellipsis, rather than run under the names.
   * `--guide-scroll` is the lanes' scroll, kept on the scroller as it moves.
   */
  /**
   * How far a programme's words move right to stay in view: as far as the
   * lanes are scrolled past the programme's start, so a programme that began
   * before the part on screen shows its title at the left of what is shown --
   * what `position: sticky` did, without the compositing layer each sticky
   * title had in the WebView: 130 of a guide's 174 layers, committed on every
   * press (the performance audit, 10 October).
   */
  programmeWordsShift(item: GuideItem): string {
    const leftPx = (this.toPercent(item.style['left']) / 100) * (this.guideLanesPx() ?? 0);
    return `max(0px, calc(var(--guide-scroll, 0px) - ${Math.round(leftPx)}px)) 0`;
  }

  programmeWordsWidth(item: GuideItem): string {
    const right = ((this.toPercent(item.style['left']) + this.toPercent(item.style['width'])) / 100) * (this.guideLanesPx() ?? 0);
    return `min(100%, calc(${Math.round(right)}px - var(--guide-scroll, 0px) - 1rem))`;
  }

  /**
   * Each channel's rows, worked out once per guide, window and minute.
   *
   * The template asks for a channel's programmes several times per row on
   * every change detection, and every key press is one. Measured on the TV
   * emulator at 6x CPU throttle, redoing it took about 60% of the work of each
   * D-pad press in the guide -- over 300 ms, which is a visible lag on a
   * remote. Nothing a row shows changes between two presses: the times and
   * "N min left" are to the minute, and the now-line moves about eight pixels
   * a minute on a four-hour window.
   *
   * Keyed by the guide object itself, so a new guide (a category opened, a
   * reload) is recomputed on sight, and by the window's length, which changes
   * when the actions panel docks.
   */
  private readonly programRows = new WeakMap<object, { key: string; rows: Map<string, GuideItem[]> }>();

  getProgramsForStream(stream: Stream, source?: GuideByStream): GuideItem[] {
    const guide = source ?? this.store.shortEpgByStreamId?.() ?? {};
    const id = this.toKey(stream.stream_id);
    const key = `${Math.floor(Date.now() / 60_000)}|${this.epgWindowHours()}`;

    let cached = this.programRows.get(guide);
    if (!cached || cached.key !== key) {
      cached = { key, rows: new Map() };
      this.programRows.set(guide, cached);
    }
    const known = cached.rows.get(id);
    if (known) {
      return known;
    }
    const rows = this.computeProgramsForStream(guide[id] || []);
    cached.rows.set(id, rows);
    return rows;
  }

  private computeProgramsForStream(list: LooseProgramme[]): GuideItem[] {
    const windowStartMs = this.windowStartMs;
    const windowEndMs = this.windowEndMs;

    // Only what the drawn window actually covers.
    //
    // A guide is fetched with a margin either side, so that the programme
    // already running is in hand; but everything that finished before the
    // window opened has nowhere to go, and programStyle clamps each one to the
    // left edge. Several hours of finished programmes then arrive as a stack
    // of one-percent slivers against the start of the row, which is what the
    // bars crowded at the left of the timeline were.
    const visible = list.filter(prog => {
      const start = this.parseTime(prog.start_timestamp ?? prog.start);
      const stop = this.parseTime(prog.stop_timestamp ?? prog.stop ?? prog.end);
      return (
        Number.isFinite(start) &&
        start < windowEndMs &&
        (!Number.isFinite(stop) || stop > windowStartMs)
      );
    });

    const sorted = [...visible].sort(
      (a, b) =>
        this.parseTime(a.start_timestamp ?? a.start) - this.parseTime(b.start_timestamp ?? b.start)
    );

    let prevRight = 0;
    const normalized: GuideItem[] = [];
    for (const prog of sorted) {
      const style = this.programStyle(prog);
      let left = this.toPercent(style['left']);
      let width = this.toPercent(style['width']);
      // Enforce non-overlap: start at least after the previous right edge
      if (left < prevRight) {
        width = Math.max(1, width - (prevRight - left));
        left = prevRight;
      }
      let right = left + width;
      if (right > 100) {
        right = 100;
        width = Math.max(1, right - left);
      }
      prevRight = right;
      // Which one is on now, so the row can say so without being read.
      //
      // The vertical line already marks the time, but it crosses thirty rows
      // at once and says nothing about any of them. Naming the programme it
      // lands in is the thing a guide is opened to find out, and it costs a
      // comparison that is already being made a few lines up.
      const start = this.parseTime(prog.start_timestamp ?? prog.start);
      const stop = this.parseTime(prog.stop_timestamp ?? prog.stop ?? prog.end);
      const now = Date.now();
      const onAir = Number.isFinite(start) && start <= now && (!Number.isFinite(stop) || now <= stop);
      normalized.push({
        prog,
        start,
        stop,
        onAir,
        finished: Number.isFinite(stop) && stop < now,
        style: { left: left + '%', width: width + '%' },
        time: Number.isFinite(stop) ? `${clockTime(start)} – ${clockTime(stop)}` : clockTime(start),
        left: onAir ? minutesLeft(stop, now) : null,
        percent: onAir ? percentThrough(start, stop, now) : 0
      });
    }
    return normalized;
  }

  /** The programme on air on a channel, for the head of its actions panel. */
  nowPlayingOn(stream: Stream, source?: GuideByStream): NowPlaying | null {
    const item = this.getProgramsForStream(stream, source).find(candidate => candidate.onAir);
    return item
      ? { title: item.prog.title || '', time: item.time, left: item.left, percent: item.percent }
      : null;
  }

  // Clicking a channel's name, and a programme block, used to be handled here.
  // Both are `CardGesturesDirective` now, the same as every other way into a
  // channel, so that holding either opens the actions panel as holding a card
  // does. See `openProgramme`.

  refreshGuide(): void {
    this.store['refreshNowEPGForVisible']();
  }
}
