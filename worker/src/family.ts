import {
  SubmittedKeys,
  checkSubmittedKeys,
  formatVerifier,
  fromBase64,
  verifierFor
} from '../../shared/auth/accountKeys';
import {
  FamilyManager,
  FamilyMember,
  FamilyRole,
  FamilyView,
  ManagedKey,
  SessionScope,
  isFamilyRole,
  isToolScope
} from '../../shared/family';
import { D1Database, D1PreparedStatement, Env, maybeText, number, text } from './d1';
import { HttpError, ok, readJson } from './http';
import { isProfilePicture } from '../../shared/profilePicture';
import { Caller, createSession, destroySessionsFor, endSessionsMintedBy } from './sessions';
import { claimInvite, releaseInvite, recordInviteUse } from './invites';
import { workerKdf } from './kdf';
import { now } from './clock';

/**
 * The family: accounts set up by the accounts above them.
 *
 * An account has a role and a manager, the account directly above it; the
 * accounts on the path above are its managers, and any of them may manage it.
 * What managing means is in shared/family.ts. This
 * file is the part that has to be enforced somewhere nobody can edit: who is
 * above whom, and what each may ask for.
 *
 * Nothing here can read a subscription or a guide. A manager sets those up
 * with the member's `enc`, which reaches it sealed for its own public key
 * (`managed_keys`) and is opened on its device.
 */

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/i;

const fold = (username: string): string => username.trim().toLowerCase();

/** Most accounts one call may hand keys for, comfortably under the query budget. */
const MOST_KEYS_PER_CALL = 20;

// --- The tree -------------------------------------------------------------

/** The accounts above this one, nearest first. */
const ancestorsOf = async (db: D1Database, userId: number): Promise<number[]> => {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE up(id, manager_id, depth) AS (
         SELECT id, manager_id, 0 FROM users WHERE id = ?
         UNION ALL
         SELECT users.id, users.manager_id, up.depth + 1
           FROM users JOIN up ON users.id = up.manager_id
          WHERE up.depth < 32
       )
       SELECT id FROM up WHERE depth > 0 ORDER BY depth`
    )
    .bind(userId)
    .all<{ id: number }>();
  return results.map(row => number(row.id));
};

/** The accounts below this one, at any depth. */
const descendantsOf = async (db: D1Database, userId: number): Promise<number[]> => {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE down(id, depth) AS (
         SELECT id, 1 FROM users WHERE manager_id = ?
         UNION ALL
         SELECT users.id, down.depth + 1 FROM users JOIN down ON users.manager_id = down.id
          WHERE down.depth < 32
       )
       SELECT id FROM down`
    )
    .bind(userId)
    .all<{ id: number }>();
  return results.map(row => number(row.id));
};

/** Refuses unless the caller is above this account. */
const requireManagerOf = async (db: D1Database, caller: Caller, memberId: number): Promise<void> => {
  if (!Number.isInteger(memberId) || memberId === caller.userId) {
    throw new HttpError('No such account in your family', 404);
  }
  const above = await ancestorsOf(db, memberId);
  if (!above.includes(caller.userId)) {
    // The same answer as an account that does not exist: whether some other
    // family has an account with this number is none of the caller's business.
    throw new HttpError('No such account in your family', 404);
  }
};

/**
 * The account itself, at its own device or through its own tool -- not a
 * manager acting for it. What a tool may not do here, the router refuses
 * before it gets this far (index.ts, `refusal`).
 */
const requireOwnSession = (caller: Caller): void => {
  if (caller.scope !== 'full' && !isToolScope(caller.scope)) {
    throw new HttpError('Setting somebody up does not include their family', 403);
  }
};

/**
 * The account's own sign-in, for moving it between families: a session a
 * manager made -- a household profile on the manager's television -- is the
 * manager at the account, and must not take it out of the manager's reach.
 */
const requireSignedInItself = (caller: Caller): void => {
  requireOwnSession(caller);
  if (caller.mintedBy) {
    throw new HttpError('Only the account itself can leave or join a family', 403);
  }
};

