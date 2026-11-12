import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { platformSaysTelevision } from './native/television';

/** Which way a press wants to move. */
type Direction = 'up' | 'down' | 'left' | 'right';

const DIRECTIONS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
};

/**
 * What counts as reachable.
 *
 * Deliberately not `[tabindex]` in general: a `tabindex="-1"` element is one
 * that has been deliberately taken out of the running, and honouring that is
 * how a dialog keeps focus inside itself.
 */
const FOCUSABLE = [
  // The `:not` matters as much here as on the generic `[tabindex]` below. A
  // link is reachable because it is a link, so without it `tabindex="-1"` on
  // an anchor reads as a no-op: the logo in the corner was taken out of the
  // running and went on taking focus.
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * How much being off to one side counts against a candidate.
 *
 * Above 1, so that "roughly straight ahead but further away" beats "very close
 * but well off to the side". Without it, pressing down in a grid drifts
 * diagonally: the nearest thing below-and-left is usually closer than the thing
 * directly below, and three presses later you are in another column.
 */
const DRIFT_PENALTY = 3;

/**
 * How much the centre-to-centre offset counts: enough to break a tie between
 * candidates equally far ahead and equally on the line, never enough to beat
 * one that is actually nearer.
 */
const CENTRE_TIEBREAK = 0.05;

/**
 * What names a row or a card, so focus can find it again after a re-render.
 *
 * A virtualised list does not keep the element you are standing on. Scroll far
 * enough and the CDK detaches the view holding it and reuses it for another
 * item further down -- and a focused element removed from the document takes
 * focus with it, to `body`. The remote then appears to die: the ring is gone,
 * and the next press has nothing to move from.
 *
 * An element cannot be remembered across that, because it is the element that
 * goes. What survives is the *item*: this attribute carries a channel's or a
 * category's own id, and the row is found again by asking for it.
 */
const FOCUS_KEY = 'data-focus-key';

/**
 * A programme landed on beneath the channel names -- which stay put while the
 * lanes scroll under them -- brought out far enough to be seen: a quarter of
 * the lanes on screen, or all of it if it is shorter. The browser counted it
 * as in view already, so Left to the programme before the one on air left
 * focus on a sliver beside the names (the TV emulator, 6 October). Only as
 * far as that, so the guide does not jump back hours for a long one.
 *
 * And never left of where the guide opened, the current hour (`GUIDE_LEFTMOST`):
 * each Left went a quarter further into the past, until the channel names
 * were hours of programmes away (21 October). At that edge a
 * programme further back is under the names, so Left goes to the name.
 */
const outFromUnderTheNames = (element: HTMLElement): void => {
  const lane = element.closest<HTMLElement>('[data-tv-guide-lane]');
  const names = lane?.closest<HTMLElement>(GUIDE_ROW)?.firstElementChild;
  const scroller = lane?.closest<HTMLElement>('cdk-virtual-scroll-viewport');
  if (!lane || !names || !scroller) {
    return;
  }
  const edge = names.getBoundingClientRect().right;
  const box = element.getBoundingClientRect();
  const shown = scroller.getBoundingClientRect().right - edge;
  const wanted = Math.min(box.width, shown / 4);
  const visible = box.right - Math.max(box.left, edge);
  if (visible < wanted) {
    const leftmost = Number(scroller.getAttribute(GUIDE_LEFTMOST) ?? 0) || 0;
    scroller.scrollLeft = Math.max(leftmost, scroller.scrollLeft - (wanted - visible));
  }
};

/** On a guide's scroller: how far left a remote may take its lanes, in px. */
export const GUIDE_LEFTMOST = 'data-tv-guide-leftmost';

/**
 * The container that scrolls sideways under an element stuck to its left
 * edge (position: sticky with a left), or null when the element is not.
 */
const stuckSideways = (element: HTMLElement): HTMLElement | null => {
  for (let at: HTMLElement | null = element; at && at !== document.body; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.position === 'sticky' && style.left !== 'auto') {
      for (let scroller = at.parentElement; scroller && scroller !== document.body; scroller = scroller.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(scroller).overflowX)) {
          return scroller;
        }
      }
      return null;
    }
    if (/(auto|scroll)/.test(style.overflowX)) {
      // Reached the scroller without meeting anything stuck.
      return null;
    }
  }
  return null;
};

/** The nearest ancestor that scrolls sideways: a guide's lanes. */
const sidewaysScroller = (element: HTMLElement): HTMLElement | null => {
  for (let at = element.parentElement; at && at !== document.body; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowX)) {
      return at;
    }
  }
  return null;
};

/**
 * Programmes as much of them as shows beside the channel column, which stays
 * put while the lanes scroll under it; one hidden under it entirely is left
 * out. Without this, Up from a name chose a finished programme lying beneath
 * the next name, since the lanes scroll and so count as on screen.
 */
const besideTheNames = (candidates: Reachable[]): Reachable[] =>
  candidates.flatMap(candidate => {
    const rect = shownBesideTheNames(candidate.element, candidate.rect);
    return rect.width < 8 ? [] : [{ ...candidate, rect }];
  });

/**
 * The part of a programme's box beside the channel names, or the box itself
 * for anything not in a guide lane. Also where a press from a programme is
 * measured from: one that began before the guide's first hour lies mostly
 * under the names, and measured whole, the name was not to its left -- Left
 * from it went nowhere while Down reached the names (23 October).
 */
const shownBesideTheNames = (element: HTMLElement, rect: DOMRect): DOMRect => {
  const lane = element.closest<HTMLElement>('[data-tv-guide-lane]');
  const names = lane?.closest<HTMLElement>(GUIDE_ROW)?.firstElementChild;
  if (!lane || !names) {
    return rect;
  }
  const left = Math.max(rect.left, names.getBoundingClientRect().right);
  return new DOMRect(left, rect.top, Math.max(0, rect.right - left), rect.height);
};

/** A channel's row in the guide: its name and its programmes. */
const GUIDE_ROW = '[data-tv-guide-row]';

/**
 * How many rows either side Up and Down look through. More than one, because
 * a row with nothing focusable in it would otherwise stop the walk.
 */
const NEIGHBOUR_ROWS = 3;

/** Holding Up or Down in the guide: two rows a step from here, four from the next. */
const HOLD_FASTER_AFTER_MS = 2000;

/** Until then, one row this often: about nine a second, slow enough to stop on. */
const STEADY_STEP_MS = 110;
const HOLD_FASTEST_AFTER_MS = 4000;

