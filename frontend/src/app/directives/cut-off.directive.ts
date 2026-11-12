import { Directive, ElementRef, OnDestroy, afterNextRender, inject, signal } from '@angular/core';

/**
 * Whether a line-clamped text is cut off where it is drawn, for a "More" to
 * be offered only then: `<p appCutOff #cut="cutOff">`, then `cut.isCut()`.
 *
 * Measured rather than guessed from the length: the same description fits a
 * wide window and is cut on a phone. Measured again whenever the element
 * changes size.
 */
@Directive({
  selector: '[appCutOff]',
  standalone: true,
  exportAs: 'cutOff'
})
export class CutOffDirective implements OnDestroy {
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private observer: ResizeObserver | null = null;

  readonly isCut = signal(false);

  constructor() {
    afterNextRender(() => {
      this.measure();
      if (typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(() => this.measure());
        this.observer.observe(this.host);
      }
    });
  }

  private measure(): void {
    this.isCut.set(this.host.scrollHeight > this.host.clientHeight + 1);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