/** An admin at its own device: the only caller who may manage accounts. */
const requireAdmin = (caller: Caller): void => {
  requireOwnSession(caller);
  if (caller.role !== 'admin') {
    throw new HttpError('Only an admin can add or change accounts in a family', 403);
  }
};

// --- Reading --------------------------------------------------------------

export const getFamily = async (env: Env, caller: Caller): Promise<Response> => {
  // A tool reads it as the account's own device does, keys included: they
  // are sealed under the account's `enc`, which the tool holds anyway, and
  // setting a member up needs them.
  requireOwnSession(caller);
  const db = env.DB;

  const me = await db
    .prepare(
      `SELECT users.id, users.username, users.role, users.manager_id, users.household, users.picture,
              account_keys.public_key, account_keys.sealed_private_key
         FROM users LEFT JOIN account_keys ON account_keys.user_id = users.id
        WHERE users.id = ?`
    )
    .bind(caller.userId)
    .first<Record<string, unknown>>();

  if (!me) {
    throw new HttpError('No such account', 404);
  }

  const managerIds = await ancestorsOf(db, caller.userId);
  const managers: FamilyManager[] = [];
  if (managerIds.length) {
    const { results } = await db
      .prepare(
        `SELECT users.id, users.username, account_keys.public_key,
                EXISTS (SELECT 1 FROM managed_keys
                         WHERE managed_keys.member_id = ? AND managed_keys.manager_id = users.id) AS holds
           FROM users LEFT JOIN account_keys ON account_keys.user_id = users.id
          WHERE users.id IN (${managerIds.map(() => '?').join(',')})`
      )
      .bind(caller.userId, ...managerIds)
      .all<Record<string, unknown>>();
    const byId = new Map(results.map(row => [number(row['id']), row]));
    for (const id of managerIds) {
      const row = byId.get(id);
      if (row) {
        managers.push({
          id,
          username: text(row['username']),
          publicKey: maybeText(row['public_key']),
          holdsMyKey: number(row['holds']) === 1
        });
      }
    }
  }

  // Members and kids manage nobody, so nobody below them is theirs to see.
  const members: FamilyMember[] = [];
  if (me['role'] === 'admin') {
    const { results } = await db
      .prepare(
        `WITH RECURSIVE down(id, depth) AS (
           SELECT id, 1 FROM users WHERE manager_id = ?
           UNION ALL
           SELECT users.id, down.depth + 1 FROM users JOIN down ON users.manager_id = down.id
            WHERE down.depth < 32
         )
         SELECT users.id, users.username, users.role, users.manager_id, users.household, users.picture, users.created_at,
                account_keys.public_key,
                (SELECT sealed_enc FROM managed_keys
                  WHERE managed_keys.member_id = users.id AND managed_keys.manager_id = ?) AS sealed_enc,
                (SELECT MAX(last_used_at) FROM sessions
                  WHERE sessions.user_id = users.id AND sessions.scope = 'full') AS last_used_at,
                (SELECT COUNT(*) FROM sessions
                  WHERE sessions.user_id = users.id AND sessions.scope = 'full') AS devices
           FROM down JOIN users ON users.id = down.id
           LEFT JOIN account_keys ON account_keys.user_id = users.id
          ORDER BY down.depth, users.username_folded`
      )
      .bind(caller.userId, caller.userId)
      .all<Record<string, unknown>>();

    for (const row of results) {
      members.push({
        id: number(row['id']),
        username: text(row['username']),
        role: isFamilyRole(row['role']) ? row['role'] : 'kid',
        managerId: number(row['manager_id']),
        household: number(row['household']) === 1,
        picture: maybeText(row['picture']),
        createdAt: text(row['created_at']),
        lastUsedAt: maybeText(row['last_used_at']),
        devices: number(row['devices']),
        publicKey: maybeText(row['public_key']),
        sealedEnc: maybeText(row['sealed_enc'])
      });
    }
  }

  const view: FamilyView = {
    me: {
      id: caller.userId,
      username: text(me['username']),
      role: isFamilyRole(me['role']) ? me['role'] : 'kid',
      managerId: me['manager_id'] === null ? null : number(me['manager_id']),
      household: number(me['household']) === 1,
      picture: maybeText(me['picture']),
      publicKey: maybeText(me['public_key']),
      sealedPrivateKey: maybeText(me['sealed_private_key'])
    },
    managers,
    members
  };

  return ok(view);
};

