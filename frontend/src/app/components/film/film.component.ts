import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideCaptions, lucideChevronRight, lucideEllipsis, lucideLoaderCircle, lucidePlay, lucideRotateCcw, lucideStar } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { Stream, WatchProgress } from '@shared/types';
import { AgeLockService } from '../../services/age-lock.service';
import { TrailerService } from '../../services/trailer.service';
import { BackButtonService } from '../../services/back-button.service';
import { SubtitlePickerComponent } from '../subtitle-picker/subtitle-picker.component';
import { ItemAction, ItemActionsComponent } from '../item-actions/item-actions.component';
import { SubtitleItem } from '../../services/subtitle-library.service';
import { CollectionPage, FilmCopy, FilmKnown, FilmLink, FilmPage, FilmService, MORE_LIKE_THIS_MIN } from '../../services/film.service';
import { XtreamService } from '../../services/xtream.service';
import { DeviceSyncService } from '../../services/device-sync.service';
import { ToastService } from '../../services/toast.service';
import { TPipe } from '../../pipes/t.pipe';
import { ProviderNamePipe } from '../../pipes/provider-name.pipe';
import { ChannelMonogramPipe } from '../../pipes/format.pipes';
import { formatTimecode, isComplete, remainingLabel } from '../../utils/progress.utils';
import { namePrefix } from '../../utils/series-display.utils';
import { t } from '../../utils/i18n';
import { TMDB_LOGO } from '../description-settings/description-settings.component';
import { DescriptionReaderService } from '../description-reader/description-reader.component';
import { CutOffDirective } from '../../directives/cut-off.directive';

/** What the copy button and a copy row call a copy: its language as a word, and its picture. */
export function copyLabel(copy: FilmCopy): string {
  const language = copy.languageName || namePrefix(copy.stream.name) || t('film.unknownLanguage');
  return [language, copy.quality].filter(Boolean).join(' · ');
}

/** "2 h 12 min", or "48 min". */
export function runtimeLabel(minutes: number): string {
  if (minutes <= 0) {
    return '';
  }
  const hours = Math.floor(minutes / 60);
  return hours ? t('film.hoursMinutes', { h: hours, m: minutes % 60 }) : t('film.minutes', { m: minutes });
}

/** What a list hands over when it opens a film's page (FilmService). */
export type FilmHint = FilmKnown;

/** Opens a film's page from a TMDB list: More like this, a collection, Popular. */
export function filmFromList(router: Router, link: Pick<FilmLink, 'item' | 'poster'>): void {
  const { id, title, originalTitle, year } = link.item;
  void router.navigate(['/film', id], { state: { film: { title, originalTitle, year, poster: link.item.poster } } });
}

/**
 * A film's own page (round 6, TV-27, D-19, P-16; round 13, NX-TV-3, NX-P-2).
 *
 * The backdrop to the edges, fading into the page, so the type always sits on
 * the page's own ground; the title large; one line of year, running time,
 * genres, the age rating and TMDB's score; three lines of overview; then one
 * row of pills in the order they are used: Play (or Resume), Start over,
 * Favourites, Subtitles, and More -- which copy (the copies page, TV-28; a
 * desktop also lists them on the page, D-19), the trailer, and out of
 * Continue watching. The count of copies is said once, under the buttons.
 */
