import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { WatchProgress } from '@shared/types';
import { TmdbGenre, TmdbKind } from '@shared/tmdb/client';
import { HlmButton } from '@spartan-ng/helm/button';
import { PopularService } from '../../services/popular.service';
import { DiscoverService } from '../../services/discover.service';
import { XtreamService } from '../../services/xtream.service';
import { ShowService } from '../../services/show.service';
import { AgeLockService } from '../../services/age-lock.service';
import { ParentalLockService } from '../../services/parental-lock.service';
import { BackButtonService } from '../../services/back-button.service';
import { CardGesturesDirective } from '../../directives/card-gestures.directive';
import { ChannelMonogramPipe } from '../../pipes/format.pipes';
import { TPipe } from '../../pipes/t.pipe';
import { t } from '../../utils/i18n';
import { lastInput, whenQuiet } from '../../utils/quiet.utils';
import { AgeCoverComponent } from '../age-cover/age-cover.component';
import { ItemActionsComponent } from '../item-actions/item-actions.component';
import { CategoryNames, PopularCard, categoryNames, openFilm, openShow, openVersion, popularCard, versionActions } from '../for-you/popular-cards';

/** A row of titles from one of TMDB's lists, with where its full list is. */
interface DiscoverRow {
  list: string;
  title: string;
  /** What the row is, said beside its title: "in your library", "you watch these most". */
  note: string;
  cards: PopularCard[];
}

/** How many titles a row shows; the rest are on its full list. */
const ROW_LENGTH = 10;

/**
 * Top rated and genres at the top of Movies and TV Shows (TV-32, P-20):
 * "Browse by" -- Top rated, then the genres the library has enough of, a
 * chip each opening that list in full -- then a row of the top rated, and a
 * row for each of the two genres this person watches most. Everything is
 * TMDB's lists matched against the catalogue the device holds; without a
 * TMDB key the block is absent.
 */
@Component({
  selector: 'app-discover',
  standalone: true,
  imports: [RouterLink, HlmButton, CardGesturesDirective, ChannelMonogramPipe, TPipe, AgeCoverComponent, ItemActionsComponent],
  templateUrl: './discover.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DiscoverComponent {
  readonly kind = input.required<TmdbKind>();

  private readonly router = inject(Router);
  private readonly popular = inject(PopularService);
  private readonly discover = inject(DiscoverService);
  private readonly xtream = inject(XtreamService);
  private readonly shows = inject(ShowService);
  readonly ages = inject(AgeLockService);
  private readonly parental = inject(ParentalLockService);

  readonly genres = signal<TmdbGenre[]>([]);
  readonly rows = signal<DiscoverRow[]>([]);

  private names: CategoryNames | null = null;
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.gone = true));
    inject(BackButtonService).bindTo(computed(() => this.menu() !== null), () => this.closeMenu());
    effect(() => {
      const kind = this.kind();
      untracked(() => void this.load(kind));
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
    const genres = await this.discover.genres(kind);
    if (this.gone || !genres.length) {
      return;
    }
    this.genres.set(await this.discover.offered(kind));
    this.names ??= await categoryNames(this.xtream);

    await this.show(kind, 'top', t(kind === 'tv' ? 'discover.topShows' : 'discover.topFilms'), t('discover.inLibrary'));

    const history = await firstValueFrom(
      this.xtream.getRecentlyWatched(kind === 'tv' ? 'series' : 'vod', 60).pipe(catchError(() => of([] as WatchProgress[])))
    );
    const watched = await this.discover.watched(kind, history);
    // Rows for genres no longer watched most go, now that it is known which are.
    this.rows.update(rows => rows.filter(row => row.list === 'top' || watched.some(id => row.list === `genre-${id}`)));
    for (const id of watched) {
      const genre = genres.find(one => one.id === id);
      if (genre) {
        await this.show(kind, `genre-${id}`, genre.name, t('discover.watchMost'));
      }
      if (this.gone) {
        return;
      }
    }

    // Which genres the library has enough of: counted in a quiet moment, once a week.
    if (await whenQuiet({ afterStartMs: 30_000, idleMs: 10_000, checkEveryMs: 5_000, now: () => performance.now(), lastInput, stopped: () => this.gone, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) })) {
      const stop = () => this.gone || performance.now() - lastInput() < 5_000;
      if ((await this.discover.countGenres(kind, stop)) && !this.gone) {
        this.genres.set(await this.discover.offered(kind));
      }
    }
  }

  /**
   * One row: as last matched first, at once, then as matched today, which is
   * also at once after the first visit of the day (PopularService keeps it).
   * Each row worked out again on every visit, with nothing on screen until it
   * was, is what a user found (26 October).
   */
  private async show(kind: TmdbKind, list: string, title: string, note: string): Promise<void> {
    const last = await this.popular.lastPopular(kind, ROW_LENGTH, list);
    if (this.gone) {
      return;
    }
    if (last?.length) {
      this.place({ list, title, note, cards: last.map(entry => popularCard(entry, this.names!)) });
    }
    const found = await this.popular.popular(kind, ROW_LENGTH, list);
    if (this.gone) {
      return;
    }
    if (found.length) {
      this.place({ list, title, note, cards: found.map(entry => popularCard(entry, this.names!)) });
    } else if (!last?.length) {
      this.rows.update(rows => rows.filter(row => row.list !== list));
    }
  }

  /** In its place when the row is on screen already, else after the others. */
  private place(row: DiscoverRow): void {
    this.rows.update(rows => (rows.some(one => one.list === row.list) ? rows.map(one => (one.list === row.list ? row : one)) : [...rows, row]));
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
