import { Injectable, signal } from '@angular/core';

/** Per device, and deliberately not synced: what was searched for here. */
const KEY = 'xtream_recent_searches';

/** How many are kept: SR-TV-2 draws five, one OK each. */
export const RECENT_SEARCHES_KEPT = 5;

/**
 * The searches to offer again, newest first, with the one just made at the
 * front: once each, ignoring case, and without the shorter words typed on the
 * way to it -- "dun" is not a search anybody wants back once "dune" is there.
 */
export function withSearch(recent: readonly string[], term: string): string[] {
  const asked = term.trim().replace(/\s+/g, ' ');
  if (!asked) {
    return [...recent];
  }
  const lower = asked.toLowerCase();
  const kept = recent.filter(earlier => {
    const other = earlier.toLowerCase();
    return other !== lower && !lower.startsWith(other);
  });
  return [asked, ...kept].slice(0, RECENT_SEARCHES_KEPT);
}

/**
 * The last few searches on this device (SR-TV-2).
 *
 * On a remote, typing "severance" a second time is the slowest thing in the
 * app; one press on what was asked last time is the fastest. Kept in this
 * device's storage only: what somebody searched for is nobody else's
 * business, the family's included.
 */
@Injectable({ providedIn: 'root' })
export class RecentSearchesService {
  readonly list = signal<string[]>(read());

  /** A search that was meant: one somebody opened a result of, or pressed Enter on. */
  remember(term: string): void {
    if (term.trim().length < 3) {
      return;
    }
    this.list.set(withSearch(this.list(), term));
    write(this.list());
  }

  clear(): void {
    this.list.set([]);
    write([]);
  }
}

function read(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string').slice(0, RECENT_SEARCHES_KEPT) : [];
  } catch {
    return [];
  }
}

function write(list: readonly string[]): void {
  try {
    if (list.length) {
      localStorage.setItem(KEY, JSON.stringify(list));
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {
    // Storage refused: the list lasts as long as this run, which is all it loses.
  }
}
