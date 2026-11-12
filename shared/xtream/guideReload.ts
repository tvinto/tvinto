/**
 * When a guide already on this device should be downloaded again, unasked.
 *
 * Guides used to load only when somebody pressed a button, so they quietly ran
 * out. The two on a real device were loaded on 31 August, their programmes
 * ended on 6 September, and on the 12th every row of the guide read "No guide"
 * -- channels correctly matched, nothing left to draw. Nobody reloads a guide
 * they believe is working.
 *
 * Automatic, then, but a download that reaches the provider unasked is exactly
 * the kind of thing this app has reason to be careful with: a sweep of it once
 * got the address blocked for a fortnight. One guide download is one request,
 * not a thousand, and this still keeps it rare:
 *
 * - **Only when the programmes are about to run out.** Not on a timer. A feed
 *   covering a week is fetched about once a week, not seven times.
 * - **At most once a day per guide, whatever happens.** The attempt is counted
 *   when it starts, not when it succeeds, so a feed that fails or a load that
 *   crashes half way cannot turn into a retry loop against the provider.
 * - **Never a guide this device has not loaded before.** The first download of
 *   a guide is tens of megabytes, and the app already leaves that choice to a
 *   person -- a phone on mobile data should not have it made for it.
 *
 * Pure, so the rules are tested rather than hoped for.
 */

/** How little schedule may be left before a reload is worth it. */
export const RELOAD_WHEN_HOURS_REMAIN = 12;

/** The floor between two attempts at one guide, successful or not. */
export const HOURS_BETWEEN_ATTEMPTS = 24;

/**
 * The share of a guide's channels that may run out before the guide counts
 * as running out.
 *
 * Not the last programme of all: a feed covers its channels unevenly. One
 * loaded four hours earlier ran 55 hours ahead for its longest channel and 7
 * hours for a tenth of them (the development desktop, 6 October), and judged
 * by the longest it waited the better part of two days for a reload while
 * the short ones -- the ARENA SPORT channels on a user's screen -- drew
 * empty rows, with no "No programme guide" to say why, since they had
 * programmes earlier in the day. Judged by the tenth that run out first, a
 * guide like that is fetched once a day, which is the floor above anyway.
 */
export const RUNS_OUT_SHARE = 0.1;

/**
 * When a guide counts as running out: the time by which a tenth of its
 * channels have nothing left, from each channel's last programme. Null for a
 * guide with no programmes.
 *
 * Channels the feed had already stopped describing when it was loaded are
 * left out -- a reload brings them nothing, and counting them would have a
 * feed with a few dead channels fetched every day for ever.
 */
export const whenRunningOut = (lastStops: readonly number[], loadedAt: number | null): number | null => {
  if (!lastStops.length) {
    return null;
  }
  const sorted = [...lastStops].sort((a, b) => a - b);
  const live = loadedAt === null ? sorted : sorted.filter(stop => stop > loadedAt);
  if (!live.length) {
    return sorted[sorted.length - 1];
  }
  return live[Math.min(live.length - 1, Math.floor(live.length * RUNS_OUT_SHARE))];
};

export interface GuideReloadState {
  /** When the guide store says this guide last finished loading, or null if it has no record. */
  loadedAt: string | null;
  /**
   * Whether this device has ever finished loading the guide, as remembered
   * somewhere other than the guide store.
   *
   * The two used to be the same question, and they are not. On the desktop the
   * guides live in IndexedDB, and Chromium deletes an IndexedDB database it
   * decides is damaged -- silently, and without touching localStorage, so the
   * app stays signed in with its guides gone. Every guide then read as never
   * loaded, which the rules below correctly refuse to download unasked, and a
   * person reloaded both by hand after what looked to them like every update.
   * Remembered outside the store, a guide that vanished is told apart from one
   * nobody ever chose.
   */
  loadedHereBefore: boolean;
  /**
   * When it counts as running out (`whenRunningOut`: a tenth of its channels
   * with nothing left), in epoch milliseconds, or null if it has no programmes.
   */
  runsOutAt: number | null;
  /** When this device last started an automatic reload of it, or null. */
  lastAttemptAt: string | null;
}

export type GuideReloadDecision =
  | { reload: true; reason: 'running-out' | 'no-programmes' | 'lost' }
  | { reload: false; reason: 'never-loaded' | 'tried-recently' | 'enough-left' };

const HOUR = 60 * 60 * 1000;

/** A timestamp as milliseconds, or null when it cannot be read. */
const timeOf = (value: string | null): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const decideGuideReload = (state: GuideReloadState, now: number): GuideReloadDecision => {
  // A time more than a day ahead of now was written by a clock that was wrong
  // and has since been put right, and is ignored. Believing it would silence
  // reloads until that date arrived -- months, on a television box that once
  // booted thinking it was next year -- which is the guide running out again
  // with nothing to say why. Ignoring it costs at most one early reload.
  const believable = (time: number | null): number =>
    time !== null && time - now <= HOURS_BETWEEN_ATTEMPTS * HOUR ? time : -Infinity;
  const triedRecently = (since: number) => now - since < HOURS_BETWEEN_ATTEMPTS * HOUR;

  const loadedAt = timeOf(state.loadedAt);
  if (loadedAt === null) {
    if (!state.loadedHereBefore) {
      return { reload: false, reason: 'never-loaded' };
    }

    // Loaded here once and gone from the store since. Not a first download --
    // somebody already chose this guide on this device -- so it is fetched back,
    // under the same daily floor as any other reload: a store that keeps losing
    // it must not become a download every three hours.
    return triedRecently(believable(timeOf(state.lastAttemptAt)))
      ? { reload: false, reason: 'tried-recently' }
      : { reload: true, reason: 'lost' };
  }

  // A finished load counts as an attempt as well as a started one does: a
  // guide somebody reloaded by hand an hour ago should not be fetched again
  // because the automatic record says nothing.
  const lastTouched = Math.max(believable(loadedAt), believable(timeOf(state.lastAttemptAt)));
  if (triedRecently(lastTouched)) {
    return { reload: false, reason: 'tried-recently' };
  }

  if (state.runsOutAt === null) {
    return { reload: true, reason: 'no-programmes' };
  }

  if (state.runsOutAt - now < RELOAD_WHEN_HOURS_REMAIN * HOUR) {
    return { reload: true, reason: 'running-out' };
  }

  return { reload: false, reason: 'enough-left' };
};
