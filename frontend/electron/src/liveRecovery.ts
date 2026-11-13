/**
 * What to do when a live channel ends by itself.
 *
 * A live stream has no end, so mpv ending one is always a fault: found on
 * 13 November against the fake provider, a live HLS playlist whose reload
 * fails twice in a row (one 500 and its retry) ends in mpv as an ordinary
 * end of file -- reason `eof`, no error -- once the few seconds it had read
 * are played. The app took that for the end of a film and closed the player,
 * which is a channel that stops "with no error".
 *
 * So the channel is opened again at the live edge, quietly, a few times; a
 * channel that then plays steadily has its count start again, so a hiccup
 * every few minutes is survived every time. When it really cannot go on, the
 * player says so and waits for Enter (try again) or Escape (close).
 *
 * Each reopen waits a little first: the old connection has closed, and a
 * provider that allows one connection goes on counting a closed one for a
 * moment (the same reason a channel switch waits).
 */

/** The waits before each reopen in a row; one more ending after the last is giving up. */
export const REOPEN_DELAYS_MS = [1_000, 3_000, 8_000];

/** Playing this long since the last reopen counts as recovered: the next ending starts again. */
export const STEADY_MS = 30_000;

export type Recovery = { kind: 'reopen'; delayMs: number; attempt: number } | { kind: 'giveUp'; attempts: number };

export class LiveRecovery {
  private attempts = 0;
  private playingSince: number | null = null;
  private everPlayed = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether the channel has shown a picture since it was opened, which is when an ending is a drop. */
  get played(): boolean {
    return this.everPlayed;
  }

  /** The picture is there (mpv's `playback-restart`, or a position read). */
  playing(): void {
    this.everPlayed = true;
    if (this.playingSince === null) {
      this.playingSince = this.now();
    }
  }

  /** mpv ended the stream by itself (`end-file` with `eof` or `error`). */
  ended(): Recovery {
    const since = this.playingSince;
    this.playingSince = null;
    if (since !== null && this.now() - since >= STEADY_MS) {
      this.attempts = 0;
    }
    if (this.attempts >= REOPEN_DELAYS_MS.length) {
      return { kind: 'giveUp', attempts: this.attempts };
    }
    const delayMs = REOPEN_DELAYS_MS[this.attempts];
    this.attempts++;
    return { kind: 'reopen', delayMs, attempt: this.attempts };
  }

  /** The viewer asked to try again, or another channel was opened: a fresh start. */
  reset(): void {
    this.attempts = 0;
    this.playingSince = null;
  }

  /** Another channel: nothing about the last one counts. */
  forget(): void {
    this.reset();
    this.everPlayed = false;
  }
}
