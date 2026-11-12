import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, linkedSignal, output, signal, untracked, viewChild } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideChevronDown, lucideChevronUp, lucideSearch, lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { moveToIndex, moveWithinFilteredList, toTargetIndex } from '../../utils/ordering.utils';
import { channelDisplay, withoutTags } from '../../utils/channel-display.utils';
import { FocusScopeDirective } from '../../directives/focus-scope.directive';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { AccountService } from '../../services/account.service';
import { TPipe } from '../../pipes/t.pipe';

export interface ReorderItem {
  id: string;
  name: string;
}

/**
 * Lets the user arrange a list by dragging rows or stepping them with the
 * arrow buttons, with a filter for reaching one entry among hundreds.
 *
 * Reordering always acts on the whole list rather than the filtered view, so
 * hiding rows never drops them from the arrangement that is emitted.
 */
@Component({
  selector: 'app-reorder-dialog',
  standalone: true,
  imports: [TPipe, NgIcon, HlmButton, HlmInput, FocusScopeDirective, ScrollingModule],
  providers: [
    provideIcons({ lucideArrowLeft, lucideChevronDown, lucideChevronUp, lucideSearch, lucideX })
  ],
  templateUrl: './reorder-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReorderDialogComponent {
  /** Wording only: whether this list is categories or channels. */
  /** On a television the keypad is a permanent column (TV-14); on a desktop it comes and goes. */
  readonly tv = inject(TvNavigationService);
  /** "Your order follows this account" only where there is one: a device used without one keeps it here. */
  readonly signedIn = inject(AccountService).signedIn;

  readonly kind = input<'category' | 'stream'>('category');
  readonly items = input<ReorderItem[]>([]);
  readonly saving = input(false);

  readonly save = output<string[]>();
  readonly cancel = output<void>();

  /** The list as arranged so far: the one given, again whenever a new one is given. */
  readonly workingItems = linkedSignal(() => [...this.items()]);
  readonly filter = signal<string>('');
  readonly draggingIndex = signal<number | null>(null);

  /**
   * The row whose position is being typed, and where it started.
   *
   * Null unless the keypad is open. `from` is kept so the row can say what it
   * was moved off, which is the only way to undo by hand in a list of eight
   * hundred -- the number it used to have is not recoverable from anywhere on
   * screen once something else is sitting there.
   */
  readonly editing = signal<{ id: string; name: string; from: number } | null>(null);

  /** The digits pressed so far. A string, because "0" and "" differ here. */
  readonly typed = signal<string>('');

  /** The last row moved by number, so it can carry a "was N" for a moment. */
  readonly movedFrom = signal<{ id: string; from: number } | null>(null);


  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  /**
   * The height of one row, which the virtual scroller places its rows from.
   *
   * A number rather than a measurement, because the scroller needs it before
   * anything is drawn. Both figures are what the stylesheet draws: 52 pixels of
   * row and 6 of gap on a desktop; on a television 5.5rem of row and 0.5rem of
   * gap, in design pixels, scaled to this screen. The two have to be kept in
   * step with `[data-tv-arrange-row]` in styles.css -- a row that draws taller
   * than this number overlaps the one below it.
   */
  readonly ROW_HEIGHT_PX = computed(() =>
    this.tv.isTelevision() ? this.tv.designPx(96) : 58
  );

  /** Rows to show, each carrying its position in the full list. */
  readonly visibleItems = computed(() => {
    const term = this.filter().trim().toLowerCase();
    const entries = this.workingItems().map((item, index) => ({ item, index }));
    return term ? entries.filter(e => e.item.name.toLowerCase().includes(term)) : entries;
  });

  /**
   * Each row as drawn: its name as the app writes it, the position shown in
   * its box, whether it is the one being typed into, and what it was moved
   * off. Worked out when the list or the typing changes, not at every check.
   */
  readonly rows = computed(() => {
    const editing = this.editing();
    const typed = this.typed();
    const moved = this.movedFrom();
    const visible = this.visibleItems();
    return visible.map((entry, at) => {
      const id = String(entry.item.id);
      const isEditing = !!editing && editing.id === id;
      return {
        ...entry,
        shown: this.shownName(entry.item.name),
        editing: isEditing,
        position: isEditing ? typed : String(entry.index + 1),
        was: moved && moved.id === id ? moved.from + 1 : null,
        first: at === 0,
        last: at === visible.length - 1
      };
    });
  });

  constructor() {
    // A new list starts unfiltered, with nothing being dragged.
    effect(() => {
      this.items();
      untracked(() => {
        this.filter.set('');
        this.draggingIndex.set(null);
      });
    });
  }

  onFilterInput(event: Event) {
    this.filter.set((event.target as HTMLInputElement).value);
    // A drag in progress refers to a row that may no longer be shown.
    this.draggingIndex.set(null);
  }

  clearFilter() {
    this.filter.set('');
    this.draggingIndex.set(null);
  }

  /**
   * A row's name as the rest of the app writes it: a channel without its
   * country tag (D-9), a category keeping it, since among hundreds from every
   * country that tag is how one is told from another.
   */
  private shownName(name: string): string {
    return this.kind() === 'stream' ? channelDisplay(name).title : withoutTags(name);
  }

  reset() {
    this.workingItems.set([...this.items()]);
  }

  moveItem(index: number, delta: number) {
    const moved = this.workingItems()[index];
    this.workingItems.set(
      moveWithinFilteredList(this.workingItems(), this.visibleItems(), index, delta)
    );
    if (moved) {
      this.keepFocusOn(moved.id, delta < 0 ? 'up' : 'down');
    }
  }

  /**
   * Focus stays with the row that moved, on the arrow that moved it.
   *
   * On a television it fell to nothing after every step, so the next press
   * only found it again: the virtual scroller moves the row's element to its
   * new place, which takes focus with it, and a row stepped to the top or the
   * bottom disables the very arrow focus was on. Arrange looked as though it
   * did not work (22 September). Found again by the item, as
   * everything under a virtual scroller has to be, and on the other arrow when
   * this one has just been spent.
   */
  private keepFocusOn(itemId: string, arrow: 'up' | 'down'): void {
    // After the scroller has put the row in its new place. One step never
    // takes a row out of the rendered range, so it is there to be found.
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-focus-key="arrange-${itemId}"]`);
      const buttons = Array.from(
        row?.querySelectorAll<HTMLButtonElement>('[data-tv-arrange-steps] button') ?? []
      );
      // By what the arrow does, not what it says, which is in the language in use.
      const wanted = buttons.find(button => button.dataset['step'] === arrow && !button.disabled);
      const target = wanted ?? buttons.find(button => !button.disabled);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    });
  }

  /* ---- Typing a position, without summoning a keyboard ------------------
   *
   * A position field that accepts text raises the system keyboard on Android,
   * and on a television that keyboard covers the list the number refers to --
   * so the one thing you need to see while typing is the one thing you cannot.
   * `inputmode="none"` looks like the answer and is not: measured here, it
   * suppresses the keyboard and swallows the OK button with it, leaving the
   * field impossible to leave. `readonly` was the only thing that did both.
   *
   * So the field is readonly and the digits come from somewhere else: this
   * keypad for a remote, and the physical keys for a desktop, which still
   * arrive as keydown on a readonly input. One state, two ways in.
   */

  /** Opens the keypad against a row. */
  beginEdit(itemId: string, name: string, from: number): void {
    this.editing.set({ id: String(itemId), name, from });
    this.typed.set('');
  }

  closeEdit(): void {
    this.editing.set(null);
    this.typed.set('');
  }

  /**
   * Lets go of the row when focus does.
   *
   * A row is marked as being edited by its position field taking focus, and
   * nothing used to let go: walk from a row up to the filter box and the first
   * row stayed lit, so two things on screen claimed to be the current one.
   *
   * Two exceptions, and they are the whole of it. The keypad is how a position
   * is typed, so focus moving into it is focus still on this row. And another
   * row's position field is a new edit, not the end of this one -- its own
   * `focus` handler is about to say so.
   */
  onFocusMoved(event: FocusEvent): void {
    if (!this.editing()) {
      return;
    }

    const arrived = event.target as HTMLElement | null;
    const staysWithTheRow =
      !!arrived &&
      (arrived.hasAttribute('data-tv-arrange-position') || !!arrived.closest('[data-keypad]'));

    if (!staysWithTheRow) {
      this.closeEdit();
    }
  }

  /** The item, so a recycled row is found again by what it holds. */
  trackByItemId(_index: number, entry: { item: ReorderItem }): string {
    return entry.item.id;
  }

  /** What the field shows: the digits typed, or the position it still holds. */
  private isEditing(itemId: string): boolean {
    const editing = this.editing();
    return !!editing && editing.id === String(itemId);
  }

  press(digit: string): void {
    // Capped at the width of the largest legal position, so a stuck key cannot
    // build a number the list could never have.
    const room = String(this.workingItems().length).length;
    this.typed.set((this.typed() + digit).replace(/^0+(?=\d)/, '').slice(0, room));
  }

  backspace(): void {
    this.typed.set(this.typed().slice(0, -1));
  }

  /** Applies the typed position, if it is one. */
  applyTyped(): void {
    const editing = this.editing();
    if (!editing) {
      return;
    }

    const items = this.workingItems();
    const currentIndex = items.findIndex(item => String(item.id) === editing.id);
    const target = toTargetIndex(this.typed(), items.length);

    if (currentIndex === -1 || target === null || target === currentIndex) {
      this.closeEdit();
      return;
    }

    this.workingItems.set(moveToIndex(items, currentIndex, target));
    this.movedFrom.set({ id: editing.id, from: currentIndex });
    this.draggingIndex.set(null);
    this.closeEdit();

    // Focus was on Move, which the move has just disabled; on a remote that
    // left it on nothing. It goes with the row instead, to where it now is.
    if (this.tv.isTelevision()) {
      this.followRow(editing.id);
    }
  }

  /** Scrolls a row into view at its new place, and puts focus on its position. */
  private followRow(itemId: string): void {
    const at = this.visibleItems().findIndex(entry => entry.item.id === itemId);
    if (at < 0) {
      return;
    }
    this.viewport()?.scrollToIndex(Math.max(0, at - 2));
    // Two frames: one for the scroller to render the new range, one to find it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-focus-key="arrange-${itemId}"] [data-tv-arrange-position]`)
          ?.focus({ preventScroll: true })
      )
    );
  }

  /**
   * To the keypad, on a remote, from a row's position.
   *
   * The keypad only answers while a row is being edited, and the way to it
   * from the row runs across the row's own arrows -- which end the edit, so
   * the keypad was switched off by the time focus got there and could never be
   * reached (22 September). OK on the position goes straight to it.
   */
  private toKeypad(): void {
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-keypad] [data-tv-keypad-grid] button:not([disabled])')?.focus()
    );
  }

  /**
   * A physical keyboard, on the same state as the keypad.
   *
   * The field is readonly, so nothing arrives in it by itself; these are the
   * keys a desktop user expects to work and would otherwise find dead.
   */
  onPositionKey(event: KeyboardEvent): void {
    const key = event.key;

    if (key >= '0' && key <= '9') {
      event.preventDefault();
      this.press(key);
    } else if (key === 'Backspace') {
      event.preventDefault();
      this.backspace();
    } else if (key === 'Enter') {
      event.preventDefault();
      if (this.tv.isTelevision() && !this.typed()) {
        this.toKeypad();
        return;
      }
      this.applyTyped();
    } else if (key === 'Escape') {
      event.preventDefault();
      this.closeEdit();
    }
  }

  onDragStart(index: number) {
    this.draggingIndex.set(index);
  }

  onDragOver(index: number, event: DragEvent) {
    event.preventDefault();
    const from = this.draggingIndex();
    if (from === null || from === index) {
      return;
    }
    this.workingItems.set(moveToIndex(this.workingItems(), from, index));
    this.draggingIndex.set(index);
  }

  onDragEnd() {
    this.draggingIndex.set(null);
  }

  /** True when the row sits at the visible top or bottom, so its arrow is spent. */
  emitSave() {
    // The whole list, not the filtered view.
    this.save.emit(this.workingItems().map(i => i.id));
  }
}
