import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { WatchProgress } from '@shared/types';
import { TmdbKind } from '@shared/tmdb/client';
import { PopularService } from '../../services/popular.service';
import { DiscoverService } from '../../services/discover.service';
import { TmdbService } from '../../services/tmdb.service';
import { XtreamService } from '../../services/xtream.service';
import { ShowService } from '../../services/show.service';
import { AgeLockService } from '../../services/age-lock.service';
import { ParentalLockService } from '../../services/parental-lock.service';
import { BackButtonService } from '../../services/back-button.service';
import { CardGesturesDirective } from '../../directives/card-gestures.directive';
import { ChannelMonogramPipe } from '../../pipes/format.pipes';
import { TPipe } from '../../pipes/t.pipe';
import { t } from '../../utils/i18n';
import { AgeCoverComponent } from '../age-cover/age-cover.component';
import { ItemActionsComponent } from '../item-actions/item-actions.component';
import { CategoryNames, PopularCard, categoryNames, openFilm, openShow, openVersion, popularCard, versionActions } from '../for-you/popular-cards';

/** A row of titles from one of TMDB's lists, with where its full list is. */
interface DiscoverRow {
  list: string;
  title: string;
  /** What the row is, said beside its title: "you watch these most"; '' for most. */
  note: string;
  cards: PopularCard[];
}

/** How many titles a row shows; the rest are on its full list. */
const ROW_LENGTH = 10;

/** Whether the rows are TMDB's, or there is no TMDB to ask and the page keeps the provider's. */
export type DiscoverState = 'rows' | 'none';

/**
 * The rows of Movies and TV Shows after Continue watching and My list (the
 * owner, 14 November): Popular, Trending this week, Top rated, New releases,
 * then a row for each of the two genres this person watches most. Every row
 * is one of TMDB's lists matched against the catalogue the device holds --
 * one card per title, whatever copies the provider has of it. Without a TMDB
 * key there are none, and `state` says so, so the page keeps the provider's
 * own category rows.
 */
