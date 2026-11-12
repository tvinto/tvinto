import { D1Database } from './d1';
import { now } from './clock';
import { HttpError } from './http';
import { FamilyRole, SessionScope, isFamilyRole } from '../../shared/family';

/**
 * Who a caller is, kept in the database because there is nowhere else.
 *
 * The Express backend holds sessions in a map and writes them down as well.
 * A Worker has no map worth having: a request lands in whichever isolate is
 * nearest, and one isolate's memory means nothing to the next. Every lookup is
 * a query, which is affordable because a token is checked once per request and
 * a request is not free anyway.
 *
 * A token stands for an account and nothing else. There is nothing secret in
 * one -- no provider credentials, no key -- so a session surviving a restart
 * costs nothing. It is stored hashed even so: whoever holds it is signed in,
 * and a copy of the database should not hand out live sessions.
 */

/**
 * A year idle, so a session outlives anything short of a device put away.
 *
 * It was twelve hours, matching the backend this replaced, and on a television
 * that meant the sign-in form every morning: a set is switched off overnight,
 * and a session nobody used for twelve hours was gone by breakfast. Sign-in on
 * a device is meant to be kept -- it is also the one thing the app cannot do
 * without this service in reach. The window still slides, a password change
 * still ends every session (`destroySessionsFor`), and signing out ends this
 * one; what goes is only the expiry nobody asked for.
 */
const IDLE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * A tool's session goes after thirty days unused. A
 * television is switched on every evening and a CLI is reached for now and
 * then; one left signed in on a computer nobody uses for a month should not
 * still be able to change the account.
 */
const TOOL_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How stale `last_used_at` may get before it is worth a write.
 *
 * Refreshing it on every request would double the writes for a value nothing
 * reads to the minute. Five minutes keeps the idle timer honest and turns a
 * busy hour of polling into a dozen updates instead of hundreds.
 */
const REFRESH_AFTER_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

/** The token as it is stored: a plain digest, no salt. */
export const hashToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * A new token, 256 bits of randomness.
 *
 * base64url rather than base64, because this travels in an Authorization
 * header and in nothing that would have to escape it.
 */
const mintToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * A session made by another session rather than by signing in: a manager's
 * setup or profile session on a member, or a tool's setup session on one. It
 * lives only as long as the session that made it (`resolveSession`), so
 * signing a tool out, a manager's password change or a manager signing out
 * ends what they made; and it is not the account's own, so it cannot change
 * the account's password or move it between families.
 */
export interface MintedBy {
  /** The account whose session made it. */
  userId: number;
  /** That session's public id (`sessionId`). */
  sessionId: string;
  /** Whether that session was a tool's, whose limits it then carries. */
  tool: boolean;
}

export const createSession = async (
  db: D1Database,
  userId: number,
  scope: SessionScope = 'full',
  label: string | null = null,
  mintedBy: MintedBy | null = null
): Promise<string> => {
  const token = mintToken();
  const at = now();

  await db
    .prepare(
      `INSERT OR REPLACE INTO sessions
         (token_hash, user_id, created_at, last_used_at, scope, label, minted_by, minted_by_session, minted_by_tool)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      await hashToken(token),
      userId,
      at,
      at,
      scope,
      label,
      mintedBy?.userId ?? null,
      mintedBy?.sessionId ?? null,
      mintedBy?.tool ? 1 : 0
    )
    .run();

  return token;
};

/**
 * A session for a sign-in, made only if the account's verifier is still the
 * one the key was checked against. A password change landing between that
 * check and this insert ends every other session; without the condition this
 * one would be made afterwards from the old password and survive it. Null
 * when the verifier changed.
 */
export const createSignInSession = async (
  db: D1Database,
  userId: number,
  verifier: string,
  scope: SessionScope = 'full',
  label: string | null = null
): Promise<string | null> => {
  const token = mintToken();
  const at = now();
  const result = await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, scope, label)
       SELECT ?, id, ?, ?, ?, ? FROM users WHERE id = ? AND auth_verifier = ?`
    )
    .bind(await hashToken(token), at, at, scope, label, userId, verifier)
    .run();

  return (result.meta?.changes ?? 0) > 0 ? token : null;
};

