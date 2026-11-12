import {
  CURRENT_KDF,
  KEY_BYTES,
  SubmittedKeys,
  checkSubmittedKeys,
  disguisedSalt,
  formatVerifier,
  fromBase64,
  parseVerifier,
  sameVerifier,
  toBase64,
  verifierFor
} from '../../shared/auth/accountKeys';
import { D1Database, Env } from './d1';
import { HttpError, ok, readJson } from './http';
import { isProfilePicture } from '../../shared/profilePicture';
import { bearerToken, createSession, createSignInSession, hashToken } from './sessions';
import { claimInvite, recordInviteUse, releaseInvite } from './invites';
import { workerKdf } from './kdf';
import { now } from './clock';
import { countFailedTry, forgetFailedTries, refuseIfTooManyTries, tryKeys } from './signInLimit';

/**
 * Accounts, without a password anywhere in them.
 *
 * The device derives the key and sends it; this keeps a hash of that. So there
 * is no `hashPassword` here, no `verifyPassword`, and nothing in the database
 * that could be replayed as a sign-in -- which is what makes accounts fit in a
 * Worker at all, since scrypt does not.
 */

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/i;

const fold = (username: string): string => username.trim().toLowerCase();

interface UserRow {
  id: number;
  username: string;
  auth_verifier: string;
}

const findUser = (db: D1Database, username: string): Promise<UserRow | null> =>
  db
    .prepare('SELECT id, username, auth_verifier FROM users WHERE username_folded = ?')
    .bind(fold(username ?? ''))
    .first<UserRow>();

/**
 * The secret behind the salts handed out for names with no account.
 *
 * Refused rather than generated when it is missing. A Worker has nowhere to
 * keep something it generated -- the next isolate would make a different one,
 * and a salt that changes between two asks answers, on its own, the question
 * the disguise exists to refuse.
 */
const saltSecret = (env: Env): Uint8Array => {
  const configured = env.ACCOUNT_SALT_SECRET?.trim();
  const decoded = configured ? fromBase64(configured) : null;

  if (!decoded || decoded.length < 32) {
    throw new HttpError('This service is missing ACCOUNT_SALT_SECRET', 500);
  }

  return decoded;
};

/**
 * The salt and cost a device needs before it can derive anything.
 *
 * Open, necessarily: signing in cannot begin without it. So a name with no
 * account is answered as fully as one with an account, from the server secret
 * and the name -- the same every time, and unguessable. The sign-in then fails
 * at the verifier, exactly as a wrong password does.
 */
export const accountSalt = async (request: Request, env: Env): Promise<Response> => {
  const username = (new URL(request.url).searchParams.get('username') ?? '').trim();

  if (!username) {
    throw new HttpError('A username is required', 400);
  }

  const user = await findUser(env.DB, username);
  const stored = user ? parseVerifier(user.auth_verifier) : null;

  if (stored) {
    return ok({ salt: toBase64(stored.salt), ...stored.params });
  }

  const salt = await disguisedSalt(fold(username), saltSecret(env), workerKdf);
  return ok({ salt: toBase64(salt), ...CURRENT_KDF });
};

/** Turns a refusal from the shared policy into a 400 with its reason. */
const acceptKeys = (keys: SubmittedKeys | undefined) => {
  const checked = checkSubmittedKeys(keys);
  if (!checked.ok) {
    throw new HttpError(checked.reason, 400);
  }
  return checked;
};

const registrationClosed = async (env: Env): Promise<boolean> => {
  const setting = (env.ACCOUNT_REGISTRATION ?? '').trim().toLowerCase();
  if (setting === 'closed') {
    return true;
  }
  if (setting !== 'first-only') {
    return false;
  }

  // Open exactly until it has been used once.
  const existing = await env.DB.prepare('SELECT 1 AS present FROM users LIMIT 1').first();
  return existing !== null;
};

/**
 * What the sign-in page is told about making an account here: `open`, or
 * `invite` when a code is needed. `invite` too when the database cannot be
 * asked -- the cautious answer costs a field, the other a refusal.
 */
export const registrationMode = async (env: Env): Promise<'open' | 'invite'> => {
  try {
    return (await registrationClosed(env)) ? 'invite' : 'open';
  } catch {
    return 'invite';
  }
};

/**
 * Creates an account.
 *
 * Takes the keys in the same request, because there is nothing else it could
 * take. A `password` field from a device still talking to the old backend is
 * ignored rather than refused -- it is harmless, and refusing it would break a
 * client for sending something this service simply has no use for.
 */
