/**
 * What the provider said about a film's or show's ids, remembered on the device.
 *
 * So that the provider is asked once per title rather than every time "Add
 * subtitles" is opened -- the one-connection subscription is not to be used as
 * a lookup service. Kept per subscription, since two lines can number the same
 * film differently, and per show rather than per episode, since the show's id
 * is what an episode is searched by.
 *
 * "No id" is remembered too: asking again would get the same answer. Entries
 * go stale after a month, in case the provider fills an id in later, and the
 * oldest are dropped past a few hundred, which is more titles than anyone adds
 * subtitles to.
 */

export interface RememberedIds {
  tmdbId: number | null;
  imdbId: number | null;
  originalTitle: string | null;
  year: number | null;
  /** Epoch milliseconds. */
  at: number;
}

export type IdentityStore = Record<string, RememberedIds>;

export const IDENTITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const IDENTITY_LIMIT = 400;

/** The key for a film (`vod` + stream id) or a show (`series` + series id) on one subscription. */
export const identityKey = (subscription: string, type: 'vod' | 'series', id: string | number): string =>
  `${subscription}|${type}|${id}`;

/**
 * A short, stable name for a subscription that is not its username.
 *
 * The provider username is a credential in all but name -- it is half of what
 * every provider URL carries -- so it does not go into storage keys as it is.
 * FNV-1a is enough: this only has to keep two lines apart, not resist anyone.
 */
export const subscriptionKey = (server: string, username: string): string => {
  let hash = 0x811c9dc5;
  for (const character of `${server.trim().toLowerCase()}|${username}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
};

/** What is remembered for a key, if it is fresh. */
export const recall = (store: IdentityStore, key: string, now: number): RememberedIds | null => {
  const entry = store[key];
  return entry && now - entry.at < IDENTITY_TTL_MS ? entry : null;
};

/** The store with this answer in it, and the oldest dropped past the limit. */
export const remember = (
  store: IdentityStore,
  key: string,
  ids: Omit<RememberedIds, 'at'>,
  now: number
): IdentityStore => {
  const next: IdentityStore = { ...store, [key]: { ...ids, at: now } };
  const keys = Object.keys(next);
  if (keys.length <= IDENTITY_LIMIT) {
    return next;
  }
  keys
    .sort((a, b) => next[a].at - next[b].at)
    .slice(0, keys.length - IDENTITY_LIMIT)
    .forEach(old => delete next[old]);
  return next;
};

/** A stored store, or an empty one for anything damaged. */
export const readIdentityStore = (raw: string | null): IdentityStore => {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const store: IdentityStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, Partial<RememberedIds>>)) {
      if (value && typeof value.at === 'number') {
        store[key] = {
          tmdbId: typeof value.tmdbId === 'number' ? value.tmdbId : null,
          imdbId: typeof value.imdbId === 'number' ? value.imdbId : null,
          originalTitle: typeof value.originalTitle === 'string' ? value.originalTitle : null,
          year: typeof value.year === 'number' ? value.year : null,
          at: value.at
        };
      }
    }
    return store;
  } catch {
    return {};
  }
};
