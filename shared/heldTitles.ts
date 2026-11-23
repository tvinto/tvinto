/**
 * Every title the app holds -- channels, films, shows, episodes, guide
 * programmes -- taken out of an error report (docs/error-reports.md).
 *
 * The values cleanText takes out are a few dozen, each its own pattern.
 * Titles are thousands, so they are found another way: an index by each
 * title's first word, and one pass over the words of a string, comparing
 * only the titles that start with the word at hand. Built once per change to
 * the list, not once per report.
 */

/** Shorter titles ("Up", "24") are left: taking them out would empty every message. */
const SHORTEST = 3;

const WORD = /[\p{L}\p{N}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
// Not global: matchAll copies a global pattern's lastIndex, so sharing WORD here skipped the start of every text.
const FIRST_WORD = /[\p{L}\p{N}]+/u;

/** Takes every held title out of one string. */
export type TitleFilter = (text: string) => string;

interface Candidate {
  /** The title in lower case. */
  lower: string;
  /** Where its first word starts within it: "(500) Days" starts its word at 1. */
  offset: number;
}

export function titleFilter(titles: Iterable<string>): TitleFilter {
  const byFirstWord = new Map<string, Candidate[]>();
  for (const raw of titles) {
    const lower = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (lower.length < SHORTEST) {
      continue;
    }
    const first = FIRST_WORD.exec(lower);
    if (!first) {
      continue;
    }
    const list = byFirstWord.get(first[0]) ?? [];
    if (!list.some(c => c.lower === lower)) {
      list.push({ lower, offset: first.index });
    }
    byFirstWord.set(first[0], list);
  }
  for (const list of byFirstWord.values()) {
    // Longest first, so "Doctor Who: Flux" goes whole rather than leaving ": Flux".
    list.sort((a, b) => b.lower.length - a.lower.length);
  }

  return text => {
    if (!byFirstWord.size || !text) {
      return text;
    }
    const lower = text.toLowerCase();
    // toLowerCase keeps the length for nearly every script; where it does not, positions would drift.
    if (lower.length !== text.length) {
      return text;
    }
    let out = '';
    let from = 0;
    for (const match of lower.matchAll(WORD)) {
      const at = match.index ?? 0;
      if (at < from) {
        continue;
      }
      const hit = byFirstWord.get(match[0])?.find(c => {
        const start = at - c.offset;
        const end = start + c.lower.length;
        return (
          start >= from &&
          lower.startsWith(c.lower, start) &&
          !(start > 0 && WORD_CHAR.test(lower[start - 1] ?? '') && WORD_CHAR.test(c.lower[0] ?? '')) &&
          !(end < lower.length && WORD_CHAR.test(lower[end] ?? '') && WORD_CHAR.test(c.lower[c.lower.length - 1] ?? ''))
        );
      });
      if (hit) {
        const start = at - hit.offset;
        out += text.slice(from, start) + '[title]';
        from = start + hit.lower.length;
      }
    }
    return out + text.slice(from);
  };
}

/** Every string in a value, at any depth, through the filter. A new value; the one given is left alone. */
export function removeTitles<T>(value: T, filter: TitleFilter, depth = 0): T {
  if (typeof value === 'string') {
    return filter(value) as T;
  }
  if (depth > 12 || value === null || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => removeTitles(item, filter, depth + 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    // The event's own id is 32 hex characters; a title is never that, but it is never worth the risk.
    out[key] = key === 'event_id' ? field : removeTitles(field, filter, depth + 1);
  }
  return out as T;
}
