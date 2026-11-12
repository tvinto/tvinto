import { Env } from './d1';
import { HttpError, ok, readJson } from './http';
import { Caller } from './sessions';
import { now } from './clock';

/**
 * What a tool may ask for and only a person may do:
 * adding or removing a family member, resetting a member's password, taking
 * the parental lock off.
 *
 * A tool asks; the desktop app is opened on the request (or finds it on
 * Account > Tools), shows it, and on a person's click does it itself, with
 * its own session -- then says it is done. The tool learns only that. A
 * password made for a new or reset member is shown in the app and nowhere
 * else, so no agent ever reads one.
 */

export const TOOL_ACTION_KINDS = ['add-member', 'remove-member', 'reset-password', 'pin-off'] as const;
export type ToolActionKind = (typeof TOOL_ACTION_KINDS)[number];

const ACTION_TTL_MS = 10 * 60 * 1000;
const MAX_WAITING = 5;

const randomHex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** What each kind carries, checked: plain names and numbers, nothing more. */
function readDetails(kind: ToolActionKind, details: unknown): Record<string, unknown> {
  const given = (details ?? {}) as Record<string, unknown>;
  switch (kind) {
    case 'add-member': {
      const username = typeof given['username'] === 'string' ? given['username'].trim() : '';
      if (!/^[\p{L}\p{N}._-]{2,40}$/u.test(username)) {
        throw new HttpError('A new member needs a username of 2 to 40 letters, digits, dots, dashes or underscores', 400);
      }
      if (!['admin', 'member', 'kid'].includes(given['role'] as string)) {
        throw new HttpError('A role is admin, member or kid', 400);
      }
      return { username, role: given['role'], household: given['household'] === true };
    }
    case 'remove-member':
    case 'reset-password': {
      const memberId = Number(given['memberId']);
      if (!Number.isInteger(memberId) || memberId <= 0) {
        throw new HttpError('Which member: memberId', 400);
      }
      return { memberId };
    }
    case 'pin-off':
      return {};
  }
}

/** POST /api/accounts/tools/actions: a tool asking for one of these. */
export const createToolAction = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  const body = await readJson<{ kind?: unknown; details?: unknown }>(request);
  const kind = TOOL_ACTION_KINDS.find(candidate => candidate === body.kind);
  if (!kind) {
    throw new HttpError(`A tool can ask for: ${TOOL_ACTION_KINDS.join(', ')}`, 400);
  }
  const details = readDetails(kind, body.details);
  const db = env.DB;
  await db.prepare('DELETE FROM tool_actions WHERE expires_at < ?').bind(now()).run();
  const waiting = await db
    .prepare("SELECT COUNT(*) AS n FROM tool_actions WHERE user_id = ? AND status = 'pending'")
    .bind(caller.userId)
    .first<{ n: number }>();
  if (Number(waiting?.n) >= MAX_WAITING) {
    throw new HttpError('Too many requests are waiting in the app. Answer them there first.', 429);
  }
  const id = randomHex(16);
  const at = now();
  const tool = await db
    .prepare('SELECT label FROM sessions WHERE substr(token_hash, 1, 16) = ?')
    .bind(caller.sessionId)
    .first<{ label: string | null }>();
  await db
    .prepare(
      `INSERT INTO tool_actions (id, user_id, tool_name, kind, details, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(id, caller.userId, tool?.label ?? 'A tool', kind, JSON.stringify(details), at, new Date(Date.parse(at) + ACTION_TTL_MS).toISOString())
    .run();
  return ok({ id, expiresInMinutes: ACTION_TTL_MS / 60000 }, 201);
};

/** GET /api/accounts/tools/actions/:id: how it went. */
export const toolActionStatus = async (env: Env, caller: Caller, id: string): Promise<Response> => {
  const row = await env.DB.prepare('SELECT status, expires_at FROM tool_actions WHERE id = ? AND user_id = ?')
    .bind(id, caller.userId)
    .first<{ status: string; expires_at: string }>();
  if (!row || (row.status === 'pending' && row.expires_at < now())) {
    throw new HttpError('No such request, or it ran out', 404);
  }
  return ok({ status: row.status });
};

/** GET /api/accounts/tools/actions: what is waiting, for the account's own devices. */
export const listToolActions = async (env: Env, caller: Caller): Promise<Response> => {
  await env.DB.prepare('DELETE FROM tool_actions WHERE expires_at < ?').bind(now()).run();
  const rows = await env.DB.prepare(
    "SELECT id, tool_name, kind, details, created_at FROM tool_actions WHERE user_id = ? AND status = 'pending' ORDER BY created_at"
  )
    .bind(caller.userId)
    .all<{ id: string; tool_name: string; kind: string; details: string; created_at: string }>();
  return ok({
    actions: (rows.results ?? []).map(row => ({
      id: row.id,
      toolName: row.tool_name,
      kind: row.kind,
      details: JSON.parse(row.details) as unknown,
      createdAt: row.created_at
    }))
  });
};

/** POST /api/accounts/tools/actions/:id: the app saying it did it, or that the person said no. */
export const answerToolAction = async (request: Request, env: Env, caller: Caller, id: string): Promise<Response> => {
  const body = await readJson<{ done?: unknown }>(request);
  const result = await env.DB.prepare(
    "UPDATE tool_actions SET status = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at >= ?"
  )
    .bind(body.done === true ? 'done' : 'refused', id, caller.userId, now())
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new HttpError('No such request, or it ran out', 404);
  }
  return ok({ status: body.done === true ? 'done' : 'refused' });
};