export const register = async (request: Request, env: Env): Promise<Response> => {
  const body = await readJson<{ username?: string; keys?: SubmittedKeys; invite?: string }>(request);
  const username = (body.username ?? '').trim();
  const invite = typeof body.invite === 'string' ? body.invite.trim() : '';

  // Closed means closed to anybody without an invite code (src/invites.ts).
  if (!invite && (await registrationClosed(env))) {
    throw new HttpError('Accounts need an invite code here. Ask someone who has an account for one.', 403);
  }

  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(
      'Username must be 3 to 32 characters, using letters, numbers, dot, dash or underscore',
      400
    );
  }

  const keys = acceptKeys(body.keys);
  const verifier = formatVerifier({
    kdf: 'scrypt',
    params: keys.params,
    salt: keys.salt,
    // Hashed here, not on the device. What arrives is the key; what is kept is
    // a hash of it.
    verifier: await verifierFor(keys.auth, workerKdf)
  });

  // A wrong invite code counts as a wrong try, as a wrong password does
  // (signInLimit.ts): codes cannot be guessed one after another either.
  const at = now();
  const tries = invite ? await tryKeys(request, '') : null;
  if (tries) {
    await refuseIfTooManyTries(env.DB, tries, at);
  }

  // Claimed only now, once everything that could refuse the request has had
  // its say, so a typo in the username does not spend the code.
  const claimed = invite ? await claimInvite(env.DB, invite) : null;
  const inviteId = claimed?.id ?? null;
  if (tries && inviteId === null) {
    await countFailedTry(env.DB, tries, at);
    throw new HttpError('That invite code is not valid. It may have been used, cancelled or run out.', 403);
  }

  const created = await env.DB.prepare(
    `INSERT INTO users (username, username_folded, auth_verifier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(username_folded) DO NOTHING
     RETURNING id`
  )
    .bind(username, fold(username), verifier, at, at)
    .first<{ id: number }>();

  // Nothing came back, so the conflict fired: the name is taken. Decided by
  // the unique index rather than by a lookup first, which two registrations
  // racing would both pass.
  if (!created) {
    if (inviteId !== null) {
      await releaseInvite(env.DB, inviteId);
    }
    throw new HttpError('That username is taken', 409);
  }

  if (claimed) {
    await recordInviteUse(env.DB, claimed.id, created.id);
    // Somebody invited by an admin joins that admin's family as a member.
    // Invites made before families were all made by
    // admins too, since every account was one.
    await env.DB.prepare(
      "UPDATE users SET manager_id = ?, role = 'member' WHERE id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'admin')"
    )
      .bind(claimed.createdBy, created.id, claimed.createdBy)
      .run();
  }

  const token = await createSession(env.DB, created.id);

  return ok(
    {
      token,
      user: { id: created.id, username, createdAt: at },
      hasSubscription: false,
      enrolled: true
    },
    201
  );
};

/**
 * Signs in with the key the device derived.
 *
 * There is no password path. A device sending only a password is told so
 * plainly -- that is a fact about this service, not about the account, so it
 * gives nothing away.
 */
export const login = async (request: Request, env: Env): Promise<Response> => {
  const body = await readJson<{ username?: string; auth?: string; tool?: unknown }>(request);
  const username = (body.username ?? '').trim();

  if (!username) {
    throw new HttpError('A username is required', 400);
  }
  if (!body.auth) {
    throw new HttpError('This service signs in with a derived key, not a password', 400);
  }
  // Read before the key is checked, so a malformed request is refused the
  // same way whoever sent it.
  const tool = body.tool === undefined ? null : toolSignIn(body.tool);

  // Wrong tries are counted (signInLimit.ts), before anything is looked up,
  // so a name with no account is held to the same as one with an account.
  const at = now();
  const tries = await tryKeys(request, username);
  await refuseIfTooManyTries(env.DB, tries, at);

  const user = await findUser(env.DB, username);
  const stored = user ? parseVerifier(user.auth_verifier) : null;
  const sent = typeof body.auth === 'string' ? fromBase64(body.auth) : null;

  // One refusal for a wrong key, an unknown name and a malformed key alike.
  const refuse = async (): Promise<never> => {
    await countFailedTry(env.DB, tries, at);
    throw new HttpError('Incorrect username or password', 401);
  };

  if (!user || !stored || !sent || sent.length !== KEY_BYTES) {
    return refuse();
  }

  const offered = await verifierFor(sent, workerKdf);
  if (!sameVerifier(offered, stored.verifier)) {
    return refuse();
  }
  await forgetFailedTries(env.DB, tries);

  const scope = tool ? (tool.history ? 'tool-history' : 'tool') : 'full';
  // Made only while the verifier is still the one just checked, so a password
  // changed in the meantime is not outlived by a sign-in with the old one.
  const token = await createSignInSession(env.DB, user.id, user.auth_verifier, scope, tool?.name ?? null);
  if (!token) {
    return refuse();
  }
  const subscription = await env.DB.prepare(
    'SELECT 1 AS present FROM provider_accounts WHERE user_id = ? AND active = 1 LIMIT 1'
  )
    .bind(user.id)
    .first();

  return ok({
    token,
    user: { id: user.id, username: user.username },
    // Where to send them: the library, or straight to "add your subscription".
    hasSubscription: subscription !== null,
    enrolled: true,
    // What the session is: a tool checks it got the narrow one it asked for.
    scope
  });
};

