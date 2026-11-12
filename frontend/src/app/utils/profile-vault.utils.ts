/**
 * Several accounts on one device, one at a time.
 *
 * A device is signed in to one account, and everything it keeps about that
 * account is either named after the account already -- favourites, history,
 * guide sources, the sync cursor, all keyed by username -- or sits under one
 * fixed name: the session token, the key that opens the subscription, the
 * provider's login, the settings. Switching to another family profile moves
 * the fixed-name ones aside into this vault and puts the other profile's in
 * their place; the app then starts again as that account, every service
 * reading storage as it always does.
 *
 * Setting somebody up is the same switch with a `setup` session, under a name
 * of its own (`ana~setup`) so nothing a manager does in it lands in the
 * member's own copy on this device.
 *
 * Plain functions over a Storage, so they can be tested without Angular.
 */

/** Where the vault itself lives. */
export const VAULT_KEY = 'xtream_family_profiles';

/**
 * Everything kept under a fixed name that belongs to the account rather than
 * the device. Mirrors the constants in the services that write them; a key
 * missing here would follow the device from one profile to the next.
 */
export const PROFILE_KEYS: readonly string[] = [
  'xtream_session_token',
  'xtream_account',
  'xtream_subscriptions',
  'xtream_account_enc',
  'xtream_provider_credentials',
  'xtream_provider_records',
  'xtream_settings',
  'xtream_settings_held',
  'xtream_setup_held_requests',
  'xtream_provider_clock',
  'xtream_collapsed_providers'
];

/** Fixed-name keys that come in families: one per library. */
export const PROFILE_KEY_PREFIXES: readonly string[] = ['xtream_last_category_', 'xtream_category_opens_'];

/** Keys named after an account, which go when a profile is forgotten. */
const NAMED_PREFIXES = /^(xtream_[a-z_]+):(.+?)(:|$)/;

export type ProfileScope = 'full' | 'setup';

/** A family member offered as a profile on this device. */
export interface HouseholdProfile {
  id: number;
  username: string;
  role: string;
  /** Their profile picture (shared/profilePicture.ts), as last heard. */
  picture?: string | null;
}

export interface ProfileVault {
  /** The account that signed in on this device, by folded username. */
  home: string;
  /** The profile in use, by its storage name (`ana`, or `ana~setup`). */
  active: string;
  /** What the profile in use is for. */
  scope: ProfileScope;
  /** When this device was last in use, for deciding whether to ask who is watching. */
  lastSeenAt: string | null;
  /** Household members, as last heard from the service, for asking with no network. */
  household: HouseholdProfile[];
  /** The fixed-name keys of every profile not in use, by storage name. */
  stash: Record<string, Record<string, string>>;
}

export const fold = (username: string): string => username.trim().toLowerCase();

/** The name a profile's own storage is kept under. */
export const storageNameOf = (username: string, scope: ProfileScope): string =>
  scope === 'setup' ? `${fold(username)}~setup` : fold(username);

export const readVault = (storage: Storage): ProfileVault | null => {
  try {
    const raw = storage.getItem(VAULT_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ProfileVault>) : null;
    if (!parsed || typeof parsed.home !== 'string' || typeof parsed.active !== 'string') {
      return null;
    }
    return {
      home: parsed.home,
      active: parsed.active,
      scope: parsed.scope === 'setup' ? 'setup' : 'full',
      lastSeenAt: typeof parsed.lastSeenAt === 'string' ? parsed.lastSeenAt : null,
      household: Array.isArray(parsed.household) ? parsed.household : [],
      stash: parsed.stash && typeof parsed.stash === 'object' ? parsed.stash : {}
    };
  } catch {
    return null;
  }
};

export const writeVault = (storage: Storage, vault: ProfileVault): void => {
  storage.setItem(VAULT_KEY, JSON.stringify(vault));
};

/** A vault for a device whose only profile is the account that signed in. */
export const homeVault = (username: string): ProfileVault => ({
  home: fold(username),
  active: fold(username),
  scope: 'full',
  lastSeenAt: null,
  household: [],
  stash: {}
});

const profileKeysIn = (storage: Storage): string[] => {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && (PROFILE_KEYS.includes(key) || PROFILE_KEY_PREFIXES.some(prefix => key.startsWith(prefix)))) {
      keys.push(key);
    }
  }
  return keys;
};

/**
 * Moves the profile in use aside, leaving the fixed names empty.
 *
 * Its storage name is the vault's `active`, so whichever profile comes next
 * starts from nothing of this one's.
 */
export const stashActive = (storage: Storage, vault: ProfileVault): ProfileVault => {
  const held: Record<string, string> = {};
  for (const key of profileKeysIn(storage)) {
    const value = storage.getItem(key);
    if (value !== null) {
      held[key] = value;
    }
    storage.removeItem(key);
  }
  return { ...vault, stash: { ...vault.stash, [vault.active]: held } };
};

/**
 * Makes a profile the one in use: its stashed keys back in place, or, for a
 * profile this device has not held before, the ones given.
 */
export const activate = (
  storage: Storage,
  vault: ProfileVault,
  name: string,
  scope: ProfileScope,
  fresh: Record<string, string> = {}
): ProfileVault => {
  const { [name]: held, ...rest } = vault.stash;
  for (const [key, value] of Object.entries(held ?? fresh)) {
    storage.setItem(key, value);
  }
  return { ...vault, active: name, scope, stash: rest };
};

/** What a stashed profile holds under one key, without making it the one in use. */
export const stashedValue = (vault: ProfileVault, name: string, key: string): string | null =>
  vault.stash[name]?.[key] ?? null;

/**
 * Everything this device holds for a profile, gone: its stash, and whatever is
 * kept under its name -- favourites, history, guide sources, sync cursors.
 */
export const forgetProfile = (storage: Storage, vault: ProfileVault, name: string): ProfileVault => {
  const named: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    const match = key ? NAMED_PREFIXES.exec(key) : null;
    if (key && match && match[2] === name) {
      named.push(key);
    }
  }
  for (const key of named) {
    storage.removeItem(key);
  }
  const { [name]: _forgotten, ...rest } = vault.stash;
  return { ...vault, stash: rest };
};

/**
 * Whether to ask who is watching when the app opens.
 *
 * Only on a device with somebody to choose between, and not when it was in
 * use in the last four hours -- standby, or an afternoon break, carries on as
 * whoever was there (board TV-20).
 */
export const shouldAskWhoIsWatching = (vault: ProfileVault | null): boolean =>
  vault !== null && vault.household.length > 0 && vault.scope !== 'setup';