/**
 * On a field this service made read-only to keep the keyboard down, and only
 * there. What tells OK "open this one", as opposed to a field that is
 * read-only because something else types into it.
 */
export const HELD_BACK = 'data-tv-held-back';

/**
 * How long to wait at launch for something to focus. The front page's rails
 * come from local storage in well under a second; a slow first sign-in can
 * take longer, and after this the first key press still finds its way.
 */
const FIRST_FOCUS_WAIT_MS = 8000;

/**
 * How long a screen gets to show a card or a channel before focus settles for
 * its first plain control instead. Guides and Account have no cards at all.
 */
const FALLBACK_AFTER_MS = 1000;

/** A focusable element and where it is, measured once. */
interface Reachable {
  element: HTMLElement;
  rect: DOMRect;
}

/** An ancestor that cuts its contents off, and the directions it scrolls in instead. */
interface Clip {
  rect: DOMRect;
  scrollsX: boolean;
  scrollsY: boolean;
  clientWidth: number;
  clientHeight: number;
}

/**
 * Where focus was, in terms that outlive the element it was on.
 *
 * `key` is the item; `within` is which control inside it, since a card holds a
 * star and a guide button as well as itself; `rect` is where it was on screen,
 * which is the fallback for an item that has genuinely gone -- landing back
 * where you were looking beats landing at the top of the list.
 */
interface RememberedFocus {
  key: string | null;
  within: number;
  rect: DOMRect;
}

/** `within` for the keyed element itself rather than a control inside it. */
const THE_ITEM_ITSELF = -1;

/**
 * Moving focus with a remote control.
 *
 * A WebView has no spatial navigation. Tab order exists, but a remote has no
 * Tab -- it has four arrows, and nothing in the platform turns one into the
 * other. So the arrows are read here and focus is moved by geometry: of
 * everything reachable that lies in the direction pressed, take the nearest,
 * preferring what is straight ahead.
 *
 * Only ever active on a device. In a browser the arrow keys scroll the page and
 * that is what a person expects them to do; taking them over there would fix
 * nothing and break something.
 */
@Injectable({ providedIn: 'root' })
export class TvNavigationService {
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Set from a move until the frame after it has been drawn.
   *
   * A held D-pad button repeats about every 33 ms, and a move in the guide
   * took about 100 -- measured on the TV emulator, 22 September -- so the
   * repeats queued up behind each other: a second of holding Down took three
   * and a half to work through, with the screen frozen in between, and the
   * list went on moving after the button was let go. A repeat that arrives
   * while the last move is still being drawn is dropped rather than queued,
   * so focus moves as fast as the set can draw it and stops when the button
   * does.
   */
  private moving = false;

  /** Which key is being held, and since when: what the guide speeds up by. */
  private heldKey = '';
  private heldSince = 0;

  /** When focus last moved, for the steady pace at the start of a hold. */
  private lastMoveAt = 0;

  /**
   * Whether to present this as a television.
   *
   * Decided by what the user does, not by what the device claims to be. The
   * first press of a direction key turns it on, and nothing turns it off.
   *
   * The previous attempt asked `navigator.maxTouchPoints === 0`, on the
   * reasoning that a television has no touchscreen. An Android TV emulator
   * reports seven `virtio_input_multi_touch` devices, so that was simply
   * wrong -- and every other device signal is a guess of the same kind, since a
   * TV box and a tablet are the same operating system on the same hardware.
   *
   * Watching for the input instead cannot misidentify anything: a D-pad press
   * is proof that something is being driven by a D-pad. A phone never sends
   * one, and a browser never gets this far.
   */
  readonly isTelevision = signal(false);

  /**
   * CSS pixels per pixel of the TV design, once this is a television.
   *
   * The stylesheet scales everything under `.tv` from the viewport (see "The
   * television scale" in styles.css), but a few sizes live in code rather than
   * in CSS -- a virtual scroller places its rows arithmetically from a pixel
   * number, and has to be handed the same scale or its rows overlap. The
   * category sidebar did exactly that: sixty CSS pixels reserved for rows that
   * drew taller. Read back from the root font size rather than recomputed, so
   * the two cannot disagree.
   */
  readonly designPixel = signal(1);

  /** A length from the TV boards, in CSS pixels for this device. */
  designPx(pixels: number): number {
    return Math.round(pixels * this.designPixel());
  }

  private installed = false;

  /** Where focus was last, in terms that outlive the element it was on. */
  private remembered: RememberedFocus | null = null;