@Component({
  selector: 'app-discover',
  standalone: true,
  imports: [RouterLink, CardGesturesDirective, ChannelMonogramPipe, TPipe, AgeCoverComponent, ItemActionsComponent],
  templateUrl: './discover.component.html',
  // Its rows are the page's own, spaced as the others are.
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DiscoverComponent {
  readonly kind = input.required<TmdbKind>();
  /** 'rows' once a row is on screen; 'none' when there is no key, or TMDB gave nothing and nothing was kept. */
  readonly state = output<DiscoverState>();

  private readonly router = inject(Router);
  private readonly tmdb = inject(TmdbService);
  private readonly popular = inject(PopularService);
  private readonly discover = inject(DiscoverService);
  private readonly xtream = inject(XtreamService);
  private readonly shows = inject(ShowService);
  readonly ages = inject(AgeLockService);
  private readonly parental = inject(ParentalLockService);

  readonly rows = signal<DiscoverRow[]>([]);

  private names: CategoryNames | null = null;
  /** The lists in the order their rows stand, whichever is matched first. */
  private order: string[] = [];
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.gone = true));
    inject(BackButtonService).bindTo(computed(() => this.menu() !== null), () => this.closeMenu());
    effect(() => {
      const kind = this.kind();
      untracked(() => void this.load(kind));
    });
    // A library that has just arrived is what an empty answer was waiting
    // for: one worked out while it downloaded (a stream playing, say) is
    // worked out again, rather than leaving the categories in its place.
    let indexing = this.xtream.indexing();
    effect(() => {
      const now = this.xtream.indexing();
      if (indexing !== null && now === null && untracked(() => !this.rows().length)) {
        untracked(() => void this.load(this.kind()));
      }
      indexing = now;
    });
    // Locked posters covered, as on Popular.
    effect(() => {
      const rows = this.rows();
      if (this.ages.engaged()) {
        untracked(() => void this.ages.learn(this.kind(), rows.flatMap(row => row.cards.map(card => card.item.id))));
      }
    });
  }

  private async load(kind: TmdbKind): Promise<void> {
    this.rows.set([]);
    if (!(await this.tmdb.client())) {
      this.state.emit('none');
      return;
    }
    this.names ??= await categoryNames(this.xtream);
    const lists: [string, string][] = [
      ['popular', t('discover.popular')],
      ['trending', t('discover.trending')],
      ['top', t('discover.topRated')],
      ['new', t('discover.newReleases')]
    ];
    this.order = lists.map(([list]) => list);
    // Every row as last matched, at once, before any is worked out again.
    for (const [list, title] of lists) {
      await this.showLast(kind, list, title, '');
    }
    for (const [list, title] of lists) {
      if (this.gone || this.kind() !== kind) {
        return;
      }
      await this.showToday(kind, list, title, '');
    }

    const genres = await this.discover.genres(kind);
    const history = await firstValueFrom(
      this.xtream.getRecentlyWatched(kind === 'tv' ? 'series' : 'vod', 60).pipe(catchError(() => of([] as WatchProgress[])))
    );
    const watched = (await this.discover.watched(kind, history))
      .map(id => genres.find(genre => genre.id === id))
      .filter(genre => genre !== undefined);
    this.order = [...lists.map(([list]) => list), ...watched.map(genre => `genre-${genre.id}`)];
    // Rows for genres no longer watched most go, now that it is known which are.
    this.rows.update(rows => rows.filter(row => this.order.includes(row.list)));
    for (const genre of watched) {
      if (this.gone || this.kind() !== kind) {
        return;
      }
      await this.showLast(kind, `genre-${genre.id}`, genre.name, t('discover.watchMost'));
      await this.showToday(kind, `genre-${genre.id}`, genre.name, t('discover.watchMost'));
    }
    if (!this.gone && this.kind() === kind && !this.rows().length) {
      this.state.emit('none');
    }
  }

  /**
   * A row as last matched, at once; then (`showToday`) as matched today,
   * which is also at once after the first visit of the day (PopularService
   * keeps it). Each row worked out again on every visit, with nothing on
   * screen until it was, is what a user found (26 October).
   */
  private async showLast(kind: TmdbKind, list: string, title: string, note: string): Promise<void> {
    const last = await this.popular.lastPopular(kind, ROW_LENGTH, list);
    if (!this.gone && this.kind() === kind && last?.length) {
      this.place({ list, title, note, cards: last.map(entry => popularCard(entry, this.names!)) });
    }
  }

  private async showToday(kind: TmdbKind, list: string, title: string, note: string): Promise<void> {
    const found = await this.popular.popular(kind, ROW_LENGTH, list);
    if (this.gone || this.kind() !== kind) {
      return;
    }
    if (found.length) {
      this.place({ list, title, note, cards: found.map(entry => popularCard(entry, this.names!)) });
    }
  }

  /** In its place among the others, whichever was matched first; the page hears that there are rows. */
  private place(row: DiscoverRow): void {
    const at = (one: DiscoverRow) => this.order.indexOf(one.list);
    this.rows.update(rows => [...rows.filter(one => one.list !== row.list), row].sort((a, b) => at(a) - at(b)));
    this.state.emit('rows');
  }

  /** What the spotlight looks the card up by: the copy Play would choose, which is what a film's or show's own page reads. */
  spotId(card: PopularCard): string {
    return String(card.versions[0]?.stream_id ?? '');
  }

  link(list: string): string[] {
    return ['/discover', this.kind(), list];
  }

  /** A film opens its own page; a show its page, in its chosen copy -- after the PIN, when the age lock keeps it. */
  async open(card: PopularCard): Promise<void> {
    const rating = this.ages.lockedLabel(card.item.kind, card.item.id);
    if (rating && !(await this.parental.unlock(t('lock.age.subject', { rating, title: card.item.title })))) {
      return;
    }
    if (card.type === 'vod') {
      openFilm(this.router, card);
    } else {
      openShow(this.router, card, this.shows.chosen(card.item.id));
    }
  }

  readonly failedIcons = signal<ReadonlySet<string>>(new Set());

  iconFailed(url: string | null | undefined): void {
    if (url) {
      this.failedIcons.update(failed => new Set(failed).add(url));
    }
  }

  /** A long press or Menu on a card: the actions panel, as on Popular and the other rows. */
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
