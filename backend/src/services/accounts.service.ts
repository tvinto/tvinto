import { db } from '../utils/database';
import { hashPassword, needsRehash, verifyPassword } from '../utils/passwords';
import { decryptSecret, encryptSecret } from '../utils/credentialCipher';
import {
  CURRENT_KDF,
  KEY_BYTES,
  KdfParams,
  SubmittedKeys,
  checkSubmittedKeys,
  disguisedSalt,
  formatVerifier,
  fromBase64,
  parseVerifier,
  sameVerifier,
  toBase64,
  verifierFor
} from '../../../shared/auth/accountKeys';
import { nodeKdf } from '../utils/nodeKdf';
import { accountSaltSecret } from '../utils/serverSecret';

/** An account of the user's own. Never carries the password hash outward. */
export interface User {
  id: number;
  username: string;
  createdAt: string;
}

/** A subscription belonging to a user. The secret is never included. */
export interface ProviderAccount {
  id: number;
  userId: number;
  label: string | null;
  serverUrl: string;
  xtreamUsername: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A subscription with its password, for the code that actually calls out. */
export interface ProviderCredentials {
  providerAccountId: number;
  userId: number;
  serverUrl: string;
  username: string;
  password: string;
}

export class AccountError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'AccountError';
  }
}

/** Long enough to be worth hashing; the rest is the user's business. */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/i;

// What a device may send, and which derivations are acceptable, live in
// shared/auth/accountKeys.ts. Both this server and the Worker decide it, and
// two of them disagreeing would mean an account enrollable on one and not the
// other -- found out by a person, on a device, at the worst moment.
export { SubmittedKeys } from '../../../shared/auth/accountKeys';

/** What a device needs before it can derive anything. */
export interface SaltAnswer extends KdfParams {
  salt: string;
}

const fold = (username: string): string => username.trim().toLowerCase();

const nowIso = () => new Date().toISOString();

interface UserRow {
  id: number;
  username: string;
  username_folded: string;
  password_hash: string;
  /** Null until a device has enrolled one. See migration 8. */
  auth_verifier: string | null;
  created_at: string;
}

interface ProviderRow {
  id: number;
  user_id: number;
  label: string | null;
  server_url: string;
  xtream_username: string;
  xtream_secret: string;
  active: number;
  created_at: string;
  updated_at: string;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  createdAt: row.created_at
});

