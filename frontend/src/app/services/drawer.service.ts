import { Injectable, computed, inject, signal } from '@angular/core';
import { TvNavigationService } from './tv-navigation.service';

/** How far the panels on the left are pushed open (TV-N-1). */
export type DrawerLevel = 'closed' | 'categories' | 'navigation';

/**
 * The drawer, which is the whole of the navigation on a television.
 *
 * It began inside the browse screen, because that is where the categories are.
 * Then the navigation bar came off the top of the set -- every item in it is in
 * the drawer, and a row of links across the top of a television is a row the
 * D-pad has to walk through to reach anything below it -- and the drawer
 * stopped being the browse screen's business: with no bar, a screen that cannot
 * open one is a screen with no way out of it.
 *
 * So the state lives here and the shell draws the navigation panel, over every
 * page. The browse screen adds the middle level, its categories, and says so
 * with `offersCategories`; everywhere else Left goes straight to the
 * navigation. Nothing here does anything off a television, where the bar is
 * still the bar.
 */
@Injectable({ providedIn: 'root' })
export class DrawerService {
  private readonly tv = inject(TvNavigationService);

  readonly level = signal<DrawerLevel>('closed');

  /**
   * Whether the screen on show has a categories level between the guide and the
   * navigation. Set by the browse screen while it is on, and cleared when it
   * leaves -- otherwise the level it offers outlives the panel that draws it.
   */
  readonly offersCategories = signal(false);

  readonly open = computed(() => this.tv.isTelevision() && this.level() !== 'closed');

  /**
   * What had focus when the drawer opened, to give it back when it shuts.
   *
   * Here rather than in whichever screen opened it. The browse screen kept its
   * own and every other screen kept none, so on For You, Guides, Account and
   * Search, Right or Back out of the navigation removed the panel focus was in
   * and left it on nothing -- the next press was spent finding it again. Found
   * by the QA walk (tools/qa/tv-walk.js).
   *
   * The item's focus key where it has one, since a virtual scroller may have
   * recycled the element meanwhile; the element itself for the rest.
   */
  private cameFrom: { key: string | null; element: HTMLElement | null } | null = null;

  /** One level further open. Returns false when there is nowhere further. */
  deeper(): boolean {
    if (!this.tv.isTelevision()) {
      return false;
    }

    const at = this.level();
    if (at === 'navigation') {
      return false;
    }

    if (at === 'closed') {
      const active = document.activeElement as HTMLElement | null;
      const element = active && active !== document.body ? active : null;
      this.cameFrom = {
        key: element?.closest<HTMLElement>('[data-focus-key]')?.getAttribute('data-focus-key') ?? null,
        element
      };
    }

    if (at === 'closed' && this.offersCategories()) {
      this.level.set('categories');
      return true;
    }

    this.level.set('navigation');
    return true;
  }

  /** One level back. Returns false when it was already shut. */
  shallower(): boolean {
    const at = this.level();
    if (at === 'closed') {
      return false;
    }

    this.level.set(at === 'navigation' && this.offersCategories() ? 'categories' : 'closed');
    if (this.level() === 'closed') {
      this.returnFocus();
    }
    return true;
  }

  /** Shut without giving focus back: the caller is putting it somewhere new. */
  shut(): void {
    this.cameFrom = null;
    this.level.set('closed');
  }

  private returnFocus(): void {
    const from = this.cameFrom;
    this.cameFrom = null;

    // After the panel has gone and the columns have their width back.
    requestAnimationFrame(() => {
      if (from?.key && this.tv.focusItem(from.key)) {
        return;
      }
      if (from?.element?.isConnected) {
        from.element.focus({ preventScroll: true });
        return;
      }
      this.tv.focusContentWhenReady();
    });
  }
}
