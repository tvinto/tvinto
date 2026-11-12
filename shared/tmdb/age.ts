/**
 * Locking films and shows by age rating (round 6, TV-31, D-21, P-19).
 *
 * TMDB keeps a rating per country, in that country's own words -- "16" in
 * Germany, "R" in the United States, "15" in the United Kingdom. The lock
 * reads the chosen country's, then Germany's, then the United States', and
 * turns it into the youngest age it is meant for. A title with no rating at
 * all stays open: that is most of an IPTV library, and the person setting the
 * lock is told so in full.
 */
import { ageRating } from './client';

/** The ages a lock can start at. 0 is off. */
export const AGE_LIMITS = [0, 12, 16, 18] as const;

/** The countries offered, in order. Croatia rates few titles; the fallback covers it. */
export const AGE_COUNTRIES = ['HR', 'DE', 'US', 'GB'] as const;

export interface AgeLock {
  /** Titles rated this age and over are locked; 0 locks nothing. */
  limit: number;
  /** Whose ratings come first. */
  country: string;
}

export const NO_AGE_LOCK: AgeLock = { limit: 0, country: 'HR' };

/** The setting's value as stored (SETTING_KEYS.ageLock), read leniently. */
export function readAgeLock(raw: string | null | undefined): AgeLock {
  try {
    const parsed = JSON.parse(raw || 'null') as Partial<AgeLock> | null;
    const limit = Number(parsed?.limit);
    const country = typeof parsed?.country === 'string' && /^[A-Z]{2}$/.test(parsed.country) ? parsed.country : NO_AGE_LOCK.country;
    return { limit: Number.isFinite(limit) && limit > 0 ? limit : 0, country };
  } catch {
    return NO_AGE_LOCK;
  }
}

export const writeAgeLock = (lock: AgeLock): string => JSON.stringify({ limit: lock.limit, country: lock.country });

/** The countries whose ratings are read, in order: the chosen one, then Germany, then the United States. */
export const ratingCountries = (country: string): string[] => [...new Set([country, 'DE', 'US'])];

/** Ratings that are words rather than ages, by what they allow. */
const WORDED: Record<string, number> = {
  // United States, films and television.
  G: 0,
  PG: 10,
  'PG-13': 13,
  R: 17,
  'NC-17': 18,
  'TV-Y': 0,
  'TV-Y7': 7,
  'TV-G': 0,
  'TV-PG': 10,
  'TV-14': 14,
  'TV-MA': 17,
  // United Kingdom.
  U: 0,
  '12A': 12,
  R18: 18
};

/** The youngest age a rating is meant for, or null for one it cannot read. */
export function ratingAge(rating: string): number | null {
  const plain = rating.trim().toUpperCase();
  if (!plain) {
    return null;
  }
  if (plain in WORDED) {
    return WORDED[plain];
  }
  // "16", "FSK 16", "16+", "K-16", "+12": the number is the age.
  const number = /(\d{1,2})/.exec(plain);
  return number ? Number(number[1]) : null;
}

/** The rating the lock reads for a title, as written ("16", "R"), or '' for none. */
export const lockRating = (certifications: Record<string, string>, country: string): string =>
  ageRating(certifications, ratingCountries(country));

/**
 * Whether a lock keeps a title closed: rated, readable, and at or over the
 * limit. An unrated title, or a rating that cannot be read, stays open.
 */
export function ageLocks(lock: AgeLock, certifications: Record<string, string>): boolean {
  if (lock.limit <= 0) {
    return false;
  }
  const age = ratingAge(lockRating(certifications, lock.country));
  return age !== null && age >= lock.limit;
}

/** Whether going from one lock to another opens anything up -- which needs the PIN. */
export function loosens(from: AgeLock, to: AgeLock): boolean {
  if (from.limit <= 0) {
    return false;
  }
  return to.limit <= 0 || to.limit > from.limit || to.country !== from.country;
}
