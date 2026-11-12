import { Injectable, signal } from '@angular/core';

/**
 * The time, to the minute, as a signal.
 *
 * What a template shows about time -- "12 min left", a programme gone past,
 * the now-line -- used to be worked out by a method the template called, and
 * so came out right because every check called it again. With OnPush and
 * computed values, nothing is worked out again unless something it read
 * changed; reading this is what makes "now" one of those things.
 *
 * One timer for the app, at each minute's turn rather than a minute after
 * whenever it started, so every clock on screen moves together.
 */
@Injectable({ providedIn: 'root' })
export class ClockService {
  /** Milliseconds, at the start of the current minute. */
  readonly minute = signal(ClockService.minuteOf(Date.now()));

  constructor() {
    const tick = () => {
      this.minute.set(ClockService.minuteOf(Date.now()));
      setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  }

  private static minuteOf(ms: number): number {
    return ms - (ms % 60_000);
  }
}
