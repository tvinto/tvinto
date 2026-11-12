import { DestroyRef, Injectable, inject } from '@angular/core';
import { DefaultUrlSerializer, NavigationEnd, NavigationStart, Router } from '@angular/router';

/**
 * Where somebody was on a screen, in terms that outlive the screen.
 *
 * `key` is the card's `data-focus-key`: every screen is rebuilt from nothing
 * when it is returned to, so the element itself is long gone. `top` and `left`
 * are where that card sat in the window, so it can be put back in the same
 * place rather than merely somewhere on screen -- a card that comes back as
 * the top row of the grid, when it was the second, is a list that has moved.
 */
export interface Place {
  key: string;
  top: number;
  left: number;
}

/**
 * Brings a keyed item into the document, for a list that only builds what is
 * on screen. Answers whether it knew the item: a virtual scroller asked to
 * scroll to a row it does not hold should not be asked again every tick.
 */
export type Revealer = (key: string) => boolean;

const FOCUS_KEY = 'data-focus-key';

/** How long a screen gets to draw the card again: a category read from the provider takes seconds. */
const GIVE_UP_AFTER_MS = 10_000;
const LOOK_EVERY_MS = 100;

/** How long a card that has been put back is kept there while the screen settles. */
const SETTLE_MS = 2000;

/** How long a dialog shown over the screen Back arrived at may hold the restore up. */
const DIALOG_WAIT_MS = 60_000;

/** A dialog over the screen: what focus belongs to while it is open. */
const dialogOpen = (): boolean => !!document.querySelector('[role="alertdialog"], [role="dialog"]');

/**
 * Back arrives where you left.
 *
 * Every screen here is a fresh component when it is returned to, and each used
 * to start from its top: back from a show landed at the top of the TV Shows
 * grid, however far down the show had been (26 September). For You
 * had its own fix, a module-level "last pressed" that nothing else shared, and
 * the category the section had open came back in the address -- but the card,
 * and how far down it was, did not.
 *
 * So the app notes, as it leaves any screen, which card had focus and where
 * that card was on screen; and on Back -- a history step, which is what both
 * the remote's Back and every page's own Back button are -- waits for the card
 * to be drawn again, focuses it, and scrolls it back to where it was.
 *
 * Only on Back. Going to a screen afresh, from the menu or a link, is asking
 * for it from the top.
 */
@Injectable({ providedIn: 'root' })
export class PlaceMemoryService {
  private readonly router = inject(Router);
  private readonly urls = new DefaultUrlSerializer();

  /** By the address the screen was at when it was left. */
  private readonly places = new Map<string, Place>();
  private readonly revealers = new Set<Revealer>();

  /** A Back in progress: the place to return to, and on which screen. */
  private pending: { path: string; place: Place } | null = null;
  private restoring: { stop: () => void } | null = null;

  private installed = false;

  install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;

