import { D1Database, Env } from './d1';
import { HttpError, ok } from './http';
import { now } from './clock';

/**
 * Invite codes: the one way through a closed registration.
 *
 * The service is reachable from anywhere, so registration stays closed
 * (`ACCOUNT_REGISTRATION` in wrangler.toml) -- an open door on a public
 * address would let anybody make accounts on a user's free allowance. But
 * closed with no way through meant a new person in the household took the
 * owner opening it by hand, waiting, and closing it again. So a signed-in
 * account can make a code, say it to somebody, and that somebody can make one
 * account with it. Once, within a week.
 *
 * Kept as a hash, like a session token: a copy of this table should not be a
 * handful of ways in.
 */

/** No 0/O, 1/I/L: a code is read aloud and typed with a remote. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;
const VALID_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** Unused codes an account may hold at once, so nobody can mint an unbounded supply. */
const MOST_OPEN = 5;

const encoder = new TextEncoder();

/** What was typed, as it is stored: letters and digits, upper case. */
export const normaliseInvite = (typed: string): string => typed.toUpperCase().replace(/[^A-Z0-9]/g, '');

const hashInvite = async (code: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(normaliseInvite(code)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

/** Eight characters as ABCD-EFGH, which is how it is shown and read out. */
const mintInvite = (): string => {
  // Rejection sampling, so every character is equally likely: 256 is not a
  // multiple of the alphabet's 31.
  const limit = 256 - (256 % ALPHABET.length);
  let code = '';
  while (code.length < LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(LENGTH * 2))) {
      if (byte < limit && code.length < LENGTH) {
        code += ALPHABET[byte % ALPHABET.length];
      }
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};

export const createInvite = async (env: Env, userId: number): Promise<Response> => {
  const at = now();
  const open = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND used_at IS NULL AND expires_at > ?'
  )
    .bind(userId, at)
    .first<{ n: number }>();

  if ((open?.n ?? 0) >= MOST_OPEN) {
    throw new HttpError(`You already have ${MOST_OPEN} unused invite codes; cancel one first`, 409);
  }

  const code = mintInvite();
  const expiresAt = new Date(Date.parse(at) + VALID_FOR_MS).toISOString();
  const created = await env.DB.prepare(
    'INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?) RETURNING id'
  )
    .bind(await hashInvite(code), userId, at, expiresAt)
    .first<{ id: number }>();

  // The code itself only ever leaves in this answer: it is not stored.
  return ok({ id: created?.id, code, createdAt: at, expiresAt }, 201);
};

export const listInvites = async (env: Env, userId: number): Promise<Response> => {
  const { results } = await env.DB.prepare(
    `SELECT invites.id, invites.created_at, invites.expires_at, invites.used_at, users.username AS used_by
     FROM invites LEFT JOIN users ON users.id = invites.used_by
     WHERE invites.created_by = ?
     ORDER BY invites.created_at DESC
     LIMIT 20`
  )
    .bind(userId)
    .all<{ id: number; created_at: string; expires_at: string; used_at: string | null; used_by: string | null }>();

  return ok(
    results.map(row => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedBy: row.used_by
    }))
  );
};

/** Cancels an unused code. A used one is history, and stays. */
export const revokeInvite = async (env: Env, userId: number, id: string): Promise<Response> => {
  await env.DB.prepare('DELETE FROM invites WHERE id = ? AND created_by = ? AND used_at IS NULL')
    .bind(Number(id), userId)
    .run();
  return ok({ revoked: true });
};

/**
 * Takes a code for a registration, or says it cannot.
 *
 * One statement, so two people typing the same code at once cannot both get
 * through: the second finds it already used.
 */
export const claimInvite = async (
  db: D1Database,
  typed: string
): Promise<{ id: number; createdBy: number } | null> => {
  const at = now();
  const claimed = await db
    .prepare(
      'UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING id, created_by'
    )
    .bind(at, await hashInvite(typed), at)
    .first<{ id: number; created_by: number }>();
  return claimed ? { id: Number(claimed.id), createdBy: Number(claimed.created_by) } : null;
};

/** Gives a claimed code back, when the registration it was claimed for failed. */
export const releaseInvite = async (db: D1Database, id: number): Promise<void> => {
  await db.prepare('UPDATE invites SET used_at = NULL WHERE id = ?').bind(id).run();
};

export const recordInviteUse = async (db: D1Database, id: number, userId: number): Promise<void> => {
  await db.prepare('UPDATE invites SET used_by = ? WHERE id = ?').bind(userId, id).run();
};