/** The longest name a tool may give itself, and what it may be made of. */
const TOOL_NAME_LIMIT = 60;

/**
 * What a tool asked for at sign-in: what to call it, and whether it may reach
 * favourites and watch history.
 *
 * The name is shown on the account's own devices, so it is plain text of a
 * sensible length or nothing at all.
 */
const toolSignIn = (value: unknown): { name: string; history: boolean } => {
  const asked = value as { name?: unknown; history?: unknown } | null;
  const name = typeof asked?.name === 'string' ? asked.name.trim() : '';
  if (!name || name.length > TOOL_NAME_LIMIT || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(`A tool names itself in up to ${TOOL_NAME_LIMIT} characters`, 400);
  }
  return { name, history: asked?.history === true };
};

/**
 * Replaces the keys on an account.
 *
 * For a change of password, which happens entirely on the device: it holds
 * both the old key and the new, so it re-encrypts whatever needed re-encrypting
 * and sends the result. There is nothing for this service to check -- it never
 * knew the old password either -- so holding a session is the whole
 * requirement.
 *
 * Every other session of the account ends (2 October). Those
 * devices still hold the old `enc`: they could open nothing sealed under the
 * new one, and the guide repair would seal it back under the old. Asked for
 * the new password once, they are right again. The session making the change
 * stays.
 */
export const replaceKeys = async (
  request: Request,
  env: Env,
  userId: number
): Promise<Response> => {
  const keys = acceptKeys(await readJson<SubmittedKeys>(request));

  const verifier = formatVerifier({
    kdf: 'scrypt',
    params: keys.params,
    salt: keys.salt,
    verifier: await verifierFor(keys.auth, workerKdf)
  });

  const token = bearerToken(request);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET auth_verifier = ?, updated_at = ? WHERE id = ?').bind(verifier, now(), userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(
      userId,
      token ? await hashToken(token) : ''
    )
  ]);

  return ok({ enrolled: true });
};

/** The signed-in account. */
export const me = async (env: Env, userId: number): Promise<Response> => {
  const user = await env.DB.prepare(
    'SELECT id, username, created_at, role, manager_id, household, picture FROM users WHERE id = ?'
  )
    .bind(userId)
    .first<{
      id: number;
      username: string;
      created_at: string;
      role: string;
      manager_id: number | null;
      household: number;
      picture: string | null;
    }>();

  if (!user) {
    throw new HttpError('No such account', 404);
  }

  return ok({
    user: {
      id: user.id,
      username: user.username,
      createdAt: user.created_at,
      // Where it stands in its family (shared/family.ts). An app from before
      // families ignores these, and an account outside one is an admin.
      role: user.role,
      managerId: user.manager_id ?? null,
      household: user.household === 1,
      picture: user.picture ?? null
    },
    providers: await listProviderRows(env.DB, userId)
  });
};

/**
 * The account's own profile picture (shared/profilePicture.ts): from its own
 * devices, its tool, or somebody above it setting it up. A kid may choose
 * theirs: it is not part of anybody's setup.
 */
export const setPicture = async (request: Request, env: Env, userId: number): Promise<Response> => {
  const body = await readJson<{ picture?: unknown }>(request);
  if (body.picture === undefined || !isProfilePicture(body.picture)) {
    throw new HttpError('A picture is an animal, a small JPEG, PNG or WebP, or null', 400);
  }
  await env.DB.prepare('UPDATE users SET picture = ?, updated_at = ? WHERE id = ?')
    .bind(body.picture, new Date().toISOString(), userId)
    .run();
  return ok({ changed: true });
};

