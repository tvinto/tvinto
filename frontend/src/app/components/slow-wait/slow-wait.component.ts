import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { TPipe } from '../../pipes/t.pipe';

/** After this long a wait says what it is waiting on, and counts. */
export const SLOW_AFTER_MS = 3000;
/** After this long it says so plainly, and offers to try again. */
export const VERY_SLOW_AFTER_MS = 20000;

/**
 * What a wait is waiting on, once it has gone on long enough to wonder
 * (19 October: a spinner for minutes "and I get no feedback what
 * is happening"). Nothing for the first few seconds; then "Asking your
 * provider for the episodes · 12 s"; past twenty seconds, that this is
 * longer than it should take, and Try again where trying again can help.
 */
@Component({
  selector: 'app-slow-wait',
  standalone: true,
  imports: [TPipe, HlmButton],
  template: `
    @if (seconds() !== null) {
      <div class="flex flex-col items-center gap-2 text-center" role="status" data-slow-wait>
        <p class="text-sm text-muted-foreground">{{ what() | t }} · {{ 'slow.seconds' | t: { seconds: seconds() } }}</p>
        @if (verySlow()) {
          <p class="text-sm">{{ 'slow.longer' | t }}</p>
          @if (retryable()) {
            <button hlmBtn size="sm" type="button" data-slow-retry (click)="retry.emit()">{{ 'popular.tryAgain' | t }}</button>
          }
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SlowWaitComponent {
  /** Whether the wait is on. */
  readonly waiting = input.required<boolean>();
  /** What is being waited on, as a key for the t pipe: "Asking your provider for the episodes". */
  readonly what = input.required<string>();
  /** Whether Try again is offered when it goes on too long. */
  readonly retryable = input(false);
  readonly retry = output<void>();

  /** Seconds waited, shown once the wait is slow; null before. */
  readonly seconds = signal<number | null>(null);
  readonly verySlow = signal(false);

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  constructor() {
    effect(() => {
      const waiting = this.waiting();
      untracked(() => (waiting ? this.begin() : this.end()));
    });
    inject(DestroyRef).onDestroy(() => this.end());
  }

  private begin(): void {
    this.end();
    const started = Date.now();
    this.timer = setInterval(() => {
      const waited = Date.now() - started;
      if (waited >= SLOW_AFTER_MS) {
        this.seconds.set(Math.round(waited / 1000));
        if (waited >= VERY_SLOW_AFTER_MS && !this.verySlow()) {
          this.verySlow.set(true);
          // A remote needs somewhere to start from: Try again, when nothing
          // else has focus -- once it is drawn, which a zoneless app does not
          // promise by the next tick.
          const focusRetry = (tries: number) =>
            setTimeout(() => {
              const active = document.activeElement;
              if (active && active !== document.body) {
                return;
              }
              const retry = this.host.nativeElement.querySelector<HTMLElement>('[data-slow-retry]');
              if (retry) {
                retry.focus({ preventScroll: true });
              } else if (tries > 0) {
                focusRetry(tries - 1);
              }
            }, 100);
          focusRetry(10);
        }
      }
    }, 1000);
  }

  private end(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.seconds.set(null);
    this.verySlow.set(false);
  }
}
