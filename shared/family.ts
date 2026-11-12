import { ChangeKind, ChangeSet } from './sync';

/**
 * The family: accounts set up by the account above them.
 *
 * Shared by the sync service, which enforces it, and the apps, which show it.
 */

/**
 * What an account may do.
 *
 * - `admin`: everything, including adding and managing accounts below it.
 *   Every account that existed before families is one, with nobody above it.
 * - `member`: everything about its own account, nothing about anybody else's.
 * - `kid`: watches and favourites. Anything else is set by the accounts above.
 */
export type FamilyRole = 'admin' | 'member' | 'kid';

export const FAMILY_ROLES: readonly FamilyRole[] = ['admin', 'member', 'kid'];

export const isFamilyRole = (value: unknown): value is FamilyRole =>
  typeof value === 'string' && (FAMILY_ROLES as readonly string[]).includes(value);

/**
 * What a session is for.
 *
 * - `full`: the account itself, on its own device or as a profile picked on a
 *   shared one.
 * - `setup`: somebody above it setting it up. Sees and changes the account's
 *   setup -- providers, guides, matches, settings -- and never its
 *   favourites or what it watched.
 * - `tool`: the tvinto CLI, or an agent through it. The
 *   account's setup, as `setup` -- but its own account, so within what its
 *   role allows -- and the family's roles, setup and invites. Never the
 *   password; adding, removing or resetting a member, and the lock, only by
 *   asking the app.
 * - `tool-history`: the same, with favourites and watch history, when that
 *   was allowed at sign-in.
 */
export type SessionScope = 'full' | 'setup' | 'tool' | 'tool-history';

export const SESSION_SCOPES: readonly SessionScope[] = ['full', 'setup', 'tool', 'tool-history'];

/** Whether a session is the tvinto tool's. */
export const isToolScope = (scope: SessionScope): boolean => scope === 'tool' || scope === 'tool-history';

/** What a setup session reads and writes in the change feed. */
export const SETUP_KINDS: readonly ChangeKind[] = ['arrangement', 'setting', 'guideSource', 'channelMapping'];

/** What a kid's own devices may change. Everything else is set from above. */
export const KID_KINDS: readonly ChangeKind[] = ['favourite', 'progress'];

/** The change-set fields, by the kind each holds. */
export const CHANGE_FIELDS: Record<ChangeKind, keyof Omit<ChangeSet, 'deletions'>> = {
  favourite: 'favourites',
  arrangement: 'arrangements',
  progress: 'progress',
  setting: 'settings',
  guideSource: 'guideSources',
  channelMapping: 'channelMappings'
};

/**
 * The kinds a caller may read, or every kind. A kid reads everything of its
 * own -- what was set up for it above all -- and only a setup session is
 * kept from favourites and history.
 */
export const kindsVisible = (scope: SessionScope): readonly ChangeKind[] | null =>
  scope === 'setup' || scope === 'tool' ? SETUP_KINDS : null;

/**
 * The kinds a caller may change, or every kind.
 *
 * A tool works for the account itself, so a kid's tool changes no more than
 * the kid could: nothing at all without history, and only its favourites and
 * history with it.
 */
export const kindsAllowed = (role: FamilyRole, scope: SessionScope): readonly ChangeKind[] | null => {
  if (scope === 'setup') {
    return SETUP_KINDS;
  }
  if (scope === 'tool') {
    return role === 'kid' ? [] : SETUP_KINDS;
  }
  return role === 'kid' ? KID_KINDS : null;
};

/**
 * The settings that make up the parental lock: the PIN, the locked
 * categories and the age limit. A tool may add to the lock, but loosening it
 * -- the PIN changed or removed, a category unlocked, the age limit raised --
 * is the app's, where a person types the PIN; a tool can only ask for it
 * ('pin-off', worker/src/toolActions.ts). The same holds for a session a tool
 * made (worker/src/sync.ts, `loosensLock`).
 */
export const LOCK_SETTINGS: readonly string[] = ['parentalLock', 'lockedCategories', 'ageLock'];

/** Whether a change set writes or deletes any part of the parental lock. */
export const touchesLock = (batch: Partial<ChangeSet>): boolean =>
  (batch.settings ?? []).some(setting => LOCK_SETTINGS.includes(setting?.key)) ||
  (batch.deletions ?? []).some(deletion => deletion?.kind === 'setting' && LOCK_SETTINGS.includes(deletion.key));

/** A change set with only the kinds allowed left in it, and how many were taken out. */
export const onlyKinds = (
  batch: Partial<ChangeSet>,
  allowed: readonly ChangeKind[] | null
): { batch: Partial<ChangeSet>; dropped: number } => {
  if (!allowed) {
    return { batch, dropped: 0 };
  }

  let dropped = 0;
  const kept: Partial<ChangeSet> = {};
  for (const [kind, field] of Object.entries(CHANGE_FIELDS) as [ChangeKind, keyof ChangeSet][]) {
    const list = (batch[field] ?? []) as unknown[];
    if (allowed.includes(kind)) {
      (kept as Record<string, unknown[]>)[field] = list;
    } else {
      dropped += list.length;
    }
  }

  const deletions = batch.deletions ?? [];
  kept.deletions = deletions.filter(deletion => allowed.includes(deletion.kind));
  dropped += deletions.length - kept.deletions.length;

  return { batch: kept, dropped };
};

/** An account below the caller, as the family page shows it. */
export interface FamilyMember {
  id: number;
  username: string;
  role: FamilyRole;
  /** The account directly above it. */
  managerId: number;
  /** Whether it shows as a profile to pick on its managers' own devices. */
  household: boolean;
  /** Its profile picture (profilePicture.ts); null for the one from its name. */
  picture?: string | null;
  createdAt: string;
  /** The last time any of its devices was used, or null if it never signed in. */
  lastUsedAt: string | null;
  /** Devices signed in to it now. */
  devices: number;
  /** Its public key, once one of its devices has made one. */
  publicKey: string | null;
  /** Its `enc`, sealed for the caller's public key -- what lets the caller set it up. */
  sealedEnc: string | null;
}

/** One of the accounts above the caller. */
export interface FamilyManager {
  id: number;
  username: string;
  publicKey: string | null;
  /** Whether the caller's `enc` has been sealed for this one yet. */
  holdsMyKey: boolean;
}

/** GET /api/family. */
export interface FamilyView {
  me: {
    id: number;
    username: string;
    role: FamilyRole;
    managerId: number | null;
    household: boolean;
    /** Its profile picture (profilePicture.ts); null for the one from its name. */
    picture?: string | null;
    publicKey: string | null;
    /** The private half, sealed under the caller's own `enc`. */
    sealedPrivateKey: string | null;
  };
  /** Nearest first. */
  managers: FamilyManager[];
  /** Everyone below the caller, at any depth. Empty for members and kids. */
  members: FamilyMember[];
}

/** An account's `enc`, sealed for one of the accounts above it. */
export interface ManagedKey {
  memberId: number;
  managerId: number;
  sealedEnc: string;
}