// --- Keys -----------------------------------------------------------------

const isPublicKey = (value: unknown): value is string =>
  typeof value === 'string' && fromBase64(value)?.length === 65;

const isSealedText = (value: unknown, prefix: string): value is string =>
  typeof value === 'string' && value.startsWith(prefix) && value.length < 4096;

/**
 * Stores the caller's key pair.
 *
 * A new public key makes every `enc` sealed for the old one unopenable, so
 * those go: the members' own devices, or other managers, seal them again.
 */
export const saveOwnKey = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  requireOwnSession(caller);
  const body = await readJson<{ publicKey?: unknown; sealedPrivateKey?: unknown }>(request);
  if (!isPublicKey(body.publicKey) || !isSealedText(body.sealedPrivateKey, 'sb1$')) {
    throw new HttpError('A public key and a sealed private key are required', 400);
  }

  await writeKeyPair(env.DB, caller.userId, body.publicKey, body.sealedPrivateKey);
  return ok({ saved: true });
};

const writeKeyPair = async (
  db: D1Database,
  userId: number,
  publicKey: string,
  sealedPrivateKey: string
): Promise<void> => {
  const existing = await db
    .prepare('SELECT public_key FROM account_keys WHERE user_id = ?')
    .bind(userId)
    .first<{ public_key: string }>();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO account_keys (user_id, public_key, sealed_private_key, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           public_key = excluded.public_key,
           sealed_private_key = excluded.sealed_private_key,
           updated_at = excluded.updated_at`
      )
      .bind(userId, publicKey, sealedPrivateKey, now())
  ];
  if (existing && existing.public_key !== publicKey) {
    statements.push(db.prepare('DELETE FROM managed_keys WHERE manager_id = ?').bind(userId));
  }
  await db.batch(statements);
};

/** Checks a list of managed keys and turns it into statements. */
const managedKeyStatements = async (
  db: D1Database,
  caller: Caller,
  keys: unknown
): Promise<D1PreparedStatement[]> => {
  if (!Array.isArray(keys) || keys.length > MOST_KEYS_PER_CALL) {
    throw new HttpError(`Between 0 and ${MOST_KEYS_PER_CALL} keys at a time`, 400);
  }

  const above = new Map<number, number[]>();
  const statements: D1PreparedStatement[] = [];
  const at = now();

  for (const entry of keys as Partial<ManagedKey>[]) {
    const memberId = Number(entry?.memberId);
    const managerId = Number(entry?.managerId);
    if (!Number.isInteger(memberId) || !Number.isInteger(managerId) || !isSealedText(entry?.sealedEnc, 'pk1$')) {
      throw new HttpError('Each key needs a member, a manager and a sealed key', 400);
    }

    if (!above.has(memberId)) {
      above.set(memberId, await ancestorsOf(db, memberId));
    }
    const managers = above.get(memberId) ?? [];

    // Only a key the caller could have: its own, or one it holds as a manager.
    if (memberId !== caller.userId && !managers.includes(caller.userId)) {
      throw new HttpError('No such account in your family', 404);
    }
    // And only for somebody actually above that account.
    if (!managers.includes(managerId)) {
      throw new HttpError('That account does not manage this one', 400);
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO managed_keys (member_id, manager_id, sealed_enc, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(member_id, manager_id) DO UPDATE SET
             sealed_enc = excluded.sealed_enc,
             updated_at = excluded.updated_at`
        )
        .bind(memberId, managerId, entry.sealedEnc, at)
    );
  }

  return statements;
};

