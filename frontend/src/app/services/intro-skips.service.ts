import { Injectable } from '@angular/core';
import { Skip, introDbAddress, skipsFromIntroDb } from '@shared/tmdb/introdb';

/** How long opening an episode waits for its times before going without. */
const WAIT_MS = 1200;

/** Answers are kept this long on the device: times change rarely, and the database asks to be spared. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

const STORE_KEY = 'tvinto_intro_skips';

/** At most this many answers are kept, the newest. */
const MOST_KEPT = 400;

type Kept = Record<string, { at: number; skips: Skip[] }>;

/**
 * The intro, recap and credits of an episode, from TheIntroDB, for the
 * player's Skip intro (shared/tmdb/introdb.ts).
 *
 * Asked before the player opens and handed to it, never while it plays: the
 * page behind a native player is held back by Android, and nothing the player
 * does may wait on it. A slow or failed answer means no button, never a
 * held-up episode.
 */
@Injectable({ providedIn: 'root' })
export class IntroSkipsService {
  private readonly asking = new Map<string, Promise<Skip[]>>();

  /** The skips of one episode, or [] when they are unknown or slow to come. */
  async forEpisode(tmdbId: number | null | undefined, season: number, episode: number, durationMs = 0): Promise<Skip[]> {
    if (!tmdbId || !(season >= 0) || !(episode > 0)) {
      return [];
    }
    const key = `${tmdbId}:${season}:${episode}`;
    const kept = read()[key];
    if (kept && Date.now() - kept.at < KEEP_MS) {
      return kept.skips;
    }
    let asked = this.asking.get(key);
    if (!asked) {
      asked = this.ask(key, introDbAddress(tmdbId, season, episode, durationMs), durationMs);
      this.asking.set(key, asked);
      void asked.finally(() => this.asking.delete(key));
    }
    return Promise.race([asked, new Promise<Skip[]>(done => setTimeout(() => done([]), WAIT_MS))]);
  }

  private async ask(key: string, address: string, durationMs: number): Promise<Skip[]> {
    try {
      const response = await fetch(address);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        // Not in the database (it answers 400 for an id it doesn't know): kept
        // as nothing, so it is not asked again for a while.
        keep(key, []);
        return [];
      }
      if (!response.ok) {
        return [];
      }
      const skips = skipsFromIntroDb(await response.json(), durationMs);
      keep(key, skips);
      return skips;
    } catch {
      return [];
    }
  }
}

function read(): Kept {
  try {
    const kept = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Kept;
    return kept && typeof kept === 'object' ? kept : {};
  } catch {
    return {};
  }
}

function keep(key: string, skips: Skip[]): void {
  try {
    const kept = { ...read(), [key]: { at: Date.now(), skips } };
    const newest = Object.entries(kept)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MOST_KEPT);
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // Storage unavailable: asked again next time.
  }
}
