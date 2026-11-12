import { Category, StreamType } from './types';

/**
 * Hidden and locked categories, and the PIN that guards the locked ones.
 *
 * Two different things, kept apart on purpose. A hidden category is clutter
 * put out of the way -- a provider with 834 categories has hundreds in
 * languages nobody here reads -- and anyone can bring it back. A locked one is
 * a parent's decision: it and everything in it disappear until the PIN is
 * given, and it comes back locked on the next start, after a while untouched,
 * or when somebody presses "Lock now". That behaviour is IPTVnator's.
 *
 * Both are account settings, so a lock set on the laptop is in force on the
 * children's television. Whether this device is unlocked is not: that lives in
 * memory and nowhere else, which is what makes a restart lock it again.
 */

/** Category ids per library. */
export type CategorySets = Record<StreamType, string[]>;

export const noCategories = (): CategorySets => ({ live: [], vod: [], series: [] });

const TYPES: StreamType[] = ['live', 'vod', 'series'];

/**
 * A stored set, read forgivingly.
 *
 * Settings arrive from other devices and from older builds, so anything that
 * is not the expected shape reads as nothing chosen rather than as an error --
 * a broken setting must not be what stops the categories from loading.
 */
export function readCategorySets(raw: string | null | undefined): CategorySets {
  const sets = noCategories();
  if (!raw) {
    return sets;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const type of TYPES) {
      const ids = parsed?.[type];
      if (Array.isArray(ids)) {
        sets[type] = [...new Set(ids.map(String))];
      }
    }
  } catch {
    // As though nothing were chosen.
  }
  return sets;
}

export const writeCategorySets = (sets: CategorySets): string => JSON.stringify(sets);

/** The same sets with one category put in or taken out. */
export function withCategory(sets: CategorySets, type: StreamType, id: string, on: boolean): CategorySets {
  const others = sets[type].filter(existing => existing !== String(id));
  return { ...sets, [type]: on ? [...others, String(id)] : others };
}

export const countOf = (sets: CategorySets): number =>
  TYPES.reduce((total, type) => total + sets[type].length, 0);

/**
 * The categories a list should show.
 *
 * Hidden ones never; locked ones only while this device is unlocked.
 */
export function categoriesShown(
  categories: Category[],
  hidden: readonly string[],
  locked: readonly string[],
  lockEngaged: boolean
): Category[] {
  if (!hidden.length && !(lockEngaged && locked.length)) {
    return categories;
  }
  const out = new Set(hidden.map(String));
  if (lockEngaged) {
    locked.forEach(id => out.add(String(id)));
  }
  return categories.filter(category => !out.has(String(category.category_id)));
}

// --- The PIN ---------------------------------------------------------------

/** What is stored for the lock: never the PIN itself. */
export interface LockSettings {
  salt: string;
  hash: string;
  /** Minutes untouched before it locks again; 0 for only on restart. */
  idleMinutes: number;
}

export const PIN_LENGTH = 4;

/** The choices offered for locking again, in minutes. 0 is "only when the app restarts". */
export const IDLE_CHOICES = [5, 15, 30, 60, 0] as const;

export const DEFAULT_IDLE_MINUTES = 30;

export const pinIsWellFormed = (pin: string): boolean => new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);

export function readLockSettings(raw: string | null | undefined): LockSettings | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockSettings>;
    if (typeof parsed?.salt !== 'string' || typeof parsed?.hash !== 'string' || !parsed.hash) {
      return null;
    }
    const idle = Number(parsed.idleMinutes);
    return {
      salt: parsed.salt,
      hash: parsed.hash,
      idleMinutes: Number.isFinite(idle) && idle >= 0 ? idle : DEFAULT_IDLE_MINUTES
    };
  } catch {
    return null;
  }
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

export function newSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The PIN, as stored.
 *
 * PBKDF2 rather than a plain hash so that the setting is not the PIN in all
 * but name -- though with ten thousand possible PINs, no function makes it a
 * secret from somebody holding the account's settings. It keeps a child from
 * reading it off a screen; it is not meant to do more, and could not.
 */
export async function hashPin(pin: string, salt: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('This build has no SubtleCrypto, so it cannot keep a PIN');
  }
  const key = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const saltBytes = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: 100_000 },
    key,
    256
  );
  return toBase64(new Uint8Array(bits));
}

/**
 * Whether an unlocked device should lock again now.
 *
 * Playing counts as being used: a film that runs longer than the idle time
 * must not lock under the viewer, and on Android the page behind a native
 * player hears no key presses at all while it plays.
 */
export function lockIsDue(state: {
  unlocked: boolean;
  playing: boolean;
  idleMinutes: number;
  lastActivityMs: number;
  nowMs: number;
}): boolean {
  if (!state.unlocked || state.playing || state.idleMinutes <= 0) {
    return false;
  }
  return state.nowMs - state.lastActivityMs >= state.idleMinutes * 60_000;
}