  /**
   * Starts listening, and marks the document so the stylesheet can react.
   *
   * Called once, from the shell. Safe to call again.
   *
   * Android only. The desktop app is a native platform too, and it used to
   * pass here: the first arrow key pressed on a keyboard turned the whole
   * window into the television layout, with no way back short of restarting
   * (26 September). A keyboard and a mouse have the browser's own
   * focus and scrolling, which is what they expect.
   */
  install(): void {
    if (this.installed || Capacitor.getPlatform() !== 'android') {
      return;
    }
    this.installed = true;

    // Plain listeners: nothing these do needs Angular to look at the screen
    // -- focus and scrolling are the browser's, and the one signal set here
    // schedules its own check. (They were kept out of zone.js for that
    // reason until the app went without it.)
    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keydown', this.keepSelectsStill);
    document.addEventListener('focusin', this.onFocusIn, true);
    // Passive and in the capture phase, because a virtual scroller scrolls
    // its own element rather than the page. This is the moment a row is
    // recycled, so it is the moment to notice that focus went with it.
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });

    this.destroyRef.onDestroy(() => {
      document.removeEventListener('keydown', this.onKeyDown, true);
      window.removeEventListener('keydown', this.keepSelectsStill);
      document.removeEventListener('focusin', this.onFocusIn, true);
      document.removeEventListener('scroll', this.onScroll, true);
    });

    void this.startAsTelevisionIfAndroidSaysSo();
  }

  /**
   * The television presentation from the first frame, when Android says so.
   *
   * Waiting for a D-pad press meant a television opened on the desktop layout
   * with nothing focused, and the first press went to the logo in the corner.
   * Now the platform is asked, and the first thing worth watching gets focus as
   * soon as the page has one: a card, a channel, a category -- anything with a
   * focus key, never a text field, which would raise the keyboard over the
   * screen before anybody has pressed anything.
   */
  private async startAsTelevisionIfAndroidSaysSo(): Promise<void> {
    if (!(await platformSaysTelevision())) {
      return;
    }

    this.becomeTelevision();
    this.focusContentWhenReady();
  }

  /**
   * Puts focus on the first thing worth watching, once the screen has one.
   *
   * At launch, and after every change of screen on a television: moving to
   * Guides or Back to the front page left focus on nothing, and a D-pad with
   * nothing focused has nowhere to move from -- the first press did nothing
   * visible. Only when focus really is on nothing, so a screen that places
   * focus itself (a dialog, the guide returning to a channel) keeps its
   * choice. A card, a channel or a category, and failing those the first
   * control in the page -- never a text field, which raises the keyboard.
   */
  focusContentWhenReady(): void {
    if (!this.isTelevision()) {
      return;
    }

    const startedAt = Date.now();
    const giveUpAt = startedAt + FIRST_FOCUS_WAIT_MS;
    const tryFocus = () => {
      if (document.activeElement && document.activeElement !== document.body) {
        return;
      }
      const settle = Date.now() - startedAt > FALLBACK_AFTER_MS;
      // The first one that is on screen, not merely the first in the document:
      // the Back button every page carries is hidden on a television, it came
      // first, and focusing a hidden button does nothing -- so Guides, Account
      // and Search opened with nothing focused, found by the QA walk.
      const shown = (selector: string) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
          element => element.offsetParent !== null
        ) ?? null;
      const first =
        shown(`main [${FOCUS_KEY}]`) ??
        (settle ? shown('main a[href]:not([tabindex="-1"]), main button:not([disabled])') : null);
      if (first) {
        first.focus({ preventScroll: true });
        if (document.activeElement === first) {
          return;
        }
      }
      if (Date.now() < giveUpAt) {
        setTimeout(tryFocus, 250);
      }
    };
    tryFocus();
  }

  /**
   * Puts focus back on a named item, if it is still on screen.
   *
   * By key rather than by element, for the reason `FOCUS_KEY` exists at all: a
   * virtual scroller recycles the element, so anything holding one is holding a
   * row that has become some other row. The drawer closing is the caller --
   * Right has to give focus back to the exact programme it was taken from, and
   * `land` rather than a bare `focus` so the scrolling that goes with it is the
   * same as every other move.
   */
  focusItem(key: string | null): boolean {
    if (!key) {
      return false;
    }

    const holder = this.reachable()
      .map(candidate => candidate.element.closest<HTMLElement>(`[${FOCUS_KEY}]`))
      .find(found => found?.getAttribute(FOCUS_KEY) === key);

    if (!holder) {
      return false;
    }

    this.land(holder);
    return true;
  }

  /**
   * Notes where focus is, every time it lands anywhere.
   *
   * Not only on the moves made here: focus also arrives by click, by a dialog
   * opening, and by Angular restoring it. Whatever put it there, this is what
   * makes it findable again.
   */
  private readonly onFocusIn = (event: FocusEvent): void => {
    const element = event.target as HTMLElement | null;
    if (!element || element === document.body || !element.getBoundingClientRect) {
      return;
    }

    const holder = element.closest<HTMLElement>(`[${FOCUS_KEY}]`);
    const inside = holder ? Array.from(holder.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];

    this.remembered = {
      key: holder ? holder.getAttribute(FOCUS_KEY) : null,
      within: holder === element ? THE_ITEM_ITSELF : inside.indexOf(element),
      rect: element.getBoundingClientRect()
    };
  };

  /**
   * Puts focus back when a scroll has just taken it away.
   *
   * This is the whole of the recycling fault. The row being stood on leaves
   * the rendered range, its view is detached, and focus falls to `body` --
   * measured in the app's own WebView, not assumed.
   *
   * A scroll rather than `focusout`, which does also fire there and was the
   * obvious hook. The difference is what each one means. `focusout` says focus
   * was lost, and focus is lost deliberately all the time -- a dialog closing,
   * a screen being replaced -- so acting on it means taking focus back at
   * moments the app meant to let it go. A scroll says the list moved
   * underneath somebody, which is the one case where nobody chose this and
   * nobody is served by it.
   *
   * Only once a D-pad has been seen. On a phone, focus resting on `body` after
   * a scroll is ordinary, and taking it back would raise the keyboard.
   */
  private readonly onScroll = (): void => {
    if (!this.isTelevision() || !this.lostFocus()) {
      return;
    }
    this.restoreFocus();
  };

  private lostFocus(): boolean {
    const active = document.activeElement;
    return !active || active === document.body;
  }

  /**
   * The last word on an arrow pressed on a select: it does not change it.
   *
   * On the window and in the bubbling phase, so it runs after everything else
   * has had the press. A press that moved focus, or that the navigation or a
   * panel answered, is prevented already and passes by. One that nobody
   * wanted -- the top of the page, or Right with nothing to the right --
   * would otherwise fall through to the select, which in Android's WebView
   * picks the next option and saves it. The QA walk found Right on Account's
   * audio language doing exactly that after Up and Down had been fixed.
   */
  private readonly keepSelectsStill = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!event.defaultPrevented && target?.tagName === 'SELECT' && DIRECTIONS[event.key] && this.isTelevision()) {
      event.preventDefault();
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const active = document.activeElement as HTMLElement | null;

    // Enter on a search box that is being held back: this is the press that
    // asks for the keyboard. See `holdBackKeyboard`.
    if (event.key === 'Enter' && this.isHeldBack(active)) {
      event.preventDefault();
      this.letTheKeyboardIn(active as HTMLElement);
      return;
    }

    const direction = DIRECTIONS[event.key];
    if (!direction) {
      return;
    }

    // Proof that a D-pad is in the room. Done before anything else, so the
    // focus ring is already styled when the first press puts focus somewhere --
    // otherwise the very first move is the one nobody can see.
    this.becomeTelevision();

    if (this.wantsItsOwnArrows(active, direction)) {
      return;
    }

    // A new press starts the clock that holding speeds up by.
    if (!event.repeat || event.key !== this.heldKey) {
      this.heldKey = event.key;
      this.heldSince = performance.now();
    }

    // A held button's repeats, while the last move has not been drawn yet.
    // Prevented so nothing else acts on them either -- the page would
    // otherwise scroll by itself underneath a focus that stays put.
    if (event.repeat && this.moving) {
      event.preventDefault();
      return;
    }

    // A dialog has opened and focus is still out on the page behind it. Bring
    // it inside rather than moving it: the first press after something opens
    // should arrive at the thing that opened, not shuffle around underneath it.
    const scope = this.scope();
    if (scope && (!active || !scope.contains(active))) {
      const first = this.reachable()[0];
      if (first) {
        event.preventDefault();
        this.land(first.element);
      }
      return;
    }

    // Focus has been lost -- a recycled row, or a screen that has just been
    // replaced. Put it back where it was and stop there, rather than moving
    // from a place the person cannot see. The same rule as a dialog opening:
    // the first press after something has happened arrives, and the second
    // one moves.
    //
    // Belt and braces with the scroll hook above. That one is what makes the
    // ring reappear without a press at all; this one is what guarantees a
    // press is never answered by a jump to the top of the list, whatever the
    // browser did or did not tell us.
    if (this.lostFocus()) {
      const somewhere = this.restoreFocus() ? true : this.startSomewhere();
      if (somewhere) {
        event.preventDefault();
      }
      return;
    }

    let next = this.namedFrom(active as HTMLElement, direction) ?? this.nearestFrom(active as HTMLElement, direction);

    // The first seconds of a hold in the guide, at a steady pace rather than as
    // fast as the set can draw. On a quick device that was forty rows a second
    // from the first repeat -- past the channel wanted before a thumb could
    // let go, and nothing like the slow-then-fast of TiviMate, which is what
    // a user holds a remote expecting (24 September).
    if (this.pacedStart(event, direction, active as HTMLElement)) {
      event.preventDefault();
      return;
    }

    // Held long enough in the guide, a step is more than one row: the moves
    // are drawn as fast as the set can already, so going faster means going
    // further per move. Only between channel rows, so a long hold stops at the
    // first or last channel rather than carrying on into the toolbar.
    const rows = this.rowsPerStep(event, direction, active as HTMLElement);
    for (let step = 1; next && step < rows; step++) {
      const further = this.nearestFrom(next, direction);
      if (!further?.closest(GUIDE_ROW)) {
        break;
      }
      next = further;
    }

    if (!next) {
      // The end of a guide row is a wall, not an edge to scroll past: the
      // lane would otherwise scroll sideways under a focus that stays put.
      if (this.laneOf(active as HTMLElement) && (direction === 'left' || direction === 'right')) {
        event.preventDefault();
      }
      return;
    }

    // Only now, once there is somewhere to go. Swallowing the key when there
    // is not would stop the page scrolling at the end of a list.
    event.preventDefault();
    this.land(next, direction);
  };

  /**
   * Focus something, and do the scrolling that goes with it ourselves.
   *
   * `preventScroll` is the whole of this, and it was arrived at backwards.
   * `focus()` scrolls by itself, and the `scrollIntoView` below it had
   * therefore never once run to any effect -- the browser had already moved
   * the list before it was asked to.
   *
   * What the browser does is scroll nothing at all while the next row is
   * visible and then centre it the moment it is not. Measured in the app's own
   * WebView, walking down a list of 100px rows, that is 0, 0, 0, 250, 0, 50,
   * 250 pixels per press: a list that sits still and then lurches half a
   * screen, twice, for presses that are all the same press.
   *
   * Taking it over gives 0, 0, 40, 100, 100, 100, 100 -- one row per press,
   * every press, which is what "smooth" means on a device where every press
   * costs a reach for the remote. The 40 is the `scroll-padding` the
   * stylesheet puts on scrolling containers under `.tv`, which is what keeps a
   * strip of the next row showing so there is some evidence the list goes on.
   */
  private land(element: HTMLElement, direction?: Direction): void {
    this.holdBackKeyboard(element);
    element.focus({ preventScroll: true });
    // Something stuck to the left edge -- a channel's name in the guide -- is
    // in view wherever its row is scrolled, but scrolling it into view moved
    // the row sideways anyway, by the scroll padding, on every press: down a
    // guide opened at the current hour, each row walked an hour further into
    // the past. Only up and down for those.
    //
    // And a programme reached by Up or Down: it was chosen for the part of
    // it that shows, but scrolling the whole of it into view took the lanes
    // back to where it started -- three presses down an evening guide and it
    // showed the afternoon, every programme restyled at each step (the
    // performance audit, 10 October). Left and Right still move through time.
    const vertical = direction === 'up' || direction === 'down';
    const pinned = stuckSideways(element) ?? (vertical && this.laneOf(element) ? sidewaysScroller(element) : null);
    const keepLeft = pinned?.scrollLeft ?? 0;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (pinned && pinned.scrollLeft !== keepLeft) {
      pinned.scrollLeft = keepLeft;
    }
    outFromUnderTheNames(element);
    // scrollIntoView shows the whole of a programme, and one that began
    // before the current hour took the lanes back past it: no further than
    // where the guide opened (GUIDE_LEFTMOST).
    const lanes = this.laneOf(element)?.closest<HTMLElement>('cdk-virtual-scroll-viewport');
    const leftmost = Number(lanes?.getAttribute(GUIDE_LEFTMOST) ?? 0) || 0;
    if (lanes && lanes.scrollLeft < leftmost) {
      lanes.scrollLeft = leftmost;
    }

    // Clear once the move has been drawn: the next frame, and the one after
    // it, which is the first that starts after the paint.
    this.moving = true;
    this.lastMoveAt = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => (this.moving = false)));
  }

  /**
   * A search box that is passed over must not summon the on-screen keyboard.
   *
   * Photographed on the television, walking down the category browser: focus
   * reached "Filter these results" and Android's keyboard came up over the
   * bottom two thirds of the screen, covering the list that was being walked
   * through. Nothing had been typed and nothing was going to be -- the field
   * was simply in the way between the top of the page and the grid.
   *
   * `readonly` is what does it, and the choice was measured rather than
   * reasoned. Three ways of holding the keyboard back were tried on the
   * emulator, with a field focused and OK pressed:
   *
   * - nothing: the keyboard comes up the moment focus arrives. The defect.
   * - `inputmode="none"`: no keyboard -- and OK never reaches the page at all.
   *   The WebView swallows it as "open the editor" and then has no editor to
   *   open, so the field can be walked onto and never typed in. Worse than the
   *   fault it fixes.
   * - `readonly`: no keyboard on focus, and OK arrives as an ordinary `Enter`.
   *
   * So the field is read-only until somebody asks for it, and asking is the
   * press of OK that would otherwise have been swallowed.
   *
   * Set here, on the way in, rather than in every template that has a field in
   * it: this is a property of being driven by a remote, not of any one screen.
   */
  /**
   * Focus put somewhere by a screen rather than by a press, as a press would
   * put it: a field held back from the keyboard until OK. Focused plainly, the
   * first launch's provider step raised Android's keyboard over itself as it
   * opened, and the next OK typed into it.
   */
  focusAsIfMoved(element: HTMLElement): void {
    this.holdBackKeyboard(element);
    element.focus({ preventScroll: true });
  }

  private holdBackKeyboard(element: HTMLElement): void {
    // Only a field that was open for typing, and marked as held back by this,
    // so that OK knows which read-only fields are its to open. A field that is
    // read-only in its own right stays that way: the position boxes in
    // Arrange are, because the keypad beside them types into them, and OK used
    // to open them and raise Android's keyboard over the list instead (the
    // owner, 22 September).
    if (this.takesTyping(element) && !(element as HTMLInputElement).readOnly) {
      (element as HTMLInputElement).readOnly = true;
      element.setAttribute(HELD_BACK, '');
    }
  }

  private letTheKeyboardIn(element: HTMLElement): void {
    element.removeAttribute(HELD_BACK);
    (element as HTMLInputElement).readOnly = false;

    // Focus is already here, and whether to raise the keyboard is decided at
    // the moment a field takes focus -- so it has to be given up and taken
    // again for the platform to look at the field afresh.
    element.blur();
    element.focus({ preventScroll: true });
  }

  private isHeldBack(element: HTMLElement | null): boolean {
    return !!element && this.takesTyping(element) && element.hasAttribute(HELD_BACK);
  }

  /** A field somebody types into, as opposed to a checkbox or a button. */
  private takesTyping(element: HTMLElement): boolean {
    if (element.tagName === 'TEXTAREA') {
      return true;
    }
    if (element.tagName !== 'INPUT') {
      return false;
    }

    const type = (element as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
  }

  /** Turns on the television presentation, once, on the first D-pad press. */
  private becomeTelevision(): void {
    if (this.isTelevision()) {
      return;
    }
    document.documentElement.classList.add('tv');
    this.measureDesignPixel();
    // Before `isTelevision`, so anything computed from both sees the new scale.
    this.isTelevision.set(true);
    window.addEventListener('resize', this.measureDesignPixel);
  }

  /**
   * Reads the scale again after something changed it other than the window --
   * the display size setting (DisplaySizeService), which moves the root font
   * size that every row height here is worked out from.
   */
  remeasure(): void {
    if (this.isTelevision()) {
      this.measureDesignPixel();
    }
  }

  private readonly measureDesignPixel = (): void => {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    if (root > 0) {
      this.designPixel.set(root / 16);
    }
  };

  /**
   * Whether the focused control means to use this arrow itself.
   *
   * Left and right inside a text field move the caret. Stealing those would
   * make the field unusable to the only input device the room has.
   *
   * Not a select, though it used to be. In Android's WebView up and down on a
   * focused select change its value on the spot, with no list on screen -- so
   * on Account a remote walking down the page landed on the subtitle language,
   * and every further press silently picked the next language and saved it to
   * the account, with no way off the select but Left. OK opens Android's own
   * picker, which is how a remote chooses; the arrows move on, like everywhere
   * else. Found by the QA walk (tools/qa/tv-walk.js), which did it too.
   */
  private wantsItsOwnArrows(element: HTMLElement | null, direction: Direction): boolean {
    if (!element) {
      return false;
    }

    const tag = element.tagName;

    if (element.isContentEditable) {
      return true;
    }
    if (tag === 'TEXTAREA') {
      return true;
    }
    if (tag === 'INPUT') {
      // A field being held back has no caret to move: it is read-only until
      // somebody presses OK on it (see `holdBackKeyboard`), so claiming left
      // and right for it only makes the controls beside it unreachable. The
      // filter in the category panel sits next to Arrange, and Right on it did
      // nothing a remote could see -- worse, the press fell through to the
      // panel, which read it as "nothing to my right" and closed.
      if ((element as HTMLInputElement).readOnly) {
        return false;
      }
      const type = (element as HTMLInputElement).type;
      const textual = !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
      return textual && (direction === 'left' || direction === 'right');
    }
    // A focused player takes left and right for seeking.
    if (tag === 'VIDEO') {
      return direction === 'left' || direction === 'right';
    }

    return false;
  }

  /**
   * Where a control says a direction goes, when nearest is not it:
   * `data-tv-down`, `data-tv-right` and so on, a selector. Search's field is as
   * wide as the page, so the chip under its middle was nearer than the one
   * chosen at its left (round 11); Account's menu sits higher than the first
   * row of its section, so Right from it found nothing level with it
   * (round 14). The first match that is on screen; nothing, when none is, and
   * nearest decides as ever.
   */
  private namedFrom(from: HTMLElement, direction: Direction): HTMLElement | null {
    const named = from.getAttribute(`data-tv-${direction}`);
    if (!named) {
      return null;
    }
    for (const target of Array.from(document.querySelectorAll<HTMLElement>(named))) {
      const box = target.getBoundingClientRect();
      if (box.width || box.height) {
        return target;
      }
    }
    return null;
  }

  /**
   * The nearest reachable thing in the given direction.
   *
   * Measured from the centre of each edge rather than from the middle of the
   * box, so a wide row and a narrow button next to it compare sensibly.
   */
  private nearestFrom(from: HTMLElement, direction: Direction): HTMLElement | null {
    const origin = shownBesideTheNames(from, from.getBoundingClientRect());
    const could = this.couldWin(origin, from, direction);

    // Right from a channel's name in the guide: what is on now, not the first
    // programme past the names -- which, with the guide reaching back into
    // catch-up, is one that has finished.
    const guideRow = from.closest<HTMLElement>(GUIDE_ROW);
    if (direction === 'right' && guideRow && !this.laneOf(from)) {
      const onAir = guideRow.querySelector<HTMLElement>('[data-tv-guide-lane] [data-on-air]');
      if (onAir) {
        return onAir;
      }
    }

    // Left from a channel's name: out of the guide, to the categories. The
    // programmes scrolled under the names lie to its left as far as their
    // boxes go, and Left chose a finished one there, hours back, rather
    // than open the drawer.
    if (direction === 'left' && guideRow && !this.laneOf(from)) {
      return this.nearestAmong(origin, from, direction, besideTheNames(this.reachable(undefined, could)));
    }

    // Left along a lane: only what shows beside the names. The hours before
    // the one the guide opened at lie under them, and a remote is not taken
    // there (GUIDE_LEFTMOST) -- past the first programme in view, Left goes
    // to the channel's name, to play it (21 October).
    if (direction === 'left' && this.laneOf(from)) {
      return this.nearestAmong(origin, from, direction, besideTheNames(this.reachable(undefined, could)));
    }

    // Up and Down in the guide: the rows either side, not the whole guide.
    // Every channel's row is drawn, so measuring everything reachable meant
    // every programme block in the category -- 476 on the emulator, each a
    // forced layout -- to pick one that is always in the next row. When the
    // neighbours have nothing (the first row, going up to the toolbar), the
    // whole screen is asked as before.
    const row = direction === 'up' || direction === 'down' ? from.closest<HTMLElement>(GUIDE_ROW) : null;
    if (row) {
      const near = this.nearestAmong(origin, from, direction, besideTheNames(this.reachable(this.neighbourRows(row, direction), could)));
      if (near) {
        return near;
      }
    }

    return this.nearestAmong(origin, from, direction, this.reachable(undefined, could));
  }

  /**
   * A first, cheap test of a candidate's own box: could it possibly be what
   * `nearestAmong` picks?
   *
   * Every press used to measure every control on the page with its clipping
   * ancestors and computed style -- about 20 ms a press on a television, to
   * throw most of them away. What shows of a control always lies within its
   * own box, so a box that lies wholly behind the press, or wholly outside
   * the row a sideways press keeps to, cannot win however it is clipped, and
   * needs no more measuring. Only the rest are measured as before.
   *
   * Loose on purpose: anything that might win is kept. It decides only what
   * is measured, never what is chosen.
   */
  private couldWin(origin: DOMRect, from: HTMLElement, direction: Direction): (own: DOMRect) => boolean {
    const ox = origin.left + origin.width / 2;
    const oy = origin.top + origin.height / 2;
    const ahead =
      direction === 'right'
        ? (own: DOMRect) => own.right > ox
        : direction === 'left'
          ? (own: DOMRect) => own.left < ox
          : direction === 'down'
            ? (own: DOMRect) => own.bottom > oy
            : (own: DOMRect) => own.top < oy;
    if (direction === 'up' || direction === 'down') {
      return ahead;
    }
    // Sideways keeps to the row: the guide lane's band when in one, else
    // whatever shares some height with the focused control (nearestAmong).
    const lane = this.laneOf(from);
    const band = lane ? lane.getBoundingClientRect() : origin;
    return own => ahead(own) && own.bottom >= band.top && own.top <= band.bottom;
  }

  /**
   * How many rows a held Up or Down moves per step in the guide.
   *
   * As TiviMate does it, which is what a user holds a remote expecting: one
   * row at a time for the first couple of seconds, so a short hold stays
   * precise, and faster once it is clearly a long way (22 September).
   */
  private rowsPerStep(event: KeyboardEvent, direction: Direction, from: HTMLElement): number {
    if (!event.repeat || (direction !== 'up' && direction !== 'down') || !from.closest(GUIDE_ROW)) {
      return 1;
    }
    const held = performance.now() - this.heldSince;
    return held < HOLD_FASTER_AFTER_MS ? 1 : held < HOLD_FASTEST_AFTER_MS ? 2 : 4;
  }

  /** A repeat that comes too soon in the steady first seconds of a hold in the guide. */
  private pacedStart(event: KeyboardEvent, direction: Direction, from: HTMLElement): boolean {
    if (!event.repeat || (direction !== 'up' && direction !== 'down') || !from.closest(GUIDE_ROW)) {
      return false;
    }
    const now = performance.now();
    return now - this.heldSince < HOLD_FASTER_AFTER_MS && now - this.lastMoveAt < STEADY_STEP_MS;
  }

  /** The next few guide rows in a direction, nearest first. */
  private neighbourRows(row: HTMLElement, direction: Direction): HTMLElement[] {
    const rows: HTMLElement[] = [];
    let next: Element | null = row;
    while (rows.length < NEIGHBOUR_ROWS) {
      next = direction === 'down' ? next.nextElementSibling : next.previousElementSibling;
      if (!next) {
        break;
      }
      if (next.matches(GUIDE_ROW)) {
        rows.push(next as HTMLElement);
      }
    }
    return rows;
  }

  private nearestAmong(
    origin: DOMRect,
    from: HTMLElement,
    direction: Direction,
    reachable: Reachable[]
  ): HTMLElement | null {
    // Sideways, the controls sitting on a card are held back: pressing right
    // along a rail must reach the next card, not step into the delete button of
    // the one you are on. They are considered only if there is nothing beside
    // the card at all, which is the end of a row.
    //
    // Vertically they compete normally, and that is how they are reached. The
    // stylesheet drops them to the bottom of their card on a television, so
    // down from a card finds its own controls -- nearer than the row below --
    // and down again carries on to that row. Without this the star and the
    // guide button could be seen and never focused: in a grid there is always
    // a neighbouring card, so a held-back candidate never won.
    const sideways = direction === 'left' || direction === 'right';

    const outside: Reachable[] = [];
    const overlapping: Reachable[] = [];

    // Along a guide row, only that row. Rows end at different places, so at
    // the end of one the nearest thing "to the right" was whatever block
    // reached furthest in some other row -- on the emulator, Right at the end
    // of HR| HRT 4 put focus on a sliver at the far edge of ZDRAVA TV, rows
    // away. What counts as the row is everything level with the lane, which
    // includes its channel cell, so Left from the first programme still goes
    // back to the channel.
    const lane = sideways ? this.laneOf(from) : null;
    const band = lane?.getBoundingClientRect();

    for (const candidate of reachable) {
      if (candidate.element === from) {
        continue;
      }
      if (band) {
        const middle = candidate.rect.top + candidate.rect.height / 2;
        if (middle < band.top || middle > band.bottom) {
          continue;
        }
      } else if (sideways && (candidate.rect.bottom <= origin.top || candidate.rect.top >= origin.bottom)) {
        // "Left/Right never changes row" (FY-TV, S-1). Beyond the guide, the
        // row is whatever shares some height with the thing focused. Without
        // this, Left from the first film on For You climbed to the channel
        // above it instead of opening the navigation, and Right from the
        // search box on Live TV went down and back to a category. With nothing
        // level with it, the press goes unanswered -- which is what lets Left
        // open the navigation and makes Right at the end of a row stay put.
        continue;
      }
      const overlaps = sideways && this.overlaps(origin, candidate.rect);
      (overlaps ? overlapping : outside).push(candidate);
    }

    return this.best(origin, outside, direction) ?? this.best(origin, overlapping, direction);
  }

  /** The guide row an element is a programme in, if it is one. */
  private laneOf(element: HTMLElement): HTMLElement | null {
    return element.closest<HTMLElement>('[data-tv-guide-lane]');
  }

  private best(
    origin: DOMRect,
    candidates: Reachable[],
    direction: Direction
  ): HTMLElement | null {
    let best: HTMLElement | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const { element, rect } of candidates) {
      const advance = this.advance(origin, rect, direction);
      if (advance <= 0) {
        continue;
      }

      // The centre distance, weighted lightly, only settles ties between
      // candidates the gap measure cannot tell apart: every programme in the
      // next lane that overlaps the one being left is "on the line", and the
      // one underneath the middle of it is the one meant.
      const score =
        advance +
        this.drift(origin, rect, direction) * DRIFT_PENALTY +
        this.centreOffset(origin, rect, direction) * CENTRE_TIEBREAK;
      if (score < bestScore) {
        bestScore = score;
        best = element;
      }
    }

    return best;
  }

  private overlaps(a: DOMRect, b: DOMRect): boolean {
    return !(b.right <= a.left || b.left >= a.right || b.bottom <= a.top || b.top >= a.bottom);
  }

  /**
   * How far the candidate lies in the direction pressed. Zero or less means it
   * does not.
   *
   * Measured edge to edge, except for something sitting on top of the focused
   * element, where every edge distance is negative and nothing would ever be
   * reachable. Those are measured centre to centre instead, which is what makes
   * a cross in the corner of a card reachable from the card.
   */
  private advance(origin: DOMRect, rect: DOMRect, direction: Direction): number {
    if (this.overlaps(origin, rect)) {
      const ox = origin.left + origin.width / 2;
      const oy = origin.top + origin.height / 2;
      const rx = rect.left + rect.width / 2;
      const ry = rect.top + rect.height / 2;

      switch (direction) {
        case 'up':
          return oy - ry;
        case 'down':
          return ry - oy;
        case 'left':
          return ox - rx;
        case 'right':
          return rx - ox;
      }
    }

    switch (direction) {
      case 'up':
        return origin.top - rect.bottom + 1;
      case 'down':
        return rect.top - origin.bottom + 1;
      case 'left':
        return origin.left - rect.right + 1;
      case 'right':
        return rect.left - origin.right + 1;
    }
  }

  /**
   * How far off the straight line the candidate sits: the gap between the two
   * boxes across the direction of travel, and nothing at all if they overlap.
   *
   * It used to be the distance between their centres, which is only a fair
   * measure between things of one width. Channel names in the guide are
   * buttons as wide as their text, all starting at the same left edge -- so a
   * long name directly below was "further off the line" than a short one two
   * rows down, and Down skipped channels. HR| HRT 4 to HR| RTL 1, stepping over
   * HR| HRT INTERNATIONAL, on the TV emulator.
   */
  private drift(origin: DOMRect, rect: DOMRect, direction: Direction): number {
    const vertical = direction === 'up' || direction === 'down';
    const [aStart, aEnd] = vertical ? [origin.left, origin.right] : [origin.top, origin.bottom];
    const [bStart, bEnd] = vertical ? [rect.left, rect.right] : [rect.top, rect.bottom];
    return Math.max(0, bStart - aEnd, aStart - bEnd);
  }

  /** Distance between the two centres across the direction of travel. */
  private centreOffset(origin: DOMRect, rect: DOMRect, direction: Direction): number {
    const vertical = direction === 'up' || direction === 'down';
    const a = vertical ? origin.left + origin.width / 2 : origin.top + origin.height / 2;
    const b = vertical ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    return Math.abs(a - b);
  }

  /**
   * The innermost open dialog, if there is one.
   *
   * While one is open it is the only thing that can be reached. Without this
   * the arrows wander off into the page behind: a stream would start playing
   * and the next press would move focus to a channel card underneath the
   * player, leaving the player's own controls unreachable.
   */
  private scope(): HTMLElement | null {
    const scopes = document.querySelectorAll<HTMLElement>('[data-focus-scope]');
    return scopes.length > 0 ? scopes[scopes.length - 1] : null;
  }

  /**
   * Everything focusable that is actually on screen, inside the current scope.
   *
   * The size check matters more than it looks: a virtual scroller keeps
   * recycled rows in the DOM with no dimensions, and a closed dialog leaves its
   * buttons behind.
   *
   * The transparency check is what stops a control you cannot see from taking
   * focus. The remove and unstar buttons sit at opacity zero until their card
   * is hovered or focused, and they still have width and height -- so pressing
   * Down into a rail would put focus on an invisible cross while the card
   * around it lit up, and Enter would delete the entry the user thought they
   * were opening. Since focusing the card is what reveals them, they become
   * reachable exactly when they become visible.
   */
  private reachable(within?: HTMLElement[], could?: (own: DOMRect) => boolean): Reachable[] {
    const roots: ParentNode[] = within ?? [this.scope() ?? document];
    const found: Reachable[] = [];

    // Every rect is taken here and carried, rather than asked for again by
    // whoever compares them. Each call is a forced layout, and a grid of cards
    // holds three focusable things apiece -- measuring the same hundred
    // elements twice per press is the sort of cost a television notices and a
    // desktop never does.
    const clips = new Map<Element, Clip | null>();

    for (const element of roots.flatMap(root => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)))) {
      // Not rendered at all: nothing to measure.
      if (element.offsetParent === null) {
        continue;
      }
      const own = element.getBoundingClientRect();
      // Ruled out by its own box before anything costlier is asked (couldWin).
      if (could && !could(own)) {
        continue;
      }
      const rect = this.visibleRect(element, clips, own);
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      const style = getComputedStyle(element);
      if (style.visibility !== 'hidden' && Number(style.opacity) > 0.01) {
        found.push({ element, rect });
      }
    }

    return found;
  }

  /**
   * The part of an element its clipping ancestors actually leave showing.
   *
   * A box clipped by `overflow: hidden` still reports its whole rectangle, and
   * the collapsed category sidebar is exactly that: a strip a few pixels wide
   * whose rows go on measuring two hundred, lying invisibly underneath the
   * channel column beside it. Down from a channel then found the category row
   * underneath it nearer than the next channel, and focus disappeared into the
   * hidden list. Seen once the TV scale made the rows closer together than the
   * channels; the rectangles had been wrong all along.
   *
   * Worked out per axis, because a scroller clips too but what it hides along
   * the way it scrolls is what pressing onward is meant to reach -- the row
   * just below the fold. So once an ancestor is found that actually scrolls in
   * a direction, nothing further up clips in that direction: the channel grid
   * sits in an `overflow-y: hidden` wrapper around a vertical scroller, and
   * clipping by that would have left every row below the fold unreachable.
   * The other axis still clips, which is what the sidebar needs: its list
   * scrolls down, and the strip cuts it off sideways.
   *
   * Ancestors are measured once per pass: a grid shares them among a hundred
   * cards.
   */
  private visibleRect(
    element: HTMLElement,
    clips: Map<Element, Clip | null>,
    own: DOMRect = element.getBoundingClientRect()
  ): DOMRect | null {
    let { left, top, right, bottom } = own;
    let freeX = false;
    let freeY = false;

    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      let clip = clips.get(ancestor);
      if (clip === undefined) {
        clip = this.clipOf(ancestor);
        clips.set(ancestor, clip);
      }
      if (!clip) {
        continue;
      }

      // A scroller only brings an element into view along an axis if it is big
      // enough to show it there. The collapsed sidebar squeezes its list to two
      // pixels wide, and 172-pixel rows overflowing that do make it "scroll"
      // sideways -- into a window that could never show one of them.
      const scrollsX = clip.scrollsX && clip.clientWidth >= own.width;
      const scrollsY = clip.scrollsY && clip.clientHeight >= own.height;

      if (!freeX && !scrollsX) {
        left = Math.max(left, clip.rect.left);
        right = Math.min(right, clip.rect.right);
      }
      if (!freeY && !scrollsY) {
        top = Math.max(top, clip.rect.top);
        bottom = Math.min(bottom, clip.rect.bottom);
      }
      if (right <= left || bottom <= top) {
        return null;
      }

      freeX ||= scrollsX;
      freeY ||= scrollsY;
    }

    return new DOMRect(left, top, right - left, bottom - top);
  }

  /** How an ancestor clips its contents, or null if it does not. */
  private clipOf(ancestor: Element): Clip | null {
    const style = getComputedStyle(ancestor);
    // Named values rather than "not visible": an engine that reports nothing
    // at all (jsdom does, for every element) must not read as clipping to a
    // box of no size.
    const clipping = (value: string) => ['hidden', 'clip', 'auto', 'scroll'].includes(value);
    if (!clipping(style.overflowX) && !clipping(style.overflowY)) {
      return null;
    }

    const scrollable = (value: string) => value === 'auto' || value === 'scroll';
    return {
      rect: ancestor.getBoundingClientRect(),
      scrollsX: scrollable(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth,
      scrollsY: scrollable(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight,
      clientWidth: ancestor.clientWidth,
      clientHeight: ancestor.clientHeight
    };
  }

  /**
   * Puts focus back on the item it was on, or as near to it as survives.
   *
   * Three answers, in order of how much of the person's place they keep:
   *
   * 1. **The same control on the same item.** The row was re-rendered and is
   *    back; nothing is lost, and the star of channel 412 is still the star of
   *    channel 412.
   * 2. **The item, if the control inside it has gone** -- an arrange mode left,
   *    say, taking its chevrons with it.
   * 3. **Whatever is nearest to where it was on screen.** The item has really
   *    gone: the category changed underneath, or the list was filtered. Landing
   *    where the eye already is beats landing at the top of the list, which is
   *    what this used to do and what made a lost row feel like being thrown out
   *    of the list altogether.
   */
  private restoreFocus(): boolean {
    const remembered = this.remembered;
    if (!remembered) {
      return false;
    }

    const reachable = this.reachable();
    const target =
      this.rememberedElement(reachable, remembered) ?? this.nearestTo(reachable, remembered.rect);

    if (!target) {
      return false;
    }

    this.land(target);
    return true;
  }

  /** The remembered item, and the remembered control within it. */
  private rememberedElement(
    reachable: Reachable[],
    remembered: RememberedFocus
  ): HTMLElement | null {
    if (!remembered.key) {
      return null;
    }

    // Found by walking up from the candidates already gathered, rather than by
    // asking the document for the key. Two things fall out of that: the id
    // never has to be escaped into a selector -- these are provider ids and a
    // provider may put anything in one -- and a holder outside the current
    // focus scope cannot be reached, since the candidates were scoped.
    const holder = reachable
      .map(candidate => candidate.element.closest<HTMLElement>(`[${FOCUS_KEY}]`))
      .find(found => found?.getAttribute(FOCUS_KEY) === remembered.key);

    if (!holder) {
      return null;
    }

    const visible = new Set(reachable.map(candidate => candidate.element));

    if (remembered.within !== THE_ITEM_ITSELF) {
      const inside = Array.from(holder.querySelectorAll<HTMLElement>(FOCUSABLE));
      // Clamped rather than matched exactly: a row that has lost the two
      // chevrons it had while it was being arranged is still the row somebody
      // was standing on.
      const wanted = inside[Math.min(remembered.within, inside.length - 1)];

      if (wanted && visible.has(wanted)) {
        return wanted;
      }
    }

    return visible.has(holder)
      ? holder
      : (reachable.find(candidate => holder.contains(candidate.element))?.element ?? null);
  }

  /** Whatever reachable thing is closest to a rectangle, by centres. */
  private nearestTo(reachable: Reachable[], rect: DOMRect): HTMLElement | null {
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    let best: HTMLElement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of reachable) {
      const dx = candidate.rect.left + candidate.rect.width / 2 - x;
      const dy = candidate.rect.top + candidate.rect.height / 2 - y;
      const distance = dx * dx + dy * dy;

      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate.element;
      }
    }

    return best;
  }

  /**
   * Somewhere to start, when nothing is focused and nothing is remembered.
   *
   * The first press of the session, and the only case left now that a lost row
   * is restored rather than started over from.
   */
  private startSomewhere(): boolean {
    const onScreen = this.reachable().filter(
      ({ rect }) => rect.bottom > 0 && rect.top < window.innerHeight
    );

    if (onScreen.length === 0) {
      return false;
    }

    this.land(onScreen[0].element);
    return true;
  }
}
