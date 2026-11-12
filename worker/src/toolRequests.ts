import { sealFor } from '../../shared/auth/keyPair';
import { fromBase64 } from '../../shared/auth/accountKeys';
import { D1Database, Env } from './d1';
import { HttpError, ok, readJson } from './http';
import { Caller, createSession, hashToken } from './sessions';
import { now } from './clock';

/**
 * Signing a tool in by approving it on a device that is already signed in,
 * instead of typing the password at a terminal.
 *
 * 1. tvinto makes a key pair and asks: `POST /api/tools/requests` with the
 *    account's name, its own name, and its public key. It gets an id, a
 *    short code to show, and a secret only it holds.
 * 2. The desktop app is opened on the request (a deep link), or finds it on
 *    Account > Tools, and shows the code beside "Allow?". Allowing seals the
 *    account's `enc` for the tool's public key and sends it here.
 * 3. This makes the tool's session and seals its token for the same key, and
 *    gives the app a second code to show: the confirmation.
 * 4. tvinto, asking with its secret, is told to confirm; the person types the
 *    confirmation the app shows into tvinto, and only then does tvinto get
 *    both sealed parts, once, and the request is gone. Only tvinto's private
 *    key opens them: nothing this service holds at any point lets anybody
 *    else sign in or read anything.
 *
 * The confirmation is what ties an approval to the person's own tool. Anybody
 * can make a request for any account and send a link that opens the app on
 * it, and the first code is theirs to show; the confirmation exists only on
 * the person's screen, and is useless to anybody who did not start the tool
 * the person is typing it into.
 *
 * A request lasts ten minutes. An account has at most three waiting.
 */

const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_WAITING = 3;
/** Wrong confirmations before the request is refused outright. */
const CONFIRM_TRIES = 5;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** The largest multiple of the alphabet's length below 256, so every letter is as likely. */
const CODE_LIMIT = 256 - (256 % CODE_ALPHABET.length);

/** Letters and digits for a person to compare or type, without the ones that read alike. */
const newCode = (length = 4): string => {
  let code = '';
  while (code.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < CODE_LIMIT && code.length < length) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
    }
  }
  return code;
};

const encoder = new TextEncoder();

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(mac)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * A request for an account that does not exist, or one with requests enough
 * waiting, is answered as any other and polls as waiting until it runs out --
 * nothing stored, so it is told apart by its id instead: twelve hex digits of
 * chance, the minute it runs out, and a mark only this service can make. Its
 * secret is derived from the id the same way. Without it, asking how a request
 * went said whether the account it named exists.
 */
const decoySecret = (env: Env): string => env.ACCOUNT_SALT_SECRET ?? '';

const makeDecoy = async (env: Env): Promise<{ id: string; secret: string }> => {
  const until = Math.floor((Date.now() + REQUEST_TTL_MS) / 60000).toString(16).padStart(8, '0');
  const head = randomHex(6) + until;
  const id = head + (await hmacHex(decoySecret(env), `tool-request-decoy:${head}`)).slice(0, 12);
  return { id, secret: (await hmacHex(decoySecret(env), `tool-request-decoy-secret:${id}`)).slice(0, 64) };
};

/** Whether an id and secret are a decoy's that has not run out. */
const isLiveDecoy = async (env: Env, id: string, secret: string): Promise<boolean> => {
  if (!decoySecret(env) || id.length !== 32) {
    return false;
  }
  const head = id.slice(0, 20);
  const mark = (await hmacHex(decoySecret(env), `tool-request-decoy:${head}`)).slice(0, 12);
  if (mark !== id.slice(20)) {
    return false;
  }
  const expected = (await hmacHex(decoySecret(env), `tool-request-decoy-secret:${id}`)).slice(0, 64);
  return secret === expected && parseInt(head.slice(12), 16) * 60000 > Date.now();
};

const randomHex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');

const isPublicKey = (value: unknown): value is string => typeof value === 'string' && fromBase64(value)?.length === 65;