@Component({
  selector: 'app-film',
  standalone: true,
  imports: [TPipe, NgIcon, HlmButton, ProviderNamePipe, ChannelMonogramPipe, SubtitlePickerComponent, ItemActionsComponent, CutOffDirective],
  providers: [provideIcons({ lucideArrowLeft, lucideCaptions, lucideChevronRight, lucideEllipsis, lucideLoaderCircle, lucidePlay, lucideRotateCcw, lucideStar })],
  templateUrl: './film.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FilmComponent {
  private readonly router = inject(Router);
  private readonly films = inject(FilmService);
  private readonly xtream = inject(XtreamService);
  private readonly deviceSync = inject(DeviceSyncService);
  private readonly toasts = inject(ToastService);

  readonly logo = TMDB_LOGO;
  readonly copyLabel = copyLabel;
  /** Copies a desktop shows before "Show all", above ten (D-19). */
  readonly INLINE_SHOWN = 8;

  readonly page = signal<FilmPage | null>(null);
  readonly ages = inject(AgeLockService);

  /** The film's ratings, while the age lock is on, so the page can say it is locked. */
  private readonly learnRating = effect(() => {
    const id = this.page()?.id;
    if (id && this.ages.engaged()) {
      untracked(() => void this.ages.learn('movie', [id]));
    }
  });
  readonly failed = signal(false);
  readonly progress = signal<WatchProgress | null>(null);
  readonly favourites = signal<ReadonlySet<string>>(new Set());
  readonly allCopiesShown = signal(false);
  /** TMDB's recommendations kept to the library; shown only when there are enough (TV-27). */
  readonly moreLikeThis = signal<FilmLink[]>([]);
  readonly MORE_LIKE_THIS_MIN = MORE_LIKE_THIS_MIN;
  /** The collection the film is in, with how much of it the library has. */
  readonly collection = signal<CollectionPage | null>(null);
  readonly collectionLine = computed(() => {
    const collection = this.collection();
    return collection
      ? [t('film.filmCount', { count: collection.parts.length }), t('film.inLibrary', { count: collection.parts.filter(part => part.copies > 0).length })].join(' · ')
      : '';
  });
  private hint: FilmHint = {};
  private ref = '';

  /** The copy Play uses: the one being watched, else the chosen one, else the first. */
  readonly playCopy = computed(() => {
    const page = this.page();
    if (!page) {
      return undefined;
    }
    const watching = this.progress();
    return (watching && page.copies.find(copy => String(copy.stream.stream_id) === String(watching.itemId))) ?? this.films.playCopy(page);
  });

  readonly meta = computed(() => {
    const page = this.page();
    return page ? [page.year, runtimeLabel(page.runtime), page.genres.join(', ')].filter(Boolean).join(' · ') : '';
  });

  /** "20 copies in 9 languages". */
  readonly copiesLine = computed(() => {
    const page = this.page();
    if (!page || page.copies.length < 2) {
      return '';
    }
    const languages = new Set(page.copies.map(copy => copy.language || copy.stream.name)).size;
    return [t('film.copyCount', { count: page.copies.length }), t('film.inLanguages', { count: languages })].join(' ');
  });

  readonly stoppedAt = computed(() => {
    const watching = this.progress();
    return watching ? t('film.stoppedAt', { at: formatTimecode(watching.positionSeconds), left: remainingLabel(watching) }) : '';
  });

  readonly watchedPercent = computed(() => {
    const watching = this.progress();
    return watching && watching.durationSeconds > 0 ? Math.min(100, (watching.positionSeconds / watching.durationSeconds) * 100) : 0;
  });

  readonly favourite = computed(() => {
    const page = this.page();
    const favourites = this.favourites();
    return !!page && page.copies.some(copy => favourites.has(String(copy.stream.stream_id)));
  });

  /** Without a backdrop, the poster stands in, blurred: the page's own, else the copy's. */
  readonly heroPoster = computed(() => {
    const page = this.page();
    const failed = this.failedIcons();
    return [page?.poster, page?.copies[0]?.stream.stream_icon].find(url => !!url && !failed.has(url)) ?? '';
  });

  /** More's panel (NX-TV-3): what did not earn a place in the row. */
  readonly moreOpen = signal(false);
  readonly moreActions = computed<ItemAction[]>(() => {
    const page = this.page();
    const copy = this.playCopy();
    const actions: ItemAction[] = [];
    if (copy) {
      actions.push({ id: 'copy', label: copyLabel(copy), hint: this.copiesLine() || undefined, icon: 'lucideListVideo' });
    }
    if (page?.trailers.length) {
      actions.push({ id: 'trailer', label: t('trailer.button'), hint: 'YouTube', icon: 'lucidePlay' });
    }
    if (this.progress()) {
      actions.push({ id: 'forget', label: t('actions.forget'), icon: 'lucideTrash2', danger: true });
    }
    return actions;
  });

  /** More's panel closed: focus back on More, where it was. */
  private readonly reader = inject(DescriptionReaderService);

  /** The overview, whole: the page cuts it to three lines. */
  readOverview(title: string, text: string): void {
    this.reader.open({ title, text, source: 'provider' });
  }

  closeMore(): void {
    this.moreOpen.set(false);
    setTimeout(() => document.querySelector<HTMLElement>('[data-focus-key="film-more"]')?.focus({ preventScroll: true }));
  }

  onMore(id: string): void {
    this.moreOpen.set(false);
    if (id === 'copy') {
      this.copies();
    } else if (id === 'trailer') {
      this.trailer();
    } else if (id === 'forget') {
      this.forget();
    }
  }

  readonly inlineCopies = computed(() => {
    const copies = this.page()?.copies ?? [];
    return copies.length > 10 && !this.allCopiesShown() ? copies.slice(0, this.INLINE_SHOWN) : copies;
  });

  constructor() {
    // Back closes the subtitles before it leaves the page.
    inject(BackButtonService).bindTo(computed(() => this.subtitleTarget() !== null), () => this.subtitleTarget.set(null));
    inject(BackButtonService).bindTo(this.moreOpen, () => this.closeMore());
    const route = inject(ActivatedRoute);
    inject(DestroyRef).onDestroy(() => this.left.abort());
    route.paramMap.pipe(takeUntilDestroyed()).subscribe(params => {
      this.left.abort();
      this.left = new AbortController();
      this.ref = params.get('id') ?? '';
      this.hint = { ...(history.state as { film?: FilmHint } | null)?.film, name: route.snapshot.queryParamMap.get('name') ?? undefined };
      this.page.set(null);
      this.moreLikeThis.set([]);
      this.collection.set(null);
      void this.load();
    });
  }

  /**
   * Aborted when this film is left: its rows' library reads not yet made are
   * not made. Android runs them one at a time, and five film pages queued
   * minutes of them ahead of every other read on a user's TV (26 November).
   */
  private left = new AbortController();

  async load(): Promise<void> {
    const signal = this.left.signal;
    this.failed.set(false);
    try {
      const page = await this.films.open(this.ref, this.hint);
      this.page.set(page);
      if (page.detailsFailed) {
        this.sayTmdbFailed(new Error('No details from TMDB'));
      }
      await this.loadWatching(page);
      // Below the fold, and slower: each one is looked for in the library.
      if (page.collection) {
        void this.films
          .collection(page.collection.id, signal)
          .then(collection => signal.aborted || this.collection.set(collection))
          .catch(() => undefined);
      }
      void this.films.moreLikeThis(page, signal).then(links => signal.aborted || this.moreLikeThis.set(links)).catch(() => undefined);
      void this.copiesOnceLibraryArrives(this.ref);
    } catch (error) {
      this.failed.set(true);
      this.sayTmdbFailed(error);
    }
  }

  /**
   * On a device that has never held its film library, the page found only the
   * copies in categories already opened. The library is downloaded once, as a
   * search would, and the page looks again: the copies fill in where it stands.
   */
  private async copiesOnceLibraryArrives(ref: string): Promise<void> {
    if (!(await this.xtream.fetchLibraryIfNeverHeld('vod').catch(() => false)) || this.ref !== ref) {
      return;
    }
    this.films.forget(ref);
    const again = await this.films.open(ref, this.hint).catch(() => null);
    if (again && this.ref === ref) {
      this.page.set(again);
    }
  }

  private async loadWatching(page: FilmPage): Promise<void> {
    const ids = new Set(page.copies.map(copy => String(copy.stream.stream_id)));
    const [recent, favourites] = await Promise.all([
      firstValueFrom(this.xtream.getRecentlyWatched('vod').pipe(catchError(() => of([] as WatchProgress[])))),
      firstValueFrom(this.xtream.getFavorites('vod').pipe(catchError(() => of([] as Stream[]))))
    ]);
    const watching = recent.find(entry => ids.has(String(entry.itemId)));
    this.progress.set(watching && watching.positionSeconds > 0 && !isComplete(watching) ? watching : null);
    this.favourites.set(new Set(favourites.map(stream => String(stream.stream_id)).filter(id => ids.has(id))));
  }

  private sayTmdbFailed(error: unknown): void {
    this.toasts.error(t('popular.failed'), t('popular.failedBody'), {
      detail: `GET api.themoviedb.org/3/movie/${this.ref} · ${error instanceof Error ? error.message : String(error)} · ${new Date().toLocaleTimeString()}`,
      action: { label: t('popular.tryAgain'), run: () => void this.load() }
    });
  }

  /** Play, or Resume: the copy Play uses, from where it was left. */
  play(): void {
    this.playIn(this.playCopy(), false);
  }

  startOver(): void {
    this.playIn(this.playCopy(), true);
  }

  /** A copy chosen from the list: played, and this film's choice from now on (TV-28). */
  playChosen(copy: FilmCopy): void {
    this.films.choose(this.page()?.ref ?? this.ref, copy.stream.stream_id);
    this.playIn(copy, false);
  }

  private playIn(copy: FilmCopy | undefined, fromStart: boolean): void {
    if (!copy) {
      return;
    }
    const stream = copy.stream;
    void this.router.navigate(['/movies'], {
      queryParams: {
        play: String(stream.stream_id),
        kind: 'stream',
        name: stream.name,
        icon: stream.stream_icon ?? '',
        return: 1,
        ...(fromStart ? { from: 'start' } : {})
      }
    });
  }

  copies(): void {
    void this.router.navigate(['/film', this.ref, 'copies'], { state: { film: this.hint } });
  }

  openCollection(): void {
    const collection = this.page()?.collection;
    if (collection) {
      void this.router.navigate(['/film/collection', collection.id]);
    }
  }

  openLink(link: FilmLink): void {
    filmFromList(this.router, link);
  }

  private readonly trailers = inject(TrailerService);

  trailer(): void {
    const film = this.page();
    if (film) {
      this.trailers.open(film.title, film.trailers);
    }
  }

  /** The film whose subtitles are being chosen: the copy Play uses. */
  readonly subtitleTarget = signal<{ item: SubtitleItem; name: string } | null>(null);

  addSubtitles(): void {
    const copy = this.playCopy();
    if (copy) {
      const name = copy.stream.name;
      this.subtitleTarget.set({ item: { type: 'vod', itemId: String(copy.stream.stream_id), name }, name });
    }
  }

  /** Out of Continue watching, as the panel does it: its place in the film forgotten. */
  forget(): void {
    const watching = this.progress();
    if (!watching) {
      return;
    }
    this.xtream.removeProgress('vod', watching.itemId).subscribe(() => this.deviceSync.syncNow());
    this.progress.set(null);
  }

  toggleFavourite(): void {
    const page = this.page();
    const copy = this.playCopy();
    if (!page || !copy) {
      return;
    }
    if (this.favourite()) {
      const starred = page.copies.filter(candidate => this.favourites().has(String(candidate.stream.stream_id)));
      for (const candidate of starred) {
        this.xtream.setFavorite(candidate.stream, 'vod', false).subscribe(() => this.deviceSync.syncNow());
      }
      this.favourites.set(new Set());
      return;
    }
    this.xtream.setFavorite(copy.stream, 'vod', true).subscribe(() => this.deviceSync.syncNow());
    this.favourites.set(new Set([String(copy.stream.stream_id)]));
  }

  back(): void {
    if (history.length > 1) {
      history.back();
    } else {
      void this.router.navigate(['/for-you']);
    }
  }

  readonly failedIcons = signal<ReadonlySet<string>>(new Set());

  iconFailed(url: string | null | undefined): void {
    if (url) {
      this.failedIcons.update(failed => new Set(failed).add(url));
    }
  }
}