/** Hands an account's `enc` up to the accounts above it, sealed for each. */
export const saveManagedKeys = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  requireOwnSession(caller);
  const body = await readJson<{ keys?: unknown }>(request);
  const statements = await managedKeyStatements(env.DB, caller, body.keys);
  if (statements.length) {
    await env.DB.batch(statements);
  }
  return ok({ saved: statements.length });
};

// --- Adding and changing accounts -----------------------------------------

interface NewAccountBody {
  username?: string;
  keys?: SubmittedKeys;
  role?: unknown;
  household?: unknown;
  publicKey?: unknown;
  sealedPrivateKey?: unknown;
  managedKeys?: unknown;
}

const acceptKeys = (keys: SubmittedKeys | undefined) => {
  const checked = checkSubmittedKeys(keys);
  if (!checked.ok) {
    throw new HttpError(checked.reason, 400);
  }
  return checked;
};

const verifierOf = async (keys: SubmittedKeys | undefined): Promise<string> => {
  const checked = acceptKeys(keys);
  return formatVerifier({
    kdf: 'scrypt',
    params: checked.params,
    salt: checked.salt,
    verifier: await verifierFor(checked.auth, workerKdf)
  });
};

/**
 * Makes an account below the caller.
 *
 * The caller's device chose the first password, derived the new account's
 * keys from it and made its key pair; what arrives is what registering sends,
 * plus the key pair and the new `enc` sealed for every manager above it,
 * the caller included. So the account can be set up at once, before its owner
 * has ever signed in.
 */
export const addMember = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  requireAdmin(caller);
  const body = await readJson<NewAccountBody>(request);
  const username = (body.username ?? '').trim();

  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(
      'Username must be 3 to 32 characters, using letters, numbers, dot, dash or underscore',
      400
    );
  }
  const role: FamilyRole = isFamilyRole(body.role) ? body.role : 'member';
  if (!isPublicKey(body.publicKey) || !isSealedText(body.sealedPrivateKey, 'sb1$')) {
    throw new HttpError('A public key and a sealed private key are required', 400);
  }
  const verifier = await verifierOf(body.keys);

  const at = now();
  const created = await env.DB.prepare(
    `INSERT INTO users (username, username_folded, auth_verifier, created_at, updated_at, role, manager_id, household)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(username_folded) DO NOTHING
     RETURNING id`
  )
    .bind(username, fold(username), verifier, at, at, role, caller.userId, body.household === true ? 1 : 0)
    .first<{ id: number }>();

  if (!created) {
    throw new HttpError('That username is taken', 409);
  }

  const memberId = number(created.id);
  await writeKeyPair(env.DB, memberId, body.publicKey, body.sealedPrivateKey);

  // Keyed to the new account; the caller can only have sealed them for it.
  const keys = Array.isArray(body.managedKeys)
    ? (body.managedKeys as Partial<ManagedKey>[]).map(entry => ({ ...entry, memberId }))
    : [];
  const statements = await managedKeyStatements(env.DB, caller, keys);
  if (statements.length) {
    await env.DB.batch(statements);
  }

  return ok({ id: memberId, username, role, createdAt: at }, 201);
};

/** Changes an account's role, or whether it is a profile on its managers' devices. */
export const changeMember = async (
  request: Request,
  env: Env,
  caller: Caller,
  memberId: number
): Promise<Response> => {
  requireAdmin(caller);
  await requireManagerOf(env.DB, caller, memberId);
  const body = await readJson<{ role?: unknown; household?: unknown; picture?: unknown }>(request);

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.role !== undefined) {
    if (!isFamilyRole(body.role)) {
      throw new HttpError('A role is admin, member or kid', 400);
    }
    sets.push('role = ?');
    values.push(body.role);
  }
  if (body.household !== undefined) {
    if (typeof body.household !== 'boolean') {
      throw new HttpError('household is true or false', 400);
    }
    sets.push('household = ?');
    values.push(body.household ? 1 : 0);
  }
  if (body.picture !== undefined) {
    if (!isProfilePicture(body.picture)) {
      throw new HttpError('A picture is an animal, a small JPEG, PNG or WebP, or null', 400);
    }
    sets.push('picture = ?');
    values.push(body.picture);
  }
  if (!sets.length) {
    throw new HttpError('Nothing to change', 400);
  }

  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...values, now(), memberId)
    .run();
  // What the change takes away, it takes away from sessions already made: an
  // account no longer an admin keeps nothing it made on others, and one no
  // longer in the household is no longer a profile on its managers' devices.
  if (body.role !== undefined && body.role !== 'admin') {
    await endSessionsMintedBy(env.DB, memberId);
  }
  if (body.household === false) {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND scope = 'full' AND minted_by IS NOT NULL")
      .bind(memberId)
      .run();
  }

  return ok({ changed: true });
};

