import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { Category, StreamType } from '@shared/types';
import { firstValueFrom } from 'rxjs';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { AccountService } from '../../services/account.service';
import { ParentalLockService } from '../../services/parental-lock.service';
import { ALL_CHANNELS_ID, untagged } from '@shared/providers/providerRecord';
import { XtreamService } from '../../services/xtream.service';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpDown,
  lucideChevronDown,
  lucideChevronRight,
  lucideChevronUp,
  lucideEye,
  lucideEyeOff,
  lucideLocateFixed,
  lucideLock,
  lucideLockOpen,
  lucideSearch,
  lucideX
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { withoutTags } from '../../utils/channel-display.utils';
import { TPipe } from '../../pipes/t.pipe';

/**
 * Category list with a filter and in-place reordering.
 *
 * A native select is unusable at this size: several hundred options behind a
 * dropdown means scrolling blind, with no way to search or rearrange. This
 * keeps the list visible, narrows it as you type, and reorders where the
 * categories are rather than in a separate dialog.
 *
 * The inputs are signals because the derived list is a computed: a plain
 * @Input is not tracked, so the list would keep whatever it was first given.
 */
@Component({
  selector: 'app-category-picker',
  standalone: true,
  imports: [TPipe, ScrollingModule, NgIcon, HlmButton, HlmInput],
  providers: [
    provideIcons({
      lucideArrowUpDown,
      lucideChevronDown,
      lucideChevronRight,
      lucideChevronUp,
      lucideEye,
      lucideEyeOff,
      lucideLocateFixed,
      lucideLock,
      lucideLockOpen,
      lucideSearch,
      lucideX
    })
  ],
  // The host is a flex item of the browse column and has to stretch, or the
  // scroller inside it resolves to zero height and renders only its minimum
  // buffer. A component host sits between the two templates, so neither one
  // can express this on its own.
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  templateUrl: './category-picker.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CategoryPickerComponent {
  private readonly tv = inject(TvNavigationService);
  private readonly xtream = inject(XtreamService);
  readonly lock = inject(ParentalLockService);

  /** Whether arranging, hiding and locking are offered: not to a kid at its own device. */
  readonly canChangeSetup = inject(AccountService).canChangeSetup;

  /**
   * Row height in pixels, and the single source of it.
   *
   * The virtual scroller positions rows arithmetically from this number, so a
   * row that is not exactly this tall scrolls out of step with its own
   * scrollbar -- and on a television it also scrolls out of step with the
   * D-pad, which finds the next row by where it is on screen. It used to be a
   * constant beside an `h-8` in the template with a comment asking the two to
   * agree; they are bound to this now, which is a thing nobody has to remember.
   *
   * Sixty *design* pixels on a television, because the type there is 24 rather
   * than 14 and a 32px row would clip it. Not the 88 the canvas draws: the
   * sidebar of categories is the one list this app was explicitly asked to keep
   * dense. Converted to this device's CSS pixels by the TV scale, which is the
   * whole fix for the rows that overlapped: it was sixty CSS pixels, drawn at a
   * scale where the rows were taller than that.
   */
  readonly ROW_HEIGHT_PX = computed(() => (this.tv.isTelevision() ? this.tv.designPx(60) : 32));

  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  readonly categories = input<Category[]>([]);
  /** The library these belong to, which hiding and locking are kept by. */
  readonly type = input<StreamType | ''>('');
  /** Each provider's name by slot tag, for the group headers. */
  readonly providerLabels = input<Record<string, string>>({});
  /** Each provider's kind by slot tag, said beside its name: "Xtream · 363" (TV-21). */
  readonly providerKinds = input<Record<string, 'xtream' | 'm3u' | 'stalker'>>({});
  readonly selectedId = input<string>('');
  readonly favoritesCount = input<number>(0);
  /** Sentinel id for the favourites row, supplied by the host. */
  readonly favoritesId = input<string>('__favorites__');

  /**
   * Whether this is the narrow copy of the picker.
   *
   * The same component is the wide card on the front page and a 300px column
   * beside an open category. In the column the toolbar has about ninety pixels
   * for the filter box, which cut "Filter categories…" off mid-word — so there
   * the word goes on the button's tooltip and the box asks for less.
   */
  readonly compact = input<boolean>(false);

  readonly selectionChange = output<string>();

  /**
   * Arrange, which the host opens as its dialog (ReorderDialogComponent) on
   * every device. It used to be arranged in place here, in the narrow column
   * beside a category, where the names were cut to a word -- unusable on a
   * desktop (2 November) -- and on a phone the order arranged was
   * never even saved, since the sheet's copy of this list listened for none.
   */
  readonly arrange = output<void>();

  readonly filter = signal<string>('');

  /**
   * Hiding and locking, one category at a time.
   *
   * In place, and over every category -- the hidden and
   * locked ones too, which is the only list they are ever in. Reached only
   * past the PIN when there is one, or the lock could be taken off by anybody
   * holding the remote.
   */
  readonly managing = signal<boolean>(false);
  private readonly everything = signal<Category[]>([]);

  constructor() {
    // Locked again while the list of everything was open -- left alone past
    // the idle time. What it shows is exactly what the lock is for hiding.
    effect(() => {
      if (this.lock.engaged() && this.lock.anyLocked() && untracked(() => this.managing())) {
        untracked(() => this.stopManaging());
      }
    });
  }

  /** Keeps the scroller reusing a row's DOM instead of rebuilding it on scroll. */
  trackByRow(_index: number, row: PickerRow): string {
    return row.key;
  }

  /** Provider groups folded away on this device, by slot tag. */
  readonly collapsed = signal<ReadonlySet<string>>(readCollapsed());

  /**
   * Whether the list is grouped under its providers, as TiviMate groups
   * playlists: only when the categories come from more than one. With one
   * provider the list is exactly what it was (29 September).
   */
  readonly grouped = computed(() => {
    const source = this.managing() ? this.everything() : this.categories();
    return new Set(source.map(category => category.provider ?? '')).size > 1;
  });

  /**
   * What the scroller draws: the categories, and when grouped a header before
   * each provider's, whose categories are left out while it is folded. A
   * filter shows every match, folded or not, under its header.
   */
  readonly rows = computed<PickerRow[]>(() => {
    const entries = this.visibleCategories();
    if (!this.grouped()) {
      return entries.map(entry => ({ key: entry.category.category_id, header: null, ...entry }));
    }

    const byProvider = new Map<string, typeof entries>();
    for (const entry of entries) {
      const tag = entry.category.provider ?? '';
      byProvider.set(tag, [...(byProvider.get(tag) ?? []), entry]);
    }

    const filtering = !!this.filter().trim();
    const labels = this.providerLabels();
    const rows: PickerRow[] = [];
    for (const [tag, list] of byProvider) {
      const collapsed = !filtering && this.collapsed().has(tag);
      const label = labels[tag] || tag;
      rows.push({
        key: `provider:${tag}`,
        header: {
          tag,
          label,
          // The provider's own categories: its "All channels" row is not one.
          count: list.filter(entry => untagged(entry.category.category_id).id !== ALL_CHANNELS_ID).length,
          collapsed
        },
        category: { category_id: '', category_name: label, parent_id: '0', provider: tag },
        index: -1
      });
      if (!collapsed) {
        rows.push(...list.map(entry => ({ key: entry.category.category_id, header: null, ...entry })));
      }
    }
    return rows;
  });

  toggleGroup(tag: string): void {
    const next = new Set(this.collapsed());
    if (next.has(tag)) {
      next.delete(tag);
    } else {
      next.add(tag);
    }
    this.collapsed.set(next);
    writeCollapsed(next);
  }

  /**
   * The rows as drawn, each with whether it is hidden or locked. Worked out
   * when those change, not for every row at every check.
   */
  readonly shownRows = computed(() => {
    const type = this.type();
    return this.rows().map(row => {
      const id = String(row.category.category_id);
      return {
        ...row,
        hidden: !!type && this.lock.isHidden(type, id),
        locked: !!type && this.lock.isLocked(type, id)
      };
    });
  });

  readonly visibleCategories = computed(() => {
    const source = this.managing() ? this.everything() : this.categories();
    const term = this.filter().trim().toLowerCase();
    const entries = source.map((category, index) => ({ category, index }));

    return term
      ? entries.filter(e => e.category.category_name.toLowerCase().includes(term))
      : entries;
  });

  readonly totalCount = computed(() => (this.managing() ? this.everything().length : this.categories().length));

  /**
   * "42 of 830 · Sport": where the chosen category sits in the list, as TV-1
   * heads the sidebar. Null when nothing in the list is chosen -- Favourites is
   * not one of the 830.
   */
  readonly selectedPosition = computed(() => {
    const index = this.categories().findIndex(category => category.category_id === this.selectedId());
    return index < 0
      ? null
      : { position: index + 1, name: withoutTags(this.categories()[index].category_name) };
  });

  /** Favourites is hidden while hiding and locking: it is a view, not a category. */
  readonly showFavoritesRow = computed(() => !this.managing() && !this.filter().trim());

  /**
   * Shows the chosen category and puts focus on it.
   *
   * Two things this list has never done. It has never scrolled to the
   * selection: coming back from a show left the right row marked and usually
   * off screen, which only ever looked right because the selection happened to
   * be near the top. And the drawer needs it -- TV-N-1b opens "on the current
   * category, not the top of the list", which cannot be true of a list that is
   * somewhere else entirely.
   *
   * Two frames of waiting, and both are needed. The viewport has to be told to
   * scroll before it will render the row at all, the row does not exist in the
   * DOM until it has, and a keyed row is how focus finds anything here.
   */
  showSelected(): void {
    this.unfoldSelected();
    const viewport = this.viewport();
    const index = this.rows().findIndex(
      row => !row.header && row.category.category_id === this.selectedId()
    );
    if (!viewport || index < 0) {
      return;
    }

    viewport.scrollToIndex(this.withHeader(index));
    this.focusSelectedRow(viewport);
  }

  /**
   * Focus on the chosen row once the viewport has drawn it.
   *
   * One frame was enough when the list was opened near the selection. From
   * hundreds of rows away -- what the jump button is for -- the viewport takes
   * a few more to render the rows it has scrolled to, and a single try left
   * focus on the button while the list moved underneath it.
   */
  private focusSelectedRow(viewport: CdkVirtualScrollViewport, triesLeft = 10): void {
    requestAnimationFrame(() => {
      const row = viewport.elementRef.nativeElement.querySelector<HTMLElement>(
        '[aria-current="true"]'
      );
      if (row) {
        row.focus({ preventScroll: true });
      } else if (triesLeft > 0) {
        this.focusSelectedRow(viewport, triesLeft - 1);
      }
    });
  }

  /**
   * The open category, brought back into view (28 September).
   *
   * With 834 categories the one being watched is usually hundreds of rows
   * away from wherever the list was scrolled to, and nothing but scrolling
   * found it again. The caption that names it is the button: it is already
   * where the eye goes for "where am I".
   */
  jumpToSelected(): void {
    if (this.filter()) {
      this.clearFilter();
    }
    requestAnimationFrame(() => this.showSelected());
  }

  /**
   * Where to scroll for a row: to its provider's header when that is the row
   * just above, so a group's first category does not arrive without the name
   * of the provider it is in.
   */
  private withHeader(index: number): number {
    return index > 0 && this.rows()[index - 1]?.header ? index - 1 : index;
  }

  /** The open category's provider unfolded, so there is a row to go to. */
  private unfoldSelected(): void {
    const open = this.categories().find(category => category.category_id === this.selectedId());
    const tag = open?.provider ?? '';
    if (open && this.collapsed().has(tag)) {
      this.toggleGroup(tag);
    }
  }

  // --- Hiding and locking ---------------------------------------------------

  async startManaging(): Promise<void> {
    const type = this.type();
    if (!type || !(await this.lock.unlock())) {
      return;
    }
    const all = await firstValueFrom(this.xtream.getCategories(type, { everything: true })).catch(
      () => this.categories()
    );
    this.everything.set(all);
    this.filter.set('');
    this.managing.set(true);
    this.focusOpenRowControl();
  }

  stopManaging(): void {
    this.managing.set(false);
    this.everything.set([]);
    this.filter.set('');
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-manage-categories]')?.focus({ preventScroll: true })
    );
  }

  private isHidden(categoryId: string): boolean {
    const type = this.type();
    return !!type && this.lock.isHidden(type, categoryId);
  }

  private isLocked(categoryId: string): boolean {
    const type = this.type();
    return !!type && this.lock.isLocked(type, categoryId);
  }

  toggleHidden(categoryId: string): void {
    const type = this.type();
    if (type) {
      this.lock.setHidden(type, categoryId, !this.isHidden(categoryId));
    }
  }

  async toggleLocked(categoryId: string, name?: string): Promise<void> {
    const type = this.type();
    if (type) {
      await this.lock.setLocked(type, categoryId, !this.isLocked(categoryId), name);
    }
  }

  /** "Lock now" when open, the PIN pad when locked. */
  async toggleLockNow(): Promise<void> {
    if (this.lock.engaged()) {
      await this.lock.unlock();
    } else {
      this.lock.lockNow();
    }
  }

  /**
   * Into the list on the open category's row, where the list already is.
   *
   * The first toggle in the DOM is not the first on screen: the viewport keeps
   * a few rows drawn above what it shows, and focus went to one of those, off
   * the top of the panel.
   */
  private focusOpenRowControl(triesLeft = 10): void {
    requestAnimationFrame(() => {
      const viewport = this.viewport();
      const list = viewport?.elementRef.nativeElement;
      if (!viewport || !list) {
        return;
      }
      const index = this.rows().findIndex(
        row => !row.header && row.category.category_id === this.selectedId()
      );
      if (index >= 0 && triesLeft === 10) {
        viewport.scrollToIndex(this.withHeader(index));
      }
      const open = list.querySelector<HTMLElement>(
        `[data-focus-key="category-${this.selectedId()}"] [data-manage-toggle]`
      );
      const top = list.getBoundingClientRect().top;
      const firstShown = [...list.querySelectorAll<HTMLElement>('[data-manage-toggle]')].find(
        toggle => toggle.getBoundingClientRect().top >= top
      );
      const target = index >= 0 ? open : firstShown;
      if (target) {
        target.focus({ preventScroll: true });
      } else if (triesLeft > 0) {
        this.focusOpenRowControl(triesLeft - 1);
      }
    });
  }

  onFilterInput(event: Event) {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  clearFilter() {
    this.filter.set('');
  }

  select(categoryId: string) {
    if (this.managing()) {
      return;
    }
    this.selectionChange.emit(categoryId);
  }

  startArranging() {
    this.arrange.emit();
  }
}

/** A row of the list: a category, or the header of a provider's group. */
interface PickerRow {
  key: string;
  header: { tag: string; label: string; count: number; collapsed: boolean } | null;
  category: Category;
  /** The category's place in the whole list; -1 for a header. */
  index: number;
}

const COLLAPSED_KEY = 'xtream_collapsed_providers';

function readCollapsed(): ReadonlySet<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(stored) ? stored.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Folded for this run only.
  }
}
