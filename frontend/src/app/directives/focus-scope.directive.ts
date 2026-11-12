import { Directive, ElementRef, OnDestroy, afterNextRender, inject } from '@angular/core';

/**
 * Everything a remote can reach while this is open, and where it starts.
 *
 * `data-focus-scope` already meant the first half: `TvNavigationService` reads
 * the innermost one and refuses to move focus outside it, which is what stops
 * the arrows wandering off into the page behind a dialog.
 *
 * It did not mean the second half, and that showed. A dialog opened with focus
 * still out on whatever had opened it, so the page behind went on wearing the
 * ring -- the category list lit up under a panel covering half the screen --
 * and the first press of a direction was spent bringing focus in rather than
 * moving it. On a remote a press that appears to do nothing reads as the
 * dialog having ignored you.
 *
 * So the attribute is a directive now, and it does both. Nothing else changes:
 * the same attribute in the same places, and the service still reads it the
 * same way.
 *
 * On every platform, not only a television. Moving focus into a dialog as it
 * opens is what a keyboard expects everywhere, and on a pointer it is
 * invisible -- focus moved by script does not match `:focus-visible`, so
 * nothing is drawn that a mouse user would not have asked for.
 */
@Directive({
  // The attribute the navigation already looks for, so any element marked as a scope is one.
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: '[data-focus-scope]',
  standalone: true
})
export class FocusScopeDirective implements OnDestroy {
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;

  private watching: MutationObserver | null = null;
  private givingUp: ReturnType<typeof setTimeout> | null = null;

  /** What this put focus on, so it can tell that from somewhere else. */
  private placed: HTMLElement | null = null;

  ngOnDestroy(): void {
    this.stopWaiting();
  }

  constructor() {
    // After the next render rather than in `ngAfterViewInit`, because what is
    // being looked for is often behind an `@if` that has not run yet -- a list
    // that arrives with its data, a body that waits on a signal.
    afterNextRender(() => this.enter());
  }

  /**
   * Put focus on the thing somebody came here to use.
   *
   * `data-focus-first` marks it, or marks something holding it: the first
   * focusable inside that. Without the marker this takes the first focusable
   * in the dialog, which is usually the close button in a header -- inside the
   * dialog and visible, so nothing is lost, but worth naming somewhere better
   * when a dialog has one.
   */
  private enter(): void {
    // Never taken from something inside this dialog that has already claimed
    // it: a dialog that focuses its own field on opening should keep it.
    if (this.host.contains(document.activeElement)) {
      return;
    }

    const preferred = this.host.querySelector<HTMLElement>('[data-focus-first]');

    if (preferred && this.focusFirstWithin(preferred, true)) {
      return;
    }

    // Somewhere, now, rather than nowhere until the list arrives: a remote
    // that does nothing is indistinguishable from an app that has hung.
    this.focusFirstWithin(this.host, false);

    if (preferred) {
      this.waitFor(preferred);
    }
  }

  /**
   * The named place was empty, which usually means it is still loading.
   *
   * The guide picker reads every guide on the account before it can list one
   * channel, so it opens saying "Reading the guides…" with nothing focusable
   * in it, and the fallback above lands on the close button in the header --
   * the one control nobody opened the dialog to press, and one press of OK
   * from throwing the dialog away.
   *
   * So it is watched, briefly, and focus moves in when there is something to
   * move to. Never once somebody has moved for themselves: a press made while
   * a list was loading is a decision, and taking focus out from under it would
   * be this code overruling the person holding the remote.
   */
  private waitFor(preferred: HTMLElement): void {
    this.watching = new MutationObserver(() => {
      if (document.activeElement !== this.placed || this.focusFirstWithin(preferred, true)) {
        this.stopWaiting();
      }
    });

    this.watching.observe(preferred, { childList: true, subtree: true });
    this.givingUp = setTimeout(() => this.stopWaiting(), SETTLE_MS);
  }

  private stopWaiting(): void {
    this.watching?.disconnect();
    this.watching = null;

    if (this.givingUp !== null) {
      clearTimeout(this.givingUp);
      this.givingUp = null;
    }
  }

  /**
   * Focus the first thing in here that will take it, and say whether anything
   * did.
   *
   * Asking afterwards rather than working out in advance which controls can be
   * focused: a control that is disabled, hidden, or behind a `display: none`
   * simply refuses, and the browser is the only thing that knows the whole list
   * of reasons. Trying is also the cheaper question -- deciding would mean a
   * measurement of every candidate, and a measurement is a forced layout.
   *
   * A field that takes typing is passed over unless it was named. Focusing
   * one raises the keyboard on a phone: the category sheet opened on its
   * filter, and the keyboard came up over the categories somebody had opened
   * it to tap (a user's phone, 22 September). A dialog that wants its field
   * focused says so with `data-focus-first`.
   */
  private focusFirstWithin(root: HTMLElement, typingAllowed: boolean): boolean {
    const candidates = root.matches(FOCUSABLE)
      ? [root]
      : Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));

    for (const candidate of candidates) {
      if (!typingAllowed && takesTyping(candidate)) {
        continue;
      }
      candidate.focus();
      if (document.activeElement === candidate) {
        this.placed = candidate;
        return true;
      }
    }

    return false;
  }
}

/**
 * The same list `TvNavigationService` uses, and deliberately a copy.
 *
 * Exporting it from the service would make every template that opens a dialog
 * depend on the thing that moves focus around, for a string. If the two ever
 * disagree the cost is a dialog opening on a slightly different control, which
 * is not the kind of fault worth coupling two files to prevent.
 */
/**
 * How long to keep waiting for a list that has not arrived.
 *
 * Long enough for a guide fetch on a television's wifi, short enough that
 * nothing is still watching the DOM by the time somebody has read the dialog
 * and decided what to do with it.
 */
const SETTLE_MS = 5000;

/** A field a keyboard would come up for. */
const takesTyping = (element: HTMLElement): boolean => {
  if (element.tagName === 'TEXTAREA' || element.isContentEditable) {
    return true;
  }
  if (element.tagName !== 'INPUT') {
    return false;
  }
  const input = element as HTMLInputElement;
  return !input.readOnly && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range'].includes(input.type);
};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');