/**
 * A session as an account below the caller.
 *
 * `setup` for setting it up -- its setup, never what it watched -- and `full`
 * only for an account in the household, which is a profile on the caller's
 * own devices and so is somebody sitting at the same television.
 */
export const memberSession = async (
  request: Request,
  env: Env,
  caller: Caller,
  memberId: number
): Promise<Response> => {
  requireOwnSession(caller);
  if (caller.role !== 'admin') {
    throw new HttpError('Only an admin can set up or switch to another account', 403);
  }
  await requireManagerOf(env.DB, caller, memberId);
  const body = await readJson<{ scope?: unknown }>(request);
  const scope: SessionScope = body.scope === 'full' ? 'full' : 'setup';
  // A tool sets a member up; it never becomes the member.
  if (scope === 'full' && isToolScope(caller.scope)) {
    throw new HttpError('A tool can set an account up, not sign in as it', 403);
  }

  if (scope === 'full') {
    const row = await env.DB.prepare('SELECT household FROM users WHERE id = ?')
      .bind(memberId)
      .first<{ household: number }>();
    if (number(row?.household) !== 1) {
      throw new HttpError('Only an account in your household is a profile on your devices', 403);
    }
  }

  const token = await createSession(env.DB, memberId, scope, null, {
    userId: caller.userId,
    sessionId: caller.sessionId,
    tool: isToolScope(caller.scope)
  });
  return ok({ token, scope });
};

/**
 * A new password for an account below the caller, which forgot its own.
 *
 * The caller's device has already sealed the account's subscription and
 * guides again under the new `enc`, through a setup session. What arrives
 * here is the new verifier, a new key pair (the old private key was sealed
 * under the forgotten password), and the new `enc` for the managers. Every
 * session the account had ends, as a password change ends them.
 */
export const resetMemberPassword = async (
  request: Request,
  env: Env,
  caller: Caller,
  memberId: number
): Promise<Response> => {
  requireAdmin(caller);
  await requireManagerOf(env.DB, caller, memberId);
  const body = await readJson<NewAccountBody>(request);
  if (!isPublicKey(body.publicKey) || !isSealedText(body.sealedPrivateKey, 'sb1$')) {
    throw new HttpError('A public key and a sealed private key are required', 400);
  }
  const verifier = await verifierOf(body.keys);

  const keys = Array.isArray(body.managedKeys)
    ? (body.managedKeys as Partial<ManagedKey>[]).map(entry => ({ ...entry, memberId }))
    : [];
  const keyStatements = await managedKeyStatements(env.DB, caller, keys);

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET auth_verifier = ?, updated_at = ? WHERE id = ?').bind(verifier, now(), memberId),
    // The old enc, sealed for every manager, opens nothing any more.
    env.DB.prepare('DELETE FROM managed_keys WHERE member_id = ?').bind(memberId),
    ...keyStatements
  ]);
  await writeKeyPair(env.DB, memberId, body.publicKey, body.sealedPrivateKey);
  await destroySessionsFor(env.DB, memberId);

  return ok({ reset: true });
};

/**
 * Takes an account out of the family. It keeps everything of its own, becomes
 * an admin with nobody above it, and the accounts that were above it lose its
 * key -- and the keys of anybody below it.
 */
