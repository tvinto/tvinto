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