// --- Subscriptions --------------------------------------------------------

/**
 * A subscription, as far as this service is concerned.
 *
 * An id, an owner, a timestamp and ciphertext. The label, the address, the
 * provider username and the provider password are all inside the payload,
 * encrypted under a key derived from the account password -- so this service
 * cannot read any of them, and does not need to.
 *
 * The id comes from the device, worked out from the server and the username so
 * that renewing credentials updates this row rather than adding a second one.
 * Credentials never go into it: see shared/xtream/guideSourceId.ts, which
 * solves the same problem for guides.
 */
interface ProviderBody {
  id?: string;
  payload?: string;
  active?: boolean;
}

const listProviderRows = (db: D1Database, userId: number) =>
  db
    .prepare(
      'SELECT id, payload, active, created_at, updated_at FROM provider_accounts WHERE user_id = ? ORDER BY updated_at DESC'
    )
    .bind(userId)
    .all<{
      id: string;
      payload: string;
      active: number;
      created_at: string;
      updated_at: string;
    }>()
    .then(result =>
      result.results.map(row => ({
        id: row.id,
        payload: row.payload,
        active: row.active === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    );

export const listProviders = async (env: Env, userId: number): Promise<Response> =>
  ok(await listProviderRows(env.DB, userId));

/** The subscription a device should be using, for it to open with its own key. */
export const activeProvider = async (env: Env, userId: number): Promise<Response> => {
  const row = await env.DB.prepare(
    'SELECT id, payload, updated_at FROM provider_accounts WHERE user_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1'
  )
    .bind(userId)
    .first<{ id: string; payload: string; updated_at: string }>();

  if (!row) {
    throw new HttpError('No subscription is set up on this account', 409);
  }

  return ok({ id: row.id, payload: row.payload, updatedAt: row.updated_at });
};

const MAX_PROVIDER_PAYLOAD_CHARS = 64 * 1024;
const MAX_PROVIDERS_PER_ACCOUNT = 50;

export const saveProvider = async (
  request: Request,
  env: Env,
  userId: number
): Promise<Response> => {
  const body = await readJson<ProviderBody>(request);
  const id = (body.id ?? '').trim();

  if (!id || id.length > 128) {
    throw new HttpError('A subscription id is required', 400);
  }
  if (typeof body.payload !== 'string' || !body.payload) {
    throw new HttpError('An encrypted payload is required', 400);
  }
  // A sealed login is a few hundred characters; an account has a handful.
  // Limits so one account cannot fill the database every account shares.
  if (body.payload.length > MAX_PROVIDER_PAYLOAD_CHARS) {
    throw new HttpError('That subscription is larger than this service keeps', 413);
  }
  const held = await env.DB.prepare(
    'SELECT COUNT(*) AS n, SUM(CASE WHEN id = ? THEN 1 ELSE 0 END) AS same FROM provider_accounts WHERE user_id = ?'
  )
    .bind(id, userId)
    .first<{ n: number; same: number | null }>();
  if (!Number(held?.same) && Number(held?.n) >= MAX_PROVIDERS_PER_ACCOUNT) {
    throw new HttpError(`An account keeps at most ${MAX_PROVIDERS_PER_ACCOUNT} subscriptions`, 413);
  }

  const at = now();
  const active = body.active === false ? 0 : 1;

  await env.DB.prepare(
    `INSERT INTO provider_accounts (user_id, id, payload, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       payload = excluded.payload,
       active = excluded.active,
       updated_at = excluded.updated_at`
  )
    .bind(userId, id, body.payload, active, at, at)
    .run();

  // Only one subscription is in use at a time, and the one just saved is it.
  if (active === 1) {
    await env.DB.prepare(
      'UPDATE provider_accounts SET active = 0 WHERE user_id = ? AND id != ?'
    )
      .bind(userId, id)
      .run();
  }

  return ok(await listProviderRows(env.DB, userId), 201);
};

export const removeProvider = async (env: Env, userId: number, id: string): Promise<Response> => {
  await env.DB.prepare('DELETE FROM provider_accounts WHERE user_id = ? AND id = ?')
    .bind(userId, id)
    .run();

  return ok(await listProviderRows(env.DB, userId));
};
