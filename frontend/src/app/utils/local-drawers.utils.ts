import { accountStorageKey } from './account-storage.utils';

/**
 * Taking what a device kept without an account into the account it signs in
 * to, and back out of it again on a
 * sign-out that keeps it (stage 3).
 *
 * Three kinds of the person's own work are kept per storage name -- the
 * device's '~local' or an account's username: favourites, history and
 * arrangements; guides and channel matches; reminders. Each is moved under
 * the other name before anything reads it there. Where the other name
 * already holds something -- the account was used on this device before --
 * the moved copy waits beside it, and the service that owns that kind merges
 * it the next time it loads, newest change winning, as it merges what
 * another device sends.
 *
 * Plain functions over a Storage, so they can be tested without Angular.
 */

/** What is kept per storage name, by the prefix its owner names it with. */
export const DRAWER_PREFIXES = ['xtream_local_data', 'xtream_guide_sources', 'xtream_reminders'] as const;

export type DrawerPrefix = (typeof DRAWER_PREFIXES)[number];

/** Where a moved drawer waits to be merged by its owner. */
export const broughtKey = (prefix: DrawerPrefix, name: string): string =>
  accountStorageKey(`xtream_brought_${prefix.replace(/^xtream_/, '')}`, name);

/**
 * Whether stored text holds anybody's work rather than an empty shell. A
 * queue of changes not yet sent does not count: on its own it is what an
 * app leaves in a drawer it created and never filled.
 */
export const holdsWork = (raw: string | null): boolean => {
  if (raw === null) {
    return false;
  }
  // A list with anything in it, or a record of anything, is somebody's work:
  // reminders are a list, the other two are records of lists and records.
  const filled = (value: unknown): boolean =>
    Array.isArray(value)
      ? value.length > 0
      : value !== null && typeof value === 'object' && Object.keys(value).length > 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.length > 0
      : parsed !== null &&
          typeof parsed === 'object' &&
          Object.entries(parsed).some(([key, inner]) => key !== 'pending' && filled(inner));
  } catch {
    return false;
  }
};

/**
 * Moves every drawer from one storage name to another. Says which ones had
 * to wait to be merged, for anybody who wants to know.
 */
export function moveDrawers(storage: Storage, from: string, to: string): DrawerPrefix[] {
  const waiting: DrawerPrefix[] = [];
  for (const prefix of DRAWER_PREFIXES) {
    const source = accountStorageKey(prefix, from);
    const target = accountStorageKey(prefix, to);
    if (source === target) {
      continue;
    }
    const moving = storage.getItem(source);
    if (!holdsWork(moving)) {
      storage.removeItem(source);
      continue;
    }
    if (holdsWork(storage.getItem(target))) {
      storage.setItem(broughtKey(prefix, to), moving!);
      waiting.push(prefix);
    } else {
      storage.setItem(target, moving!);
    }
    storage.removeItem(source);
  }
  return waiting;
}

/** Takes a drawer waiting to be merged under this name, if there is one. */
export function takeBrought(storage: Storage, prefix: DrawerPrefix, name: string | null | undefined): string | null {
  if (!name) {
    return null;
  }
  try {
    const key = broughtKey(prefix, name);
    const raw = storage.getItem(key);
    storage.removeItem(key);
    return raw;
  } catch {
    return null;
  }
}