const TOOL_NAME_LIMIT = 60;

const toolName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > TOOL_NAME_LIMIT || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(`A tool names itself in up to ${TOOL_NAME_LIMIT} characters`, 400);
  }
  return name;
};

const forgetExpired = (db: D1Database) =>
  db.prepare('DELETE FROM tool_requests WHERE expires_at < ?').bind(now()).run();

/**
 * POST /api/tools/requests, open: a tool asking to be let in.
 *
 * An unknown account name gets the same answer as a known one, and a request
 * nobody will ever see: whether an account exists is not for anybody to ask.
 */
export const createToolRequest = async (request: Request, env: Env): Promise<Response> => {
  const body = await readJson<{ username?: unknown; name?: unknown; history?: unknown; publicKey?: unknown }>(request);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!username) {
    throw new HttpError('Which account: a username is required', 400);
  }
  const name = toolName(body.name);
  if (!isPublicKey(body.publicKey)) {
    throw new HttpError('A tool sends a public key to be sealed for', 400);
  }

  const db = env.DB;
  await forgetExpired(db);
  const user = await db
    .prepare('SELECT id FROM users WHERE username_folded = ?')
    .bind(username.toLowerCase())
    .first<{ id: number }>();

  const code = newCode();
  const waiting = user
    ? await db
        .prepare("SELECT COUNT(*) AS n FROM tool_requests WHERE user_id = ? AND status = 'pending'")
        .bind(user.id)
        .first<{ n: number }>()
    : null;
  // An account with requests enough waiting gets a decoy too, rather than a
  // refusal that only an existing account could earn.
  if (!user || Number(waiting?.n) >= MAX_WAITING) {
    const decoy = await makeDecoy(env);
    return ok({ id: decoy.id, code, secret: decoy.secret, expiresInMinutes: REQUEST_TTL_MS / 60000 }, 201);
  }
  const id = randomHex(16);
  const secret = randomHex(32);
  {
    const at = now();
    await db
      .prepare(
        `INSERT INTO tool_requests (id, user_id, name, history, public_key, code, secret_hash, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        id,
        user.id,
        name,
        body.history === true ? 1 : 0,
        body.publicKey,
        code,
        await hashToken(secret),
        at,
        new Date(Date.parse(at) + REQUEST_TTL_MS).toISOString()
      )
      .run();
  }
  return ok({ id, code, secret, expiresInMinutes: REQUEST_TTL_MS / 60000 }, 201);
};

/**
 * GET /api/tools/requests/:id, open, with the secret in `X-Tool-Secret`: the
 * tool asking how its request went. An answered request is handed over once
 * and deleted.
 */
export const pollToolRequest = async (request: Request, env: Env, id: string): Promise<Response> => {
  const secret = request.headers.get('X-Tool-Secret') ?? '';
  const db = env.DB;
  const row = await db
    .prepare(
      `SELECT status, secret_hash, expires_at, sealed_enc, user_id, confirm_hash, confirm_tries, name, history, public_key
         FROM tool_requests WHERE id = ?`
    )
    .bind(id)
    .first<{
      status: string;
      secret_hash: string;
      expires_at: string;
      name: string;
      history: number;
      public_key: string;
      sealed_enc: string | null;
      user_id: number;
      confirm_hash: string | null;
      confirm_tries: number;
    }>();

  if (!row && secret && (await isLiveDecoy(env, id, secret))) {
    return ok({ status: 'pending' });
  }
  // The same answer for no such request and for the wrong secret.
  if (!row || !secret || (await hashToken(secret)) !== row.secret_hash || row.expires_at < now()) {
    throw new HttpError('No such request, or it ran out', 404);
  }
  if (row.status === 'pending') {
    return ok({ status: 'pending' });
  }
  if (row.status === 'approved') {
    // Allowed in the app: now the confirmation the app showed, typed in by
    // the person at this tool.
    const typed = (request.headers.get('X-Tool-Confirm') ?? '').trim().toUpperCase();
    if (!typed) {
      return ok({ status: 'confirm' });
    }
    if (!row.confirm_hash || (await hashToken(typed)) !== row.confirm_hash) {
      const tries = Number(row.confirm_tries) + 1;
      if (tries >= CONFIRM_TRIES) {
        await db.prepare('DELETE FROM tool_requests WHERE id = ?').bind(id).run();
        return ok({ status: 'denied' });
      }
      await db.prepare('UPDATE tool_requests SET confirm_tries = ? WHERE id = ?').bind(tries, id).run();
      return ok({ status: 'confirm', wrong: true });
    }
  }
  await db.prepare('DELETE FROM tool_requests WHERE id = ?').bind(id).run();
  if (row.status !== 'approved') {
    return ok({ status: 'denied' });
  }
  // The session is made only now, confirmed, so an approval nobody confirms
  // leaves no session behind.
  const asked = await db
    .prepare('SELECT username FROM users WHERE id = ?')
    .bind(row.user_id)
    .first<{ username: string }>();
  const token = await createSession(db, row.user_id, row.history === 1 ? 'tool-history' : 'tool', row.name);
  return ok({
    status: 'approved',
    sealedToken: await sealFor(token, row.public_key),
    sealedEnc: row.sealed_enc,
    username: asked?.username ?? ''
  });
};

/** GET /api/accounts/tools/requests: the requests waiting for this account. */
export const listToolRequests = async (env: Env, caller: Caller): Promise<Response> => {
  await forgetExpired(env.DB);
  const rows = await env.DB.prepare(
    "SELECT id, name, history, code, public_key, created_at FROM tool_requests WHERE user_id = ? AND status = 'pending' ORDER BY created_at"
  )
    .bind(caller.userId)
    .all<{ id: string; name: string; history: number; code: string; public_key: string; created_at: string }>();
  return ok({
    requests: (rows.results ?? []).map(row => ({
      id: row.id,
      name: row.name,
      history: row.history === 1,
      code: row.code,
      // What the device seals the account's key for: only this tool opens it.
      publicKey: row.public_key,
      createdAt: row.created_at
    }))
  });
};

/**
 * POST /api/accounts/tools/requests/:id: allowing or refusing one.
 *
 * Allowing takes the account's `enc`, sealed by the device for the tool's
 * public key -- this service never sees it open -- and answers with the
 * confirmation for the app to show. The session is made when the tool sends
 * that confirmation back (`pollToolRequest`).
 */
export const answerToolRequest = async (request: Request, env: Env, caller: Caller, id: string): Promise<Response> => {
  const body = await readJson<{ allow?: unknown; sealedEnc?: unknown }>(request);
  const db = env.DB;
  const row = await db
    .prepare("SELECT user_id, name, history, public_key, expires_at FROM tool_requests WHERE id = ? AND status = 'pending'")
    .bind(id)
    .first<{ user_id: number; name: string; history: number; public_key: string; expires_at: string }>();
  if (!row || row.user_id !== caller.userId || row.expires_at < now()) {
    throw new HttpError('No such request, or it ran out', 404);
  }

  if (body.allow !== true) {
    await db.prepare("UPDATE tool_requests SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(id).run();
    return ok({ allowed: false });
  }
  if (typeof body.sealedEnc !== 'string' || !body.sealedEnc.startsWith('pk1$') || body.sealedEnc.length > 4096) {
    throw new HttpError("Allowing a tool hands it the account's key, sealed for it", 400);
  }

  const confirm = newCode(6);
  const result = await db
    .prepare(
      "UPDATE tool_requests SET status = 'approved', sealed_enc = ?, confirm_hash = ?, confirm_tries = 0 WHERE id = ? AND status = 'pending'"
    )
    .bind(body.sealedEnc, await hashToken(confirm), id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new HttpError('No such request, or it ran out', 404);
  }
  return ok({ allowed: true, confirm });
};
