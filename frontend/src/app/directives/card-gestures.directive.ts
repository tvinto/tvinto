import {
  Directive,
  ElementRef,
  HostListener,
  OnDestroy,
  inject,
  output
} from '@angular/core';

/**
 * How long a press has to last to mean "tell me more" rather than "open this".
 *
 * Long enough not to fire on a firm tap or a slow click, short enough that
 * somebody holding the button down on purpose does not wonder whether it is
 * working. The usual figure everywhere else this gesture exists.
 */
const HOLD_MS = 500;

/**
 * A press after this long a quiet is a new one, though no key-up was seen.
 *
 * It was 300 ms, and a television drawing the actions panel is slower than
 * that: the key held under it arrived 229 ms and then 469 ms apart on the TV
 * emulator, the second counted as a new press, and it played the channel
 * whose actions had just opened (28 September).
 */
const MISSED_KEYUP_AFTER_MS = 2000;

/**
 * When the platform made an event, on the page's clock. A browser stamps it so;
 * where the stamp is on some other clock (jsdom's is the epoch), now will do.
 */
function eventTime(event: Event): number {
  const now = performance.now();
  return event.timeStamp > 0 && event.timeStamp <= now + 1000 ? event.timeStamp : now;
}

/**
 * One card, two intentions.
 *
 * A card is the only thing on a television that can be reached without effort,
 * and until now everything you might want to do to a channel had to be its own
 * control on the card: a star, a cross, a guide button. Three targets a
 * centimetre across, arrived at by pressing Down twice and hoping, on a screen
 * being read from the other side of a room -- and each one an element that took
 * focus, which is why a focused card wore rings inside rings.
 *
 * So the card is the only thing to aim at, and holding it asks for the rest.
 * That is the gesture every phone already uses for the same question, it costs
 * no pixels, and it cannot be mis-hit because it is the same target as opening.
 *
 * This is a directive because there are three kinds of card in this app and the
 * mechanics below are fiddly enough that a second copy of them would drift.
 */
@Directive({
  selector: '[appCardGestures]',
  standalone: true
})
export class CardGesturesDirective implements OnDestroy {
  /** Open this: a click, a tap, a press of Enter that was not held. */
  readonly activate = output<void>();

  /** Everything else somebody might want to do to it. */
  readonly menu = output<void>();

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;

  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * A hold has been answered, so whatever follows it is not an opening.
   *
   * A pointer held still sends `click` when it is let go, and a key held still
   * sends `keyup`. Either would otherwise start playing the very thing whose
   * menu had just opened.
   */
  private answered = false;

  /**
   * Enter or Space is down on this card and has not come up.
   *
   * `event.repeat` cannot be trusted for this: Android TV's WebView sends a
   * held OK as the key again and again, none of them marked as a repeat, and
   * each one restarted the wait -- so a hold never came, and letting go opened
   * the card (the guide's "Hold OK for actions", 25 September).
   */
  private keyDown = false;

  /** The listener keeping the rest of a held key from the panel; see swallowUntilLetGo. */
  private swallowing: ((event: KeyboardEvent) => void) | null = null;

  ngOnDestroy(): void {
    this.stopWaiting();
    this.stopSwallowing();
  }