const toProviderAccount = (row: ProviderRow): ProviderAccount => ({
  id: row.id,
  userId: row.user_id,
  label: row.label,
  serverUrl: row.server_url,
  xtreamUsername: row.xtream_username,
  active: row.active === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

/**
 * Accounts, and the subscriptions attached to them.
 *
 * The point of the split: a user is permanent and a subscription is not. Xtream
 * credentials expire and are reissued, and when that happens only the
 * provider_accounts row changes. Everything the user has built -- favourites,
 * ordering, history -- hangs off the user id and does not notice.
 */
class AccountsService {
  // --- Users --------------------------------------------------------------

  /**
   * Creates an account.
   *
   * Names are unique without regard to case, so "Petar" cannot quietly become a
   * second account alongside "petar".
   */
  async register(username: string, password: string, keys?: SubmittedKeys): Promise<User> {
    const trimmed = (username ?? '').trim();

    if (!USERNAME_PATTERN.test(trimmed)) {
      throw new AccountError(
        'Username must be 3 to 32 characters, using letters, numbers, dot, dash or underscore',
        400
      );
    }
    this.assertUsablePassword(password);

    if (this.findByUsername(trimmed)) {
      throw new AccountError('That username is taken', 409);
    }

    // A client that already derives its own keys sends them here, so making an
    // account is one round trip rather than a registration followed by an
    // enrolment. Checked before the account exists, so a rejected set of keys
    // leaves nothing behind.
    const enrolled = keys ? this.readKeys(keys) : null;

    const hash = await hashPassword(password);
    const verifier = enrolled
      ? formatVerifier({
          kdf: 'scrypt',
          params: enrolled.params,
          salt: enrolled.salt,
          verifier: await verifierFor(enrolled.auth, nodeKdf)
        })
      : null;
    const timestamp = nowIso();

    try {
      const result = db
        .prepare(
          `INSERT INTO users
             (username, username_folded, password_hash, auth_verifier, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(trimmed, fold(trimmed), hash, verifier, timestamp, timestamp);

      return { id: Number(result.lastInsertRowid), username: trimmed, createdAt: timestamp };
    } catch (error) {
      // Two registrations racing for the same name; the unique index decides.
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new AccountError('That username is taken', 409);
      }
      throw error;
    }
  }

  /**
   * Checks a username and password.
   *
   * Returns null for both an unknown user and a wrong password, so the response
   * cannot be used to find out which usernames exist. A hash still verifies
   * when it was made with older parameters, and is quietly upgraded on the way
   * through.
   */
  async authenticate(username: string, password: string): Promise<User | null> {
    const row = this.rowByUsername(username ?? '');
    if (!row || !password) {
      return null;
    }

    if (!(await verifyPassword(password, row.password_hash))) {
      return null;
    }

    if (needsRehash(row.password_hash)) {
      await this.storeHash(row.id, password);
    }

    return toUser(row);
  }

  findById(id: number): User | null {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  findByUsername(username: string): User | null {
    const row = this.rowByUsername(username);
    return row ? toUser(row) : null;
  }

  /** Whether any account exists, so the first run can offer to create one. */
  hasAnyUser(): boolean {
    const row = db.prepare('SELECT 1 FROM users LIMIT 1').get();
    return row !== undefined;
  }

  /**
   * Changes a password, requiring the current one.
   *
   * Deliberately not a "set password" -- knowing a session token should not be
   * enough to lock a user out of their own account.
   */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    keys?: SubmittedKeys
  ): Promise<void> {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
    if (!row) {
      throw new AccountError('No such account', 404);
    }

    if (!(await verifyPassword(currentPassword ?? '', row.password_hash))) {
      throw new AccountError('Current password is incorrect', 403);
    }

    this.assertUsablePassword(newPassword);
    // Checked before anything is written. A malformed set of keys must not
    // leave the password already changed and the account half moved.
    const rekeyed = keys ? this.readKeys(keys) : null;

    await this.storeHash(userId, newPassword);

    // The verifier was derived from the old password and can never match
    // again. A client that sent new keys has re-derived them itself, which is
    // the only place that can be done. One that did not gets the verifier
    // removed, which puts the account back on password sign-in rather than
    // leaving behind one that refuses everybody.
    if (rekeyed) {
      await this.storeKeys(userId, rekeyed);
    } else {
      this.clearAccountKeys(userId);
    }
  }

  // --- Keys the device derives --------------------------------------------

  /**
   * The salt and cost a device needs before it can derive anything.
   *
   * Unauthenticated, necessarily: signing in cannot begin without it. So an
   * unknown name gets an answer too, made from the server's secret and the
   * name -- deterministic like a real salt, and unguessable, so this cannot be
   * used to find out which accounts exist. The sign-in then fails at the
   * verifier, exactly as a wrong password does.
   *
   * An account that exists but has never enrolled is disguised the same way.
   * Telling those two apart would be the same leak wearing a different hat.
   */
  async saltFor(username: string): Promise<SaltAnswer> {
    const row = this.rowByUsername(username ?? '');
    const stored = row?.auth_verifier ? parseVerifier(row.auth_verifier) : null;

    if (stored) {
      return { salt: toBase64(stored.salt), ...stored.params };
    }

    const salt = await disguisedSalt(fold(username ?? ''), accountSaltSecret(), nodeKdf);
    return { salt: toBase64(salt), ...CURRENT_KDF };
  }

  /**
   * Checks a username against the key a device derived.
   *
   * The server hashes what it was sent rather than comparing it directly. That
   * is the difference between a database of verifiers and a database of
   * passwords: what is stored here cannot be replayed as a sign-in.
   *
   * Null for an unknown name, an account with no verifier, and a wrong key
   * alike -- the same silence `authenticate` keeps.
   */
  async authenticateWithVerifier(username: string, auth: string): Promise<User | null> {
    const row = this.rowByUsername(username ?? '');
    const stored = row?.auth_verifier ? parseVerifier(row.auth_verifier) : null;
    const sent = typeof auth === 'string' ? fromBase64(auth) : null;

    if (!row || !stored || !sent || sent.length !== KEY_BYTES) {
      return null;
    }

    const offered = await verifierFor(sent, nodeKdf);
    return sameVerifier(offered, stored.verifier) ? toUser(row) : null;
  }

  /**
   * Records the keys a device derived, for this account.
   *
   * Called on registration by a client that already knows how, and after an
   * old-style sign-in by one that has just learned. Replacing keys already
   * there takes the current password, as changePassword does: a session token
   * alone would otherwise turn into a sign-in of its own that outlives it.
   */
  async setAccountKeys(userId: number, keys: SubmittedKeys, currentPassword?: string): Promise<void> {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
    if (!row) {
      throw new AccountError('No such account', 404);
    }
    if (row.auth_verifier && !(await verifyPassword(currentPassword ?? '', row.password_hash))) {
      throw new AccountError('Replacing the keys takes the current password', 403);
    }
    await this.storeKeys(userId, this.readKeys(keys));
  }

  /** Puts an account back on password sign-in, for a password it no longer matches. */
  clearAccountKeys(userId: number): void {
    db.prepare('UPDATE users SET auth_verifier = NULL, updated_at = ? WHERE id = ?').run(
      nowIso(),
      userId
    );
  }

  /** Whether this account has been enrolled. Never exposed to a stranger. */
  hasAccountKeys(userId: number): boolean {
    const row = db.prepare('SELECT auth_verifier FROM users WHERE id = ?').get(userId) as
      | { auth_verifier: string | null }
      | undefined;
    return !!row?.auth_verifier;
  }

  // --- Subscriptions ------------------------------------------------------

  /**
   * Attaches a subscription to a user, replacing any previous credentials for
   * the same provider username.
   *
   * Re-adding the same username with a new password is the renewal case, and it
   * updates in place rather than accumulating a second row.
   */
  addProviderAccount(
    userId: number,
    details: { serverUrl: string; username: string; password: string; label?: string },
    verified = true
  ): ProviderAccount {
    const serverUrl = (details.serverUrl ?? '').trim();
    const username = (details.username ?? '').trim();

    if (!serverUrl || !username || !details.password) {
      throw new AccountError('Server URL, username and password are required', 400);
    }
    if (!this.findById(userId)) {
      throw new AccountError('No such account', 404);
    }

    // The catalogue, guide and sync state this backend caches are filed under
    // the provider username alone (utils/database.ts). Another account using
    // that username on a different server would be writing over, and reading,
    // this one's -- so a username already in use elsewhere on another server
    // is refused rather than shared.
    const elsewhere = db
      .prepare('SELECT 1 FROM provider_accounts WHERE xtream_username = ? AND user_id != ? AND server_url != ? LIMIT 1')
      .get(username, userId, serverUrl);
    if (elsewhere) {
      throw new AccountError('That provider username is already in use on this server with another provider', 409);
    }

    const secret = encryptSecret(details.password);
    const timestamp = nowIso();

    db.prepare(
      `INSERT INTO provider_accounts
         (user_id, label, server_url, xtream_username, xtream_secret, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, server_url, xtream_username) DO UPDATE SET
         xtream_secret = excluded.xtream_secret,
         label = COALESCE(excluded.label, provider_accounts.label),
         active = 1,
         updated_at = excluded.updated_at`
    ).run(userId, details.label ?? null, serverUrl, username, secret, timestamp, timestamp);

    const stored = db
      .prepare(
        'SELECT * FROM provider_accounts WHERE user_id = ? AND server_url = ? AND xtream_username = ?'
      )
      .get(userId, serverUrl, username) as ProviderRow;

    // Work done before accounts existed is keyed to the provider username.
    // Proving you hold those credentials is what entitles you to it -- proved,
    // so not on a subscription stored unverified.
    if (verified) {
      this.claimLegacyData(userId, username);
    }

    return toProviderAccount(stored);
  }

  listProviderAccounts(userId: number): ProviderAccount[] {
    const rows = db
      .prepare('SELECT * FROM provider_accounts WHERE user_id = ? ORDER BY active DESC, updated_at DESC')
      .all(userId) as ProviderRow[];
    return rows.map(toProviderAccount);
  }

  /**
   * The credentials to call the provider with, or null when there are none
   * usable.
   *
   * A secret that will not decrypt returns null rather than an empty password:
   * sending a blank password to the provider would look like a failed login
   * rather than like a key problem.
   */
  getActiveCredentials(userId: number): ProviderCredentials | null {
    const row = db
      .prepare(
        'SELECT * FROM provider_accounts WHERE user_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1'
      )
      .get(userId) as ProviderRow | undefined;

    if (!row) {
      return null;
    }

    const password = decryptSecret(row.xtream_secret);
    if (password === null) {
      console.warn(
        `Stored subscription ${row.id} could not be decrypted; it needs entering again`
      );
      return null;
    }

    return {
      providerAccountId: row.id,
      userId: row.user_id,
      serverUrl: row.server_url,
      username: row.xtream_username,
      password
    };
  }

  /**
   * Every usable subscription across every account.
   *
   * For background work, which serves whoever is stored rather than whoever
   * happens to be making a request. Anything that will not decrypt is skipped
   * with a warning rather than failing the whole sweep.
   */
  listActiveCredentials(): ProviderCredentials[] {
    const rows = db
      .prepare('SELECT * FROM provider_accounts WHERE active = 1 ORDER BY user_id, updated_at DESC')
      .all() as ProviderRow[];

    const usable: ProviderCredentials[] = [];
    const seen = new Set<number>();

    for (const row of rows) {
      // One subscription per account: the most recently updated, matching what
      // a request for that user would resolve to.
      if (seen.has(row.user_id)) {
        continue;
      }

      const password = decryptSecret(row.xtream_secret);
      if (password === null) {
        console.warn(`Skipping subscription ${row.id}: its stored secret could not be read`);
        continue;
      }

      seen.add(row.user_id);
      usable.push({
        providerAccountId: row.id,
        userId: row.user_id,
        serverUrl: row.server_url,
        username: row.xtream_username,
        password
      });
    }

    return usable;
  }

  /** Forgets a subscription. The user's own data is untouched. */
  removeProviderAccount(userId: number, providerAccountId: number): boolean {
    const result = db
      .prepare('DELETE FROM provider_accounts WHERE id = ? AND user_id = ?')
      .run(providerAccountId, userId);
    return result.changes > 0;
  }

  // --- Migration ----------------------------------------------------------

  /**
   * Adopts rows written before accounts existed.
   *
   * Everything the app stored was keyed by the provider username, which is why
   * an expiring subscription used to strand it. Rows for that username with no
   * owner are handed to the user who has just proved they hold the credentials.
   * Rows already owned are left alone, so this cannot take another user's work.
   */
  claimLegacyData(userId: number, xtreamUsername: string): number {
    const claim = db.transaction(() => {
      let claimed = 0;
      for (const table of ['favorites', 'sort_order', 'watch_progress']) {
        const result = db
          .prepare(`UPDATE ${table} SET user_id = ? WHERE username = ? AND user_id IS NULL`)
          .run(userId, xtreamUsername);
        claimed += result.changes;
      }
      return claimed;
    });

    const claimed = claim();
    if (claimed > 0) {
      console.info(`Claimed ${claimed} rows for user ${userId}`);
    }
    return claimed;
  }

  /** How many unowned rows exist for a provider username, without claiming them. */
  countLegacyData(xtreamUsername: string): number {
    let total = 0;
    for (const table of ['favorites', 'sort_order', 'watch_progress']) {
      const row = db
        .prepare(`SELECT COUNT(*) c FROM ${table} WHERE username = ? AND user_id IS NULL`)
        .get(xtreamUsername) as { c: number };
      total += row.c;
    }
    return total;
  }

  // --- Internals ----------------------------------------------------------

  private rowByUsername(username: string): UserRow | undefined {
    return db.prepare('SELECT * FROM users WHERE username_folded = ?').get(fold(username)) as
      | UserRow
      | undefined;
  }

  private assertUsablePassword(password: string): void {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new AccountError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        400
      );
    }
    // Hashing is deliberately slow, so an unbounded password is a way to make
    // the server do unbounded work.
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new AccountError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`, 400);
    }
  }

  /**
   * Checks what a device sent before any of it is written.
   *
   * The cost is the device's choice, because the whole point of moving the
   * work there was to let a television pick something it can afford. But a
   * client that chooses its own cost can choose a useless one, and a verifier
   * made at N=2 is a password sitting in the database under another name. The
   * floor is what stops that; the ceiling stops a device locking every other
   * device out of the account by picking a cost none of them can finish.
   */
  private readKeys(
    keys: SubmittedKeys | undefined
  ): { salt: Uint8Array; auth: Uint8Array; params: KdfParams } {
    const checked = checkSubmittedKeys(keys);
    if (!checked.ok) {
      throw new AccountError(checked.reason, 400);
    }
    return checked;
  }

  private async storeKeys(
    userId: number,
    checked: { salt: Uint8Array; auth: Uint8Array; params: KdfParams }
  ): Promise<void> {
    const record = formatVerifier({
      kdf: 'scrypt',
      params: checked.params,
      salt: checked.salt,
      // Hashed here, not on the device. What arrives is the key; what is kept
      // is a hash of it, so a copy of this table is not a set of sign-ins.
      verifier: await verifierFor(checked.auth, nodeKdf)
    });

    db.prepare('UPDATE users SET auth_verifier = ?, updated_at = ? WHERE id = ?').run(
      record,
      nowIso(),
      userId
    );
  }

  private async storeHash(userId: number, password: string): Promise<void> {
    const hash = await hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      hash,
      nowIso(),
      userId
    );
  }
}

export const accountsService = new AccountsService();
