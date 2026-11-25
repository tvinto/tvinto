/**
 * The film and show libraries downloaded soon after start and kept fresh
 * after, whichever screen is open (25 November). Only Movies, a search or
 * For You's quiet minute used to ask, so a new device showed TMDB's rows
 * worked out from an empty library until someone opened Movies.
 *
 * Each try waits for a quiet moment and for nothing to be using the
 * provider's one connection (a player, a preview, a guide download, a
 * recording); `refresh` itself does nothing for a library still fresh.
 */
export interface LibraryRefreshOptions {
  /** Resolves true at a quiet moment, false once stopped. */
  quiet(): Promise<boolean>;
  /** Something is using the provider's connection right now. */
  busy(): boolean;
  /** False when it could not look at every library (no provider yet, or the connection became busy): tried again soon. */
  refresh(): Promise<boolean>;
  wait(ms: number): Promise<void>;
  stopped(): boolean;
}

/** How soon to look again when the connection was busy. */
export const BUSY_RETRY_MS = 30_000;
/** How often to look whether a library has gone stale (a day, by the catalogue's own measure). */
export const RECHECK_MS = 10 * 60_000;
/**
 * Quiet twice, this far apart, before a download starts: what uses the
 * connection often starts at once -- a provider just added starts its guide
 * in the same moment -- and a look at a single instant raced it (25 November).
 */
export const SETTLE_MS = 3_000;

export async function keepLibrariesFresh(options: LibraryRefreshOptions): Promise<void> {
  while (!options.stopped()) {
    if (!(await options.quiet())) {
      return;
    }
    if (options.busy()) {
      await options.wait(BUSY_RETRY_MS);
      continue;
    }
    await options.wait(SETTLE_MS);
    if (options.busy()) {
      continue;
    }
    const looked = await options.refresh().catch(() => true);
    await options.wait(looked ? RECHECK_MS : BUSY_RETRY_MS);
  }
}

/**
 * A library already held is refreshed only while the television is left
 * alone: on the owner's TV a refresh beside someone browsing made pages wait
 * on the database (cards 35 and 38). Measured there (25 November): its screen
 * saver comes after 10 minutes without a press and sends the app to the
 * background, where Android freezes it about a minute later; the film
 * refresh needs about 6 minutes. Three minutes leaves room for it, and is
 * still far longer than anyone reads a page without pressing -- a press
 * stops it at once anyway. A frozen refresh carries on once the app is back.
 */
export const IDLE_MS = 3 * 60_000;
/** How often a waiting refresh looks whether the person has gone. */
export const IDLE_CHECK_MS = 1_000;

export interface IdleOptions {
  /** The app is in the background, minimised or closed behind another. */
  hidden(): boolean;
  /** Milliseconds on the same clock as `lastInput`. */
  now(): number;
  lastInput(): number;
  busy(): boolean;
  wait(ms: number): Promise<void>;
}

/** Nobody is using the app: hidden, or no press for IDLE_MS; and nothing is playing or downloading a guide. */
export function idleNow(options: IdleOptions): boolean {
  return (options.hidden() || options.now() - options.lastInput() >= IDLE_MS) && !options.busy();
}

/**
 * Resolves once nobody is using the app. What a refresh awaits before each
 * write, so a press stops it within one category and it carries on only
 * once the person has gone again.
 */
export async function untilIdle(options: IdleOptions): Promise<void> {
  while (!idleNow(options)) {
    await options.wait(IDLE_CHECK_MS);
  }
}

/**
 * `untilIdle` for one-off database work that starts before the app is up --
 * filling the word index of a library already held (CapacitorCatalogueStore).
 * AppComponent sets `until`; until then it waits as though somebody were there.
 */
export const idleWork: { until?: () => Promise<void> } = {};

export async function untilIdleWork(): Promise<void> {
  while (!idleWork.until) {
    await new Promise(resolve => setTimeout(resolve, IDLE_CHECK_MS));
  }
  await idleWork.until();
}