  /**
   * The rest of a held key, wherever focus goes.
   *
   * The panel a hold opens takes focus while OK is still down, and the
   * remote goes on sending it: the next press would have landed on the
   * panel's first action -- Play, on a channel -- and done it. Enter and Space
   * are swallowed until the key comes up, and that too.
   *
   * A key-up always comes, unless focus leaves the app first -- which ends
   * this too. After a long quiet a key-down is taken as a new press whose
   * key-up was missed anyway. The quiet is measured by the events' own times,
   * not by when a busy page got round to them.
   */
  private swallowUntilLetGo(): void {
    this.stopSwallowing();
    let lastAt = performance.now();
    const swallow = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      const at = eventTime(event);
      if (event.type === 'keydown' && at - lastAt > MISSED_KEYUP_AFTER_MS) {
        this.stopSwallowing();
        return;
      }
      lastAt = at;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'keyup') {
        // The card never hears this key come up, so it is finished here.
        this.keyDown = false;
        this.answered = false;
        this.stopSwallowing();
      }
    };
    window.addEventListener('keydown', swallow, true);
    window.addEventListener('keyup', swallow, true);
    window.addEventListener('blur', this.focusLeft);
    this.swallowing = swallow;
  }

  /** The app lost focus with the key down: its key-up will not come here. */
  private readonly focusLeft = (): void => {
    this.keyDown = false;
    this.answered = false;
    this.stopSwallowing();
  };

  private stopSwallowing(): void {
    if (this.swallowing) {
      window.removeEventListener('keydown', this.swallowing, true);
      window.removeEventListener('keyup', this.swallowing, true);
      window.removeEventListener('blur', this.focusLeft);
      this.swallowing = null;
    }
  }

  private startWaiting(): void {
    this.stopWaiting();
    this.answered = false;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.answered = true;
      if (this.keyDown) {
        this.swallowUntilLetGo();
      }
      this.menu.emit();
    }, HOLD_MS);
  }

  private stopWaiting(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // --- Pointer: press and hold, or the other button ------------------------

  @HostListener('pointerdown', ['$event'])
  onPointerDown(event: PointerEvent): void {
    // The primary button only. The right one has its own answer below, and
    // starting a hold on it as well would open the menu twice.
    if (event.button === 0) {
      this.startWaiting();
    }
  }

  @HostListener('pointerup')
  @HostListener('pointercancel')
  @HostListener('pointerleave')
  onPointerEnd(): void {
    this.stopWaiting();
  }

  /**
   * A right-click, which is what this gesture is when there is a mouse.
   *
   * Not gated on being a packaged desktop build: the same app runs in a browser
   * with the same mouse attached, and a menu that appeared in one and not the
   * other would be a difference nobody could explain to themselves.
   */
  @HostListener('contextmenu', ['$event'])
  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    this.stopWaiting();
    this.answered = true;
    this.menu.emit();
  }

  @HostListener('click', ['$event'])
  onClick(event: MouseEvent): void {
    this.stopWaiting();

    if (this.answered) {
      // The tail of a hold, not an opening of its own.
      this.answered = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    this.activate.emit();
  }

  // --- Keys, which is what a remote sends ----------------------------------

  @HostListener('keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // The remote's Menu and Info keys ask the same question as holding OK, in
    // one press and without having to know that a hold means anything. Android
    // sends KEYCODE_MENU as "ContextMenu" and KEYCODE_INFO as "Info"; a PC
    // keyboard's menu key is "ContextMenu" too.
    if ((event.key === 'ContextMenu' || event.key === 'Info') && event.target === this.host) {
      event.preventDefault();
      this.stopWaiting();
      this.menu.emit();
      return;
    }

    if (!this.isOwnActivation(event)) {
      return;
    }

    /*
     * Prevented on both kinds of host, which is what makes holding work at all.
     *
     * Two of these cards are real `<button>`s, and a button's answer to Enter
     * is to fire `click` on the *keydown* -- so a held Enter would have opened
     * the channel instantly and the hold would have had nothing left to answer.
     * Cancelling the default takes activation away from the browser; `keyup`
     * below gives it back. Space is prevented for the same reason, and also
     * because its other default is scrolling the page, which on a grid moves
     * the card out from under the ring that is on it.
     */
    event.preventDefault();

    if (!event.repeat && !this.keyDown) {
      this.keyDown = true;
      this.startWaiting();
    }
  }

  /** Focus moved away mid-press: that press is over, whatever comes up later. */
  @HostListener('blur')
  onBlur(): void {
    this.keyDown = false;
    this.stopWaiting();
  }

  @HostListener('keyup', ['$event'])
  onKeyUp(event: KeyboardEvent): void {
    if (!this.isOwnActivation(event)) {
      return;
    }

    event.preventDefault();
    this.stopWaiting();

    // The key went down somewhere else. OK on the panel's "Add to favourites"
    // chooses it on the way down, the panel closes and hands focus back to
    // the card -- and the same OK coming up here played the channel that had
    // just been starred (29 September).
    if (!this.keyDown) {
      this.answered = false;
      return;
    }
    this.keyDown = false;

    if (this.answered) {
      this.answered = false;
      return;
    }

    this.activate.emit();
  }

  /**
   * Enter or Space, on the card itself.
   *
   * The target check matters on a desktop, where the card still carries a star
   * and a guide button: Enter on the star bubbles up to here, and acting on it
   * would favourite a channel and start playing it in one keystroke.
   */
  private isOwnActivation(event: KeyboardEvent): boolean {
    return (event.key === 'Enter' || event.key === ' ') && event.target === this.host;
  }
}
