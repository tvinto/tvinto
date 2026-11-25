import { AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { TmdbGenre, TmdbKind, listGenre, listRequest } from '@shared/tmdb/client';
import { DiscoverService } from '../../services/discover.service';
import { LIST_PAGES, PopularService } from '../../services/popular.service';
import { XtreamService } from '../../services/xtream.service';
import { ToastService } from '../../services/toast.service';
import { BackButtonService } from '../../services/back-button.service';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { ItemActionsComponent } from '../item-actions/item-actions.component';
import { CardGesturesDirective } from '../../directives/card-gestures.directive';
import { ChannelMonogramPipe } from '../../pipes/format.pipes';
import { TPipe } from '../../pipes/t.pipe';
import { t } from '../../utils/i18n';
import { AgeLockService } from '../../services/age-lock.service';
import { ParentalLockService } from '../../services/parental-lock.service';
import { AgeCoverComponent } from '../age-cover/age-cover.component';
import { TMDB_LOGO } from '../description-settings/description-settings.component';
import { CategoryNames, PopularCard, categoryNames, openFilm, openShow, openVersion, popularCard, stillAllowed, versionActions } from '../for-you/popular-cards';
import { ShowService } from '../../services/show.service';

/** What one round of reading looks for before it stops to show it: about a row. */
const PER_ROUND = 8;

/** How far down TMDB's list one round goes before it stops to show what it found. */
const PAGES_PER_ROUND = 4;

/**
 * Popular films, or popular shows, this week (TV-26, D-18, P-15): the whole
 * of TMDB's trending list as far as this library has it -- For You's row,
 * carried on. One route for both, with a Films · Shows switch that replaces
 * the grid rather than stacking a page.
 *
 * It loads as you go: when focus reaches the second-to-last row, or the
 * foot of the grid scrolls into view, the next pages are read and matched.
 * A TMDB page can match only two or three titles, so the foot of the grid
 * names what it is doing ("140 titles checked, 31 in your library") rather
 * than spinning. It stops after the first 500 on TMDB's list and says so.
 */
@Component({
  selector: 'app-popular',
  standalone: true,
  imports: [TPipe, AgeCoverComponent, NgIcon, HlmButton, CardGesturesDirective, ItemActionsComponent, ChannelMonogramPipe],
  providers: [provideIcons({ lucideArrowLeft })],
  templateUrl: './popular.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PopularComponent implements AfterViewInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly popular = inject(PopularService);
  private readonly xtream = inject(XtreamService);
  private readonly toasts = inject(ToastService);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly tv = inject(TvNavigationService);

  readonly logo = TMDB_LOGO;
  readonly PLACEHOLDERS = Array.from({ length: PER_ROUND }, (_, index) => index);

  readonly kind = signal<TmdbKind>('movie');
  /** Which of TMDB's lists: the week's trending, from For You; the others (`TmdbList`) from Movies and TV Shows. */
  readonly list = signal('trending');
  readonly genre = computed(() => listGenre(this.list()));
  private readonly genreNames = signal<TmdbGenre[]>([]);
  private readonly discover = inject(DiscoverService);

  /** "Popular films this week", "Top rated shows", "New films", "Comedy". */
  readonly title = computed(() => {
    const list = this.list();
    const tv = this.kind() === 'tv';
    if (list === 'trending') {
      return t(tv ? 'popular.titleShows' : 'popular.titleFilms');
    }
    if (list === 'top') {
      return t(tv ? 'discover.topShows' : 'discover.topFilms');
    }
    if (list === 'popular') {
      return t(tv ? 'discover.popularShows' : 'discover.popularFilms');
    }
    if (list === 'new') {
      return t(tv ? 'discover.newShows' : 'discover.newFilms');
    }
    return this.genreNames().find(genre => genre.id === this.genre()?.genre)?.name ?? '';
  });
  readonly cards = signal<PopularCard[]>([]);
  readonly working = signal(false);
  /** Titles read from TMDB's list so far, for the meter and the end. */
  readonly checked = signal(0);
  /** How many pages TMDB's list has; null until the first is read. */
  private readonly pages = signal<number | null>(null);
  private readonly read = signal(0);
  /** TMDB did not answer; nothing more is asked until Try again. */
  private readonly failed = signal(false);
  /** A page was matched against a library not held whole yet: "none" would not be true, so it waits for the library. */
  readonly incomplete = signal(false);
  /** The library this list is matched against, while it downloads, and how far it has got. */
  readonly libraryLoading = computed(() => this.xtream.indexing() === (this.kind() === 'tv' ? 'series' : 'vod'));
  readonly libraryProgress = computed(() => {
    const progress = this.xtream.indexProgress();
    return progress?.total ? progress : null;
  });
  readonly finished = computed(() => {
    const pages = this.pages();
    return pages !== null && this.read() >= Math.min(pages, LIST_PAGES);
  });

  private readonly page = viewChild<ElementRef<HTMLElement>>('page');
  private readonly foot = viewChild<ElementRef<HTMLElement>>('foot');
  private names: CategoryNames | null = null;
  /** Whether focus has been put on the first poster once; after the switch it stays on the switch. */
  private landed = false;
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.gone = true));
    // Back closes the panel before it leaves the page.
    inject(BackButtonService).bindTo(computed(() => this.menu() !== null), () => this.closeMenu());
    inject(ActivatedRoute)
      .paramMap.pipe(takeUntilDestroyed())
      .subscribe(params => {
        this.kind.set(params.get('kind') === 'tv' ? 'tv' : 'movie');
        this.list.set(params.get('list') ?? 'trending');
        if (this.genre()) {
          void this.discover.genres(this.kind()).then(genres => this.genreNames.set(genres));
        }
        this.cards.set([]);
        this.pages.set(null);
        this.read.set(0);
        this.checked.set(0);
        this.failed.set(false);
        this.incomplete.set(false);
        void this.openList(this.kind(), this.list());
      });
    // A library that has just loaded, wherever it was asked for, is what an incomplete list was waiting for.
    let indexing = this.xtream.indexing();
    effect(() => {
      const now = this.xtream.indexing();
      if (indexing !== null && now === null && untracked(this.incomplete)) {
        untracked(() => this.tryAgain());
      }
      indexing = now;
    });
  }

  ngAfterViewInit(): void {
    // The foot of the grid coming into view is the request for more, on a
    // pointer device; on a television focus reaching the last rows is (onFocus).
    const observer = new IntersectionObserver(entries => entries.some(entry => entry.isIntersecting) && void this.loadOn(), {
      rootMargin: '0px 0px 600px 0px'
    });
    const foot = this.foot()?.nativeElement;
    if (foot) {
      observer.observe(foot);
    }
    this.host.nativeElement.addEventListener('focusin', this.onFocus);
    this.observer = observer;
  }

  private observer: IntersectionObserver | null = null;
  /** Whose library the cards are from (XtreamService.libraryOwner). */
  private library = '';

  /**
   * The list as this page last showed it, at once, when Back returns to it
   * (card 39): the page is made afresh, and its first cards waited for the
   * categories from the database, behind the film page's searches.
   */
  private async openList(kind: TmdbKind, list: string): Promise<void> {
    const library = await this.xtream.libraryOwner();
    if (this.gone || kind !== this.kind() || list !== this.list()) {
      return;
    }
    this.library = library;
    const kept = this.popular.lastShown<{ cards: PopularCard[]; pages: number | null; read: number; checked: number }>(`list:${kind}:${list}`, library);
    if (!kept) {
      return this.loadOn();
    }
    this.cards.set(stillAllowed(this.xtream, kept.cards));
    this.pages.set(kept.pages);
    this.read.set(kept.read);
    this.checked.set(kept.checked);
    if (this.cards().length && this.tv.isTelevision()) {
      this.landed = true;
      this.focusFirstIfUnmoved();
    }
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.host.nativeElement.removeEventListener('focusin', this.onFocus);
  }

  /** Focus on the second-to-last row asks for the next. */
  private readonly onFocus = (event: FocusEvent): void => {
    const target = event.target as HTMLElement | null;
    const grid = target?.closest('[data-popular-grid]');
    if (!target || !grid) {
      return;
    }
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const index = [...grid.children].indexOf(target);
    if (index >= this.cards().length - 2 * columns) {
      void this.loadOn();
    }
  };

  /**
   * Reads on down the list: a round at a time, each until about a row more
   * is found or a few pages are read, and another round while the foot of
   * the grid is still in sight.
   */
  async loadOn(): Promise<void> {
    if (this.working() || this.finished() || this.failed() || this.incomplete()) {
      return;
    }
    this.working.set(true);
    const kind = this.kind();
    const list = this.list();
    const before = this.cards().length;
    try {
      this.names ??= await categoryNames(this.xtream);
      for (let round = 0; round < PAGES_PER_ROUND && this.cards().length - before < PER_ROUND && !this.finished(); round++) {
        const next = await this.popular.page(kind, this.read() + 1, list);
        if (this.gone || kind !== this.kind() || list !== this.list()) {
          return;
        }
        const had = new Set(this.cards().map(card => card.item.id));
        const fresh = next.found.filter(entry => !had.has(entry.item.id)).map(entry => popularCard(entry, this.names!));
        this.cards.update(cards => [...cards, ...fresh]);
        // On a television only: a ring on a touch screen marks nothing anyone pressed.
        if (before === 0 && fresh.length && !this.landed && this.tv.isTelevision()) {
          this.landed = true;
          this.focusFirstIfUnmoved();
        }
        if (next.incomplete) {
          // Read again, from this page, once the library is there.
          this.incomplete.set(true);
          break;
        }
        this.pages.set(next.pages);
        this.checked.update(checked => checked + next.checked);
        this.read.update(read => read + 1);
      }
    } catch (error) {
      this.failed.set(true);
      this.toasts.error(t('popular.failed'), t('popular.failedBody'), {
        detail: `GET api.themoviedb.org/3${listRequest(kind, list).path} · ${error instanceof Error ? error.message : String(error)} · ${new Date().toLocaleTimeString()}`,
        action: { label: t('popular.tryAgain'), run: () => this.tryAgain() }
      });
    } finally {
      this.working.set(false);
    }
    if (!this.failed() && !this.incomplete() && kind === this.kind() && list === this.list()) {
      this.popular.keepShown(`list:${kind}:${list}`, this.library, { cards: this.cards(), pages: this.pages(), read: this.read(), checked: this.checked() });
    }
    if (!this.gone && this.footInSight()) {
      setTimeout(() => void this.loadOn());
    }
  }

  /**
   * The page opens before its first posters: focus lands on the switch, the
   * only thing there. When they arrive it moves to the first, unless the
   * remote has gone somewhere since. Only on opening: a press of the switch
   * leaves focus on the switch.
   */
  private focusFirstIfUnmoved(tries = 20): void {
    setTimeout(() => {
      const active = document.activeElement;
      // Still on the card that opened the page, on nothing, or on the switch.
      const unmoved = !active || !this.host.nativeElement.contains(active) || !!(active as HTMLElement).closest('[data-popular-switch]');
      if (!unmoved || this.gone) {
        return;
      }
      const first = this.host.nativeElement.querySelector<HTMLElement>('[data-popular-grid] [data-fy-poster]');
      if (first) {
        first.focus({ preventScroll: true });
      } else if (tries > 0) {
        // Drawn on the next render, which a zoneless app does not promise by now.
        this.focusFirstIfUnmoved(tries - 1);
      }
    }, 50);
  }

  tryAgain(): void {
    this.failed.set(false);
    this.incomplete.set(false);
    void this.loadOn();
  }

  private footInSight(): boolean {
    const foot = this.foot()?.nativeElement;
    return !!foot && foot.getBoundingClientRect().top < window.innerHeight + 600;
  }

  /** A genre's best rated in place of its most popular, or back: a switch, not a step deeper. */
  showTop(top: boolean): void {
    const genre = this.genre();
    if (genre && genre.top !== top) {
      void this.router.navigate(['/discover', this.kind(), `genre-${genre.genre}${top ? '-top' : ''}`], { replaceUrl: true });
    }
  }

  /** The other list, in place of this one: a switch, not a step deeper. */
  showKind(kind: TmdbKind): void {
    if (kind !== this.kind()) {
      void this.router.navigate(['/for-you/popular', kind], { replaceUrl: true });
    }
  }

  backToTop(): void {
    this.page()?.nativeElement.scrollTo({ top: 0 });
    this.host.nativeElement.querySelector<HTMLElement>('[data-popular-grid] [data-fy-poster]')?.focus({ preventScroll: true });
  }

  browse(): void {
    void this.router.navigate([this.kind() === 'tv' ? '/shows' : '/movies']);
  }

  /** To the page the list was opened from; without one, where its lists live. */
  back(): void {
    if (history.length > 1) {
      history.back();
    } else if (this.list() === 'trending') {
      void this.router.navigate(['/for-you']);
    } else {
      this.browse();
    }
  }

  // --- A card, and the panel of its copies ----------------------------------

  readonly failedIcons = signal<ReadonlySet<string>>(new Set());

  iconFailed(url: string | null | undefined): void {
    if (url) {
      this.failedIcons.update(failed => new Set(failed).add(url));
    }
  }

  readonly menu = signal<PopularCard | null>(null);
  private menuFrom: HTMLElement | null = null;
  readonly menuActions = computed(() => {
    const card = this.menu();
    return card ? versionActions(card) : [];
  });
  readonly menuFilm = computed(() => {
    const card = this.menu();
    const first = card?.type === 'vod' ? card.versions[0] : undefined;
    return first ? { streamId: first.stream_id, name: first.name } : null;
  });

  private readonly shows = inject(ShowService);

  /** A film opens its own page (TV-27); a show its page, in the copy chosen for it or the person's languages (TV-29). */
  readonly ages = inject(AgeLockService);
  private readonly parental = inject(ParentalLockService);

  /** The posters' ratings learnt while the age lock is on, as the list grows. */
  private readonly ratings = effect(() => {
    const cards = this.cards();
    if (!this.ages.engaged()) {
      return;
    }
    untracked(() => void this.ages.learn(cards[0]?.item.kind ?? 'movie', cards.map(card => card.item.id)));
  });

  async open(card: PopularCard): Promise<void> {
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

  openMenu(card: PopularCard): void {
    this.menuFrom = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.menu.set(card);
  }

  closeMenu(): void {
    const back = this.menuFrom;
    this.menuFrom = null;
    this.menu.set(null);
    setTimeout(() => back?.isConnected && back.focus({ preventScroll: true }));
  }

  onMenuAction(id: string): void {
    const card = this.menu();
    this.closeMenu();
    if (card && id.startsWith('version:')) {
      openVersion(this.router, card, Number(id.slice('version:'.length)));
    }
  }
}
