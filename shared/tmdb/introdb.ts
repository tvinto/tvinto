/**
 * Intro, recap and credits times from TheIntroDB (theintrodb.org), a free
 * community database looked up by TMDB id, for the player's Skip intro.
 *
 * No key is needed. It allows about 30 requests in a short window, so a show
 * asks once per episode and the answer is kept.
 *
 * The times are contributed by people and some are wrong or half there: an
 * intro with no end, an "intro" in the middle of an episode. Each kind is
 * checked against where it can plausibly be before it is used -- the rules
 * IPVIO Stream settled on, since a button that skips the wrong minute is
 * worse than no button.
 */

export type SkipKind = 'intro' | 'recap' | 'credits';

/** A stretch of an episode or a film the player offers to skip, in milliseconds from its start. */
export interface Skip {
  kind: SkipKind;
  startMs: number;
  endMs: number;
}

const BASE = 'https://api.theintrodb.org/v3/media';

/** The address for one film (no season and episode) or one episode. */
export function introDbAddress(tmdbId: number, season?: number, episode?: number, durationMs?: number): string {
  const query = new URLSearchParams({ tmdb_id: String(tmdbId) });
  if (season != null && episode != null && season >= 0 && episode > 0) {
    query.set('season', String(season));
    query.set('episode', String(episode));
  }
  if (durationMs && durationMs > 0) {
    // Lets the database pick times for this cut when it knows several.
    query.set('duration_ms', String(Math.round(durationMs)));
  }
  return `${BASE}?${query}`;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * Whether a stretch of this kind can be where it says, and where it then is.
 * `durationMs` is the episode's length, or 0 when nobody knows it.
 */
export function plausibleSkip(kind: SkipKind, startMs: number | null, endMs: number | null, durationMs: number): Skip | null {
  const length = durationMs > 0 ? durationMs : Number.MAX_SAFE_INTEGER;
  if (kind === 'credits') {
    // Credits run to the end when the end is not given, and start in the last quarter.
    if (startMs == null) {
      return null;
    }
    const end = Math.min(endMs ?? length, length);
    if (end - startMs < 5 * SECOND || (durationMs > 0 && (startMs < durationMs * 0.75 || startMs >= durationMs))) {
      return null;
    }
    return { kind, startMs, endMs: end };
  }
  // An intro or a recap needs its end, or the button would last to the end of the episode.
  if (endMs == null) {
    return null;
  }
  const start = startMs ?? 0;
  const longest = kind === 'intro' ? 3 * MINUTE : 4 * MINUTE;
  if (endMs - start < 5 * SECOND || endMs - start > longest || endMs > length + 5 * SECOND) {
    return null;
  }
  // An intro in the first half, a recap in the first third.
  if (durationMs > 0 && start > durationMs * (kind === 'intro' ? 0.5 : 0.35)) {
    return null;
  }
  return { kind, startMs: start, endMs: Math.min(endMs, length) };
}

interface Answer {
  intro?: unknown;
  recap?: unknown;
  credits?: unknown;
}

const timeOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** The skips in an answer from TheIntroDB, kept to the plausible ones, in order. */
export function skipsFromIntroDb(answer: unknown, durationMs = 0): Skip[] {
  if (!answer || typeof answer !== 'object') {
    return [];
  }
  const skips: Skip[] = [];
  for (const kind of ['intro', 'recap', 'credits'] as const) {
    const list = (answer as Answer)[kind];
    for (const entry of Array.isArray(list) ? list : []) {
      const found =
        entry && typeof entry === 'object'
          ? plausibleSkip(kind, timeOf((entry as { start_ms?: unknown }).start_ms), timeOf((entry as { end_ms?: unknown }).end_ms), durationMs)
          : null;
      if (found) {
        skips.push(found);
      }
    }
  }
  return skips.sort((a, b) => a.startMs - b.startMs);
}
