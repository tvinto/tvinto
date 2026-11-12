/**
 * Skip intro on the desktop: the same stretches and rules as Android's
 * SkipTimes.java, for mpv.
 *
 * The web app hands over what TheIntroDB knows (shared/tmdb/introdb.ts,
 * already checked there). A file's own chapters, when named for what they
 * are, are right for that very file and win. mpv draws no buttons of the
 * app's, so the offer is a line of text and Enter takes it.
 */

export interface Skip {
  kind: 'intro' | 'recap' | 'credits' | string;
  startMs: number;
  endMs: number;
}

/** A database's times are for the original release; a provider's copy may start a little later. */
export const SHOWN_EARLY_MS = 2_000;
/** And the offer goes a moment before the end, so taking it never lands back where it was. */
export const GONE_BEFORE_END_MS = 1_500;

/** The intro or recap playing at this position, to offer to skip, or null. Never the credits. */
export function skipAt(skips: readonly Skip[], positionMs: number): Skip | null {
  for (const skip of skips) {
    if (skip.kind === 'credits') {
      continue;
    }
    if (positionMs >= skip.startMs - SHOWN_EARLY_MS && positionMs < skip.endMs - GONE_BEFORE_END_MS) {
      return skip;
    }
  }
  return null;
}

/** A chapter as mpv's `chapter-list` gives it: a title and a start in seconds. */
export interface MpvChapter {
  title?: unknown;
  time?: unknown;
}

const RECAP_NAME = /\b(?:recap|previously on)\b/;
const INTRO_NAME = /\b(?:intro(?:duction)?|opening|opening credits|title sequence|theme song?)\b/;
const CREDITS_NAME = /\bcredits?\b|\boutro\b/;
const POST_CREDITS = /\bpost[- ]credits?\b/;
const NOT_END_CREDITS = /\bopening\b.*\bcredits?\b|\bpost[- ]credits?\b/;
const END_CREDITS_NAME = /\b(?:end|closing)\s+credits?\b|\bcredit\s+roll\b|\boutro\b/;

/**
 * The skips a file's chapters name, as StreamVault's player reads them.
 * Credits only when named as the end's, or named credits and in the last
 * 40 % -- never "opening credits" or a "post-credits scene".
 */
export function skipsFromChapters(chapters: readonly MpvChapter[], durationMs: number): Skip[] {
  const list = chapters
    .filter(chapter => typeof chapter.time === 'number' && Number.isFinite(chapter.time) && chapter.time >= 0)
    .map(chapter => ({ title: typeof chapter.title === 'string' ? chapter.title.toLowerCase() : '', startMs: Math.round((chapter.time as number) * 1000) }))
    .sort((a, b) => a.startMs - b.startMs);
  const found: Skip[] = [];
  let intro = false;
  list.forEach((chapter, i) => {
    const endMs = i + 1 < list.length ? list[i + 1].startMs : durationMs;
    if (!(endMs > chapter.startMs)) {
      return;
    }
    const name = chapter.title;
    if (RECAP_NAME.test(name)) {
      found.push({ kind: 'recap', startMs: chapter.startMs, endMs });
    } else if (
      CREDITS_NAME.test(name) &&
      !NOT_END_CREDITS.test(name) &&
      (END_CREDITS_NAME.test(name) || (durationMs > 0 && chapter.startMs >= durationMs * 0.6))
    ) {
      found.push({ kind: 'credits', startMs: chapter.startMs, endMs });
    } else if (!intro && INTRO_NAME.test(name) && !POST_CREDITS.test(name)) {
      found.push({ kind: 'intro', startMs: chapter.startMs, endMs });
      intro = true;
    }
  });
  return found;
}

/** The skips handed over by the web app, with anything malformed left out. */
export function handedSkips(value: unknown): Skip[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (one): one is Skip =>
        !!one &&
        typeof one === 'object' &&
        typeof (one as Skip).kind === 'string' &&
        typeof (one as Skip).startMs === 'number' &&
        typeof (one as Skip).endMs === 'number' &&
        (one as Skip).startMs >= 0 &&
        (one as Skip).endMs > (one as Skip).startMs
    )
    .slice(0, 20);
}
