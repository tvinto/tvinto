/**
 * Waiting for a moment when nobody is using the app, for work that would
 * otherwise get in the way: refreshing a whole film library makes a
 * television's remote answer late while it runs.
 *
 * Quiet means the app has been open a while and nothing has been pressed,
 * tapped or scrolled for a few seconds. Checked every few seconds; resolves
 * once quiet, or never if `stopped()` turns true first.
 */

export interface QuietOptions {
  /** How long after the page started before anything counts as quiet. */
  afterStartMs: number;
  /** How long without input counts as quiet. */
  idleMs: number;
  /** How often to look. */
  checkEveryMs: number;
  /** Milliseconds since the page started (performance.now()). */
  now(): number;
  /** When input last came, on the same clock. */
  lastInput(): number;
  stopped(): boolean;
  wait(ms: number): Promise<void>;
}

export async function whenQuiet(options: QuietOptions): Promise<boolean> {
  for (;;) {
    if (options.stopped()) {
      return false;
    }
    const now = options.now();
    if (now >= options.afterStartMs && now - options.lastInput() >= options.idleMs) {
      return true;
    }
    await options.wait(options.checkEveryMs);
  }
}

let lastInputAt = 0;
let listening = false;

/** When input last reached the page, on performance.now()'s clock. Starts listening on first use. */
export function lastInput(): number {
  if (!listening && typeof document !== 'undefined') {
    listening = true;
    const note = () => (lastInputAt = performance.now());
    for (const event of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
      document.addEventListener(event, note, { capture: true, passive: true });
    }
  }
  return lastInputAt;
}