/**
 * A session's public name: the start of its hash.
 *
 * Enough to tell an account's sessions apart and to sign one out by, and no
 * help to anybody wanting to be signed in -- that takes the token, which is
 * never stored, and a hash cannot be turned back into one.
 */
export const sessionId = (tokenHash: string): string => tokenHash.slice(0, 16);

/** A tool signed in to an account, as Account lists it. */
export interface ToolSession {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  /** Whether it may read and change favourites and watch history. */
  history: boolean;
  /** Whether this is the session asking. */
  current: boolean;
}

/** The tools signed in to an account, most recently used first. */
export const listToolSessions = async (
  db: D1Database,
  userId: number,
  currentHash: string | null
): Promise<ToolSession[]> => {
  const rows = await db
    .prepare(
      `SELECT token_hash, label, created_at, last_used_at, scope FROM sessions
        WHERE user_id = ? AND scope IN ('tool', 'tool-history')
        ORDER BY last_used_at DESC`
    )
    .bind(userId)
    .all<{ token_hash: string; label: string | null; created_at: string; last_used_at: string; scope: string }>();

  return (rows.results ?? []).map(row => ({
    id: sessionId(row.token_hash),
    name: row.label ?? 'Tool',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    history: row.scope === 'tool-history',
    current: row.token_hash === currentHash
  }));
};

/**
 * How many changes a tool may push in a minute. A person
 * hiding a few categories never comes near it; an agent talked into
 * rewriting the account a piece at a time is held to it.
 */
export const TOOL_CHANGES_PER_MINUTE = 30;

/**
 * Counts a tool's push against its minute, or refuses it with 429.
 *
 * Kept on the session row as "<minute>|<count>": one row, one write, and
 * gone with the session.
 */
export const chargeToolChanges = async (db: D1Database, sessionPrefix: string, changes: number, at = now()): Promise<void> => {
  const minute = at.slice(0, 16);
  const row = await db
    .prepare('SELECT tool_window FROM sessions WHERE substr(token_hash, 1, 16) = ?')
    .bind(sessionPrefix)
    .first<{ tool_window: string | null }>();
  const [stored, count] = (row?.tool_window ?? '').split('|');
  const used = stored === minute ? Number(count) || 0 : 0;
  if (used + changes > TOOL_CHANGES_PER_MINUTE) {
    throw new HttpError(`A tool may make ${TOOL_CHANGES_PER_MINUTE} changes a minute. Wait a minute and try again.`, 429);
  }
  await db
    .prepare('UPDATE sessions SET tool_window = ? WHERE substr(token_hash, 1, 16) = ?')
    .bind(`${minute}|${used + changes}`, sessionPrefix)
    .run();
};

/**
 * Signs one of an account's tools out by its id, and with it every session the
 * tool made on a member. Whether there was one.
 */
export const endToolSession = async (db: D1Database, userId: number, id: string): Promise<boolean> => {
  if (!/^[0-9a-f]{16}$/.test(id)) {
    return false;
  }
  const result = await db
    .prepare(
      `DELETE FROM sessions
        WHERE user_id = ? AND scope IN ('tool', 'tool-history') AND substr(token_hash, 1, 16) = ?`
    )
    .bind(userId, id)
    .run();
  await db.prepare('DELETE FROM sessions WHERE minted_by = ? AND minted_by_session = ?').bind(userId, id).run();
  return (result.meta?.changes ?? 0) > 0;
};

/** Ends every session an account made on others: when it stops being an admin, or is deleted. */
export const endSessionsMintedBy = async (db: D1Database, userId: number): Promise<void> => {
  await db.prepare('DELETE FROM sessions WHERE minted_by = ?').bind(userId).run();
};

