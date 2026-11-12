/**
 * How often each category of a library has been opened on this device, for
 * the rows on Movies and TV Shows: the ones opened most come first (the
 * owner, 1 November, over "the one left last, then the library's order").
 *
 * Per device, like where a library was left: a television and a phone are
 * used for different things. Kept as `{ id: [times, lastOpenedMs] }`.
 */

/** `xtream_category_opens_vod`: one per library. */
export const CATEGORY_OPENS_KEY = 'xtream_category_opens_';

/** Enough for anyone's habits; the least opened go first when it fills. */
const KEPT = 200;

type Opens = Record<string, [number, number]>;

function read(raw: string | null): Opens {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const opens: Opens = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
        opens[id] = [value[0], value[1]];
      }
    }
    return opens;
  } catch {
    return {};
  }
}

/** The ids, most opened first; of two opened as often, the one opened last. */
export function mostOpened(raw: string | null): string[] {
  return Object.entries(read(raw))
    .sort(([, a], [, b]) => b[0] - a[0] || b[1] - a[1])
    .map(([id]) => id);
}

/** The record with one more opening of `id`, at `now`. */
export function withOpening(raw: string | null, id: string, now: number): string {
  const opens = read(raw);
  opens[id] = [(opens[id]?.[0] ?? 0) + 1, now];
  const kept = mostOpened(JSON.stringify(opens)).slice(0, KEPT);
  return JSON.stringify(Object.fromEntries(kept.map(one => [one, opens[one]])));
}

/** The record with each id renamed, as a device's categories are when it signs in (local-retag.utils). */
export function retaggedOpens(raw: string | null, rename: (id: string) => string): string {
  const opens = read(raw);
  const moved: Opens = {};
  for (const [id, [times, at]] of Object.entries(opens)) {
    const to = rename(id);
    const already = moved[to];
    moved[to] = already ? [already[0] + times, Math.max(already[1], at)] : [times, at];
  }
  return JSON.stringify(moved);
}