const release = async (db: D1Database, memberId: number): Promise<void> => {
  const above = await ancestorsOf(db, memberId);
  const below = await descendantsOf(db, memberId);
  const affected = [memberId, ...below];

  const statements: D1PreparedStatement[] = [
    db
      .prepare("UPDATE users SET manager_id = NULL, role = 'admin', household = 0, updated_at = ? WHERE id = ?")
      .bind(now(), memberId)
  ];
  if (above.length) {
    statements.push(
      db
        .prepare(
          `DELETE FROM managed_keys
            WHERE member_id IN (${affected.map(() => '?').join(',')})
              AND manager_id IN (${above.map(() => '?').join(',')})`
        )
        .bind(...affected, ...above)
    );
  }
  // Sessions the managers held as it -- setup, and a household profile -- end
  // with its place in the family.
  statements.push(
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND (scope = 'setup' OR minted_by IS NOT NULL)").bind(memberId)
  );
  await db.batch(statements);
};

export const releaseMember = async (env: Env, caller: Caller, memberId: number): Promise<Response> => {
  requireAdmin(caller);
  await requireManagerOf(env.DB, caller, memberId);
  await release(env.DB, memberId);
  return ok({ released: true });
};

/** A member leaving on its own. A kid cannot: it changes nothing about itself. */
export const leaveFamily = async (env: Env, caller: Caller): Promise<Response> => {
  requireSignedInItself(caller);
  if (caller.role === 'kid') {
    throw new HttpError('Ask whoever set up this account', 403);
  }
  await release(env.DB, caller.userId);
  return ok({ released: true });
};

/**
 * Deletes an account below the caller, and everything it had.
 *
 * Anybody below it moves up to its manager rather than going with it.
 */
export const deleteMember = async (env: Env, caller: Caller, memberId: number): Promise<Response> => {
  requireAdmin(caller);
  await requireManagerOf(env.DB, caller, memberId);

  const row = await env.DB.prepare('SELECT manager_id FROM users WHERE id = ?')
    .bind(memberId)
    .first<{ manager_id: number }>();

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET manager_id = ? WHERE manager_id = ?').bind(row?.manager_id ?? null, memberId),
    env.DB.prepare('DELETE FROM sessions WHERE minted_by = ?').bind(memberId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(memberId)
  ]);

  return ok({ deleted: true });
};

/**
 * An account that already exists joining the family of whoever made an invite.
 *
 * It comes in as a member, or as an admin if it has accounts of its own below
 * it, which come with it. Its device then seals its `enc` for its new
 * managers, as any member's does.
 */
export const joinFamily = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  requireSignedInItself(caller);
  if (caller.role === 'kid') {
    throw new HttpError('Ask whoever set up this account', 403);
  }
  const body = await readJson<{ invite?: unknown }>(request);
  const typed = typeof body.invite === 'string' ? body.invite.trim() : '';
  if (!typed) {
    throw new HttpError('An invite code is required', 400);
  }

  const claimed = await claimInvite(env.DB, typed);
  if (!claimed) {
    throw new HttpError('That invite code is not valid. It may have been used, cancelled or run out.', 403);
  }

  const inviter = claimed.createdBy;
  // As at registration: an invite brings somebody in under an admin, so one
  // made by an account that is no longer an admin brings nobody in.
  const inviterRow = await env.DB.prepare('SELECT role FROM users WHERE id = ?')
    .bind(inviter)
    .first<{ role: string }>();
  if (inviterRow?.role !== 'admin') {
    await releaseInvite(env.DB, claimed.id);
    throw new HttpError('That invite is not valid any more', 403);
  }
  const below = await descendantsOf(env.DB, caller.userId);
  if (inviter === caller.userId || below.includes(inviter)) {
    await releaseInvite(env.DB, claimed.id);
    throw new HttpError('That invite is from your own family', 409);
  }

  await release(env.DB, caller.userId);
  await env.DB.prepare('UPDATE users SET manager_id = ?, role = ?, updated_at = ? WHERE id = ?')
    .bind(inviter, below.length ? 'admin' : 'member', now(), caller.userId)
    .run();
  await recordInviteUse(env.DB, claimed.id, caller.userId);

  return ok({ joined: true, managerId: inviter });
};
