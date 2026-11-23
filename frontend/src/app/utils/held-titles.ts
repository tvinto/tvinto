import { TitleFilter, titleFilter } from '@shared/heldTitles';
import { plainTitle } from '@shared/tmdb/popular';
import { posterTitle } from './series-display.utils';

/**
 * The titles an error report must not carry (ErrorReportsService takes them
 * out). A plain module, not a service: the players and the stores note what
 * passes through them without depending on anything about reports.
 *
 * Two lists. What was played this run, few, each taken out as a value of its
 * own (cleanText). And every title the app has read from its library and
 * guides -- what was browsed past, never played -- many, taken out through
 * an index by first word (shared/heldTitles.ts).
 */
const KEPT = 30;
const titles: string[] = [];

export function rememberPlayedTitle(...names: (string | null | undefined)[]): void {
  for (const name of names) {
    if (typeof name === 'string' && name.trim() && !titles.includes(name)) {
      titles.push(name);
    }
  }
  titles.splice(0, Math.max(0, titles.length - KEPT));
}

export const playedTitles = (): readonly string[] => titles;

/** The most titles held at once: a whole library, and room for the guide on screen. */
const HELD_MAX = 60_000;
const held = new Set<string>();
let filter: TitleFilter | null = null;

/**
 * Notes the names in what a store read: streams (`name`), programmes and
 * episodes (`title`), a show's info. Anything else is passed over.
 */
export function noteHeldTitles(read: unknown): void {
  const items = Array.isArray(read) ? read : read && typeof read === 'object' ? [read] : [];
  let added = false;
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    for (const field of ['name', 'title'] as const) {
      const value = (item as Record<string, unknown>)[field];
      if (typeof value !== 'string' || !value.trim() || held.has(value)) {
        continue;
      }
      // As the provider names it ("EN - Never Surrender (2026)") and as the
      // screen shows it ("Never Surrender"), which is the form an error quotes.
      for (const form of [value, posterTitle(value).title, plainTitle(value)]) {
        held.add(form);
      }
      added = true;
    }
  }
  if (!added) {
    return;
  }
  // The oldest go first: a Set keeps the order things were added in.
  for (const oldest of held) {
    if (held.size <= HELD_MAX) {
      break;
    }
    held.delete(oldest);
  }
  filter = null;
}

/** Built when a report needs it, and kept until the next title arrives. */
export function heldTitleFilter(): TitleFilter {
  filter ??= titleFilter(held);
  return filter;
}

/**
 * A store whose reads are noted as they return: the catalogue and the guide
 * hand every title on screen through these, so a title browsed past is held
 * the moment it could turn up in an error.
 */
export function notingTitles<T extends object>(store: T, reads: readonly (keyof T)[]): T {
  return new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== 'function') {
        return value;
      }
      // Called on the store itself, never the proxy: a store's private fields are not the proxy's.
      if (!reads.includes(key as keyof T)) {
        return (value as (...a: unknown[]) => unknown).bind(target);
      }
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (out instanceof Promise) {
          return out.then(result => {
            noteHeldTitles(result);
            return result;
          });
        }
        noteHeldTitles(out);
        return out;
      };
    }
  });
}

/** A show's name and every episode's, from the provider's answer for it. */
export function noteShowTitles(show: { name?: unknown; info?: unknown; episodes?: Record<string, unknown[]> } | null | undefined): void {
  if (!show) {
    return;
  }
  noteHeldTitles([show, show.info, ...Object.values(show.episodes ?? {}).flat()]);
}