    this.router.events.subscribe(event => {
      if (event instanceof NavigationStart) {
        this.leaving(event);
      } else if (event instanceof NavigationEnd) {
        this.arrived(event.urlAfterRedirects);
      }
    });
  }

  /**
   * Lets a screen whose list only builds the rows on screen bring one in.
   * Must be called from an injection context, so a component constructor; the
   * revealer goes with the component.
   */
  revealWith(revealer: Revealer): void {
    this.revealers.add(revealer);
    inject(DestroyRef).onDestroy(() => this.revealers.delete(revealer));
  }

  /** What was noted for an address. For tests. */
  placeAt(url: string): Place | null {
    return this.places.get(this.normal(url)) ?? null;
  }

  private leaving(event: NavigationStart): void {
    const from = this.normal(this.router.url);
    const to = this.normal(event.url);

    // A screen rewriting its own address in place -- the section noting the
    // category it has open -- is not a departure, and noting then would record
    // whatever happened to be focused while it loaded.
    if (this.path(from) !== this.path(to)) {
      const here = this.here();
      if (here) {
        this.places.set(from, here);
      } else {
        this.places.delete(from);
      }
    }

    if (event.navigationTrigger === 'popstate') {
      const place = this.places.get(to);
      this.pending = place ? { path: this.path(to), place } : null;
    } else if (this.pending && this.path(to) !== this.pending.path) {
      this.pending = null;
    }
  }

  private arrived(url: string): void {
    const pending = this.pending;
    this.pending = null;

    if (!pending) {
      // Somewhere else entirely: a restore still looking on the last screen stops.
      if (this.restoring && this.path(this.normal(url)) !== this.restoringPath) {
        this.stopRestoring();
      }
      return;
    }
    if (this.path(this.normal(url)) === pending.path) {
      this.restore(pending.path, pending.place);
    }
  }

  private restoringPath: string | null = null;

  /**
   * Looks for the card until it is drawn, then puts it back.
   *
   * Gives up the moment somebody presses anything: a person who has started
   * moving has chosen where to be, and focus jumping away from under them to
   * where they were a minute ago would be worse than never coming back.
   */
  private restore(path: string, place: Place): void {
    this.stopRestoring();

    let giveUpAt = Date.now() + GIVE_UP_AFTER_MS;
    const waitForDialogUntil = Date.now() + DIALOG_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const revealed = new Set<Revealer>();

    const stop = () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      document.removeEventListener('keydown', moved, true);
      document.removeEventListener('pointerdown', moved, true);
      document.removeEventListener('wheel', moved, true);
      document.removeEventListener('touchstart', moved, true);
      if (this.restoring?.stop === stop) {
        this.restoring = null;
        this.restoringPath = null;
      }
    };

    // A press that answers a dialog is not a move on the screen behind it.
    const moved = () => {
      if (!dialogOpen()) {
        stop();
      }
    };

    // Once found, held where it was for a while: a screen goes on filling in
    // after its cards are drawn. For You's live cards gain a programme title
    // when the guide answers, a second later, and every rail below grew by
    // 50px and pushed the card half off the screen it had just been put
    // back on.
    let found: { card: HTMLElement; settledAt: number } | null = null;

    const look = () => {
      timer = null;
      // A dialog shown on the way back -- a play that failed on the page that
      // asked for it -- keeps focus until it closes; the card is put back
      // after. Taking focus from it left OK pressing Play again behind the
      // error (26 October).
      if (dialogOpen() && Date.now() < waitForDialogUntil) {
        found = null;
        giveUpAt = Math.max(giveUpAt, Date.now() + GIVE_UP_AFTER_MS);
        timer = setTimeout(look, LOOK_EVERY_MS);
        return;
      }
      if (found) {
        if (document.activeElement !== found.card || !found.card.isConnected || Date.now() > found.settledAt) {
          stop();
          return;
        }
        this.putBack(found.card, place);
        timer = setTimeout(look, LOOK_EVERY_MS);
        return;
      }
      const card = this.find(place.key);
      if (card) {
        found = { card, settledAt: Date.now() + SETTLE_MS };
        this.putBack(card, place);
        timer = setTimeout(look, LOOK_EVERY_MS);
        return;
      }
      // Not drawn: a virtual list may hold it further down. Asked again until
      // it says it knows the item, since its rows may not have arrived yet.
      for (const reveal of this.revealers) {
        if (!revealed.has(reveal) && reveal(place.key)) {
          revealed.add(reveal);
        }
      }
      if (Date.now() < giveUpAt) {
        timer = setTimeout(look, LOOK_EVERY_MS);
      } else {
        stop();
      }
    };

    document.addEventListener('keydown', moved, true);
    document.addEventListener('pointerdown', moved, true);
    document.addEventListener('wheel', moved, true);
    document.addEventListener('touchstart', moved, true);
    this.restoring = { stop };
    this.restoringPath = path;
    timer = setTimeout(look);
  }

  private stopRestoring(): void {
    this.restoring?.stop();
  }

  /** Focus, then scroll whatever holds the card until it sits where it sat. */
  private putBack(card: HTMLElement, place: Place): void {
    if (document.activeElement !== card) {
      card.focus({ preventScroll: true });
    }

    const now = card.getBoundingClientRect();
    const down = now.top - place.top;
    const across = now.left - place.left;
    const vertical = this.scroller(card, 'y');
    const horizontal = this.scroller(card, 'x');
    if (vertical && down) {
      vertical.scrollTop += down;
    }
    if (horizontal && across) {
      horizontal.scrollLeft += across;
    }

    // Where the list could not scroll far enough -- fewer rows above it now --
    // at least on screen.
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** The nearest ancestor that scrolls along an axis, or the page. */
  private scroller(element: HTMLElement, axis: 'x' | 'y'): Element | null {
    for (let at = element.parentElement; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      const overflow = axis === 'y' ? style.overflowY : style.overflowX;
      const room = axis === 'y' ? at.scrollHeight > at.clientHeight : at.scrollWidth > at.clientWidth;
      if ((overflow === 'auto' || overflow === 'scroll') && room) {
        return at;
      }
    }
    return axis === 'y' ? document.scrollingElement : null;
  }

  /** The keyed item focus is on or inside, and where it is. */
  private here(): Place | null {
    const active = document.activeElement as HTMLElement | null;
    const card = active?.closest<HTMLElement>(`[${FOCUS_KEY}]`);
    const key = card?.getAttribute(FOCUS_KEY);
    if (!card || !key) {
      return null;
    }
    const rect = card.getBoundingClientRect();
    return { key, top: rect.top, left: rect.left };
  }

  /** The item, drawn and shown -- a card in a hidden layout does not count. */
  private find(key: string): HTMLElement | null {
    const all = document.querySelectorAll<HTMLElement>(`[${FOCUS_KEY}="${CSS.escape(key)}"]`);
    return Array.from(all).find(element => element.getClientRects().length > 0) ?? null;
  }

  private normal(url: string): string {
    try {
      return this.urls.serialize(this.urls.parse(url));
    } catch {
      return url;
    }
  }

  private path(url: string): string {
    return url.split(/[?#]/)[0];
  }
}
