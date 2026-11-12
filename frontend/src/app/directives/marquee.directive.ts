import { Directive, ElementRef, OnDestroy, afterNextRender, inject } from '@angular/core';

/**
 * A line too long for its box slides along to show the rest, while the thing
 * it names is focused or pointed at.
 *
 * On a television there is no hovering for the whole name and no tooltip, so an
 * episode called "S1 E3 · The Long, Long Road to Somewhere Nobody Wanted to Go"
 * was "S1 E3 · The Long, Lo…" and that was all anybody could ever read of it
 * (27 September). Only the focused one moves: a row of names all
 * sliding at once would be a row nobody could read either.
 *
 * Put on the clipping element, with the text in one child element:
 * `<span data-marquee appMarquee><span>…</span></span>`. The clipping element
 * keeps its ellipsis while still; the distance to slide is measured each time,
 * since the box changes size with the display size setting. See
 * `[data-marquee]` in styles.css.
 */
@Directive({
  selector: '[appMarquee]',
  standalone: true
})
export class MarqueeDirective implements OnDestroy {
  private readonly box: HTMLElement = inject(ElementRef).nativeElement;

  /** The focusable thing the line belongs to; the line itself when it has none. */
  private trigger: HTMLElement | null = null;

  constructor() {
    afterNextRender(() => {
      this.trigger = this.box.closest<HTMLElement>('button, a, [tabindex]') ?? this.box;
      this.trigger.addEventListener('focus', this.start);
      this.trigger.addEventListener('mouseenter', this.start);
      this.trigger.addEventListener('blur', this.stop);
      this.trigger.addEventListener('mouseleave', this.stop);
    });
  }

  ngOnDestroy(): void {
    this.trigger?.removeEventListener('focus', this.start);
    this.trigger?.removeEventListener('mouseenter', this.start);
    this.trigger?.removeEventListener('blur', this.stop);
    this.trigger?.removeEventListener('mouseleave', this.stop);
  }

  private readonly start = (): void => {
    const hidden = this.box.scrollWidth - this.box.clientWidth;
    if (hidden <= 1) {
      return;
    }
    // Slow enough to read: about 40 px a second, and never under four
    // seconds each way, pauses at either end included (the keyframes).
    this.box.style.setProperty('--marquee-shift', `-${hidden}px`);
    this.box.style.setProperty('--marquee-duration', `${Math.max(4, hidden / 40 + 2)}s`);
    this.box.classList.add('marquee-on');
  };

  private readonly stop = (): void => {
    // Unless it is still focused: the pointer leaving a card the remote is on.
    if (this.trigger && this.trigger === document.activeElement) {
      return;
    }
    this.box.classList.remove('marquee-on');
  };
}