/** The token a request carries, or null. */
export const bearerToken = (request: Request): string | null => {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  return match ? match[1].trim() : null;
};

/** Who is calling: the account, what it may do, and what its session is for. */
export interface Caller {
  userId: number;
  role: FamilyRole;
  scope: SessionScope;
  /** The public id of the session asking (`sessionId`), so a tool can sign itself out. */
  sessionId: string;
  /** Who made this session, when it is not the account's own sign-in. */
  mintedBy: MintedBy | null;
}

/** A stored scope, read as the least it could be when it is not one this knows. */
const scopeOf = (stored: string): SessionScope =>
  stored === 'full' || stored === 'tool' || stored === 'tool-history' ? stored : 'setup';

/**
 * Which account this request is, or null.
 *
 * An expired session is deleted on the way past rather than left to a sweep.
 * There is no process here to run one in, and the row is in hand at the moment
 * it is found to be dead.
 */
export const resolveSession = async (
  db: D1Database,
  request: Request
): Promise<Caller | null> => {
  const token = bearerToken(request);
  if (!token) {
    return null;
  }

  const hash = await hashToken(token);
  const row = await db
    // The role comes with the session, in the same query: every request needs
    // it, and a second query per request would be one more against fifty.
    .prepare(
      // So does whether the session that made this one is still there: a
      // session made by another lives only as long as its maker.
      `SELECT sessions.user_id, sessions.last_used_at, sessions.scope, users.role,
              sessions.minted_by, sessions.minted_by_session, sessions.minted_by_tool,
              (SELECT COUNT(*) FROM sessions maker
                WHERE maker.user_id = sessions.minted_by
                  AND substr(maker.token_hash, 1, 16) = sessions.minted_by_session) AS maker_alive
         FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?`
    )
    .bind(hash)
    .first<{
      user_id: number;
      last_used_at: string;
      scope: string;
      role: string;
      minted_by: number | null;
      minted_by_session: string | null;
      minted_by_tool: number | null;
      maker_alive: number;
    }>();

  if (!row) {
    return null;
  }

  const scope = scopeOf(row.scope);
  const mintedBy: MintedBy | null =
    row.minted_by === null || row.minted_by === undefined
      ? null
      : { userId: Number(row.minted_by), sessionId: String(row.minted_by_session ?? ''), tool: Number(row.minted_by_tool) === 1 };
  const ttl = scope === 'tool' || scope === 'tool-history' ? TOOL_IDLE_TTL_MS : IDLE_TTL_MS;
  const idle = Date.now() - Date.parse(row.last_used_at);
  if (!Number.isFinite(idle) || idle > ttl || (mintedBy && Number(row.maker_alive) === 0)) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }

  if (idle > REFRESH_AFTER_MS) {
    await db
      .prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?')
      .bind(now(), hash)
      .run();
  }

  return {
    userId: Number(row.user_id),
    // Anything unexpected reads as the least it could be, not the most.
    role: isFamilyRole(row.role) ? row.role : 'kid',
    scope,
    sessionId: sessionId(hash),
    mintedBy
  };
};

/**
 * Ends every session for an account.
 *
 * For a change of password, which is often a response to somebody else
 * knowing it.
 */
export const destroySessionsFor = async (db: D1Database, userId: number): Promise<void> => {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
};

/** Whether a caller is held to a tool's limits: a tool's own session, or one a tool made. */
export const actsAsTool = (caller: Caller): boolean =>
  caller.scope === 'tool' || caller.scope === 'tool-history' || caller.mintedBy?.tool === true;

/** The session a tool's changes count against: the tool's own, also for a session it made. */
export const toolChargeId = (caller: Caller): string =>
  caller.mintedBy?.tool ? caller.mintedBy.sessionId : caller.sessionId;
