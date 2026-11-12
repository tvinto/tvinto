import { D1Database } from './d1';
import { HttpError } from './http';
import { workerKdf } from './kdf';

/**
 * How many wrong sign-ins are allowed before the door shuts for a while.
 *
 * Nothing stopped guessing before: each guess costs the guesser a scrypt on
 * their own machine, a tenth of a second, and nothing more, all day. Counted
 * here, in D1, rather than with Cloudflare's rate-limiting binding, which a
 * self-hosted service on another plan may not have.
 *
 * Per address and name, so a stranger who tries somebody's name shuts only
 * themselves out of it, not its owner; and per address alone, so one
 * address cannot try every name in turn. Addresses are kept only as hashes,
 * and only for the window.
 */
export const TRIES_PER_NAME = 10;
export const TRIES_PER_ADDRESS = 30;
export const WINDOW_MINUTES = 15;

export interface TryKeys {
  address: string;
  name: string;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

const digest = async (text: string): Promise<string> =>
  hex(await workerKdf.sha256(new TextEncoder().encode(text))).slice(0, 32);

/** The two counters a sign-in from this request, for this name, is held to. */
export const tryKeys = async (request: Request, name: string): Promise<TryKeys> => {
  const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  return {
    address: await digest(`address ${address}`),
    name: await digest(`name ${address} ${name.trim().toLowerCase()}`)
  };
};

const windowStart = (at: string): string => new Date(Date.parse(at) - WINDOW_MINUTES * 60_000).toISOString();

/** Refuses with 429 when either counter is used up. One query. */
export const refuseIfTooManyTries = async (db: D1Database, keys: TryKeys, at: string): Promise<void> => {
  const rows = await db
    .prepare('SELECT key, count FROM sign_in_failures WHERE key IN (?, ?) AND since >= ?')
    .bind(keys.address, keys.name, windowStart(at))
    .all<{ key: string; count: number }>();
  const used = new Map(rows.results.map(row => [row.key, Number(row.count) || 0]));
  if ((used.get(keys.name) ?? 0) >= TRIES_PER_NAME || (used.get(keys.address) ?? 0) >= TRIES_PER_ADDRESS) {
    throw new HttpError(`Too many tries. Wait ${WINDOW_MINUTES} minutes and try again.`, 429);
  }
};

/** Counts a wrong try against both, starting a counter again once its window has passed. */
export const countFailedTry = async (db: D1Database, keys: TryKeys, at: string): Promise<void> => {
  const since = windowStart(at);
  const count = (key: string) =>
    db
      .prepare(
        `INSERT INTO sign_in_failures (key, since, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN sign_in_failures.since < ? THEN 1 ELSE sign_in_failures.count + 1 END,
           since = CASE WHEN sign_in_failures.since < ? THEN excluded.since ELSE sign_in_failures.since END`
      )
      .bind(key, at, since, since);
  await db.batch([
    count(keys.address),
    count(keys.name),
    // Whatever has outlived its window, so nothing is kept longer than that.
    db.prepare('DELETE FROM sign_in_failures WHERE since < ?').bind(since)
  ]);
};

/** A right password clears that name's counter for this address; the address's own stays. */
export const forgetFailedTries = async (db: D1Database, keys: TryKeys): Promise<void> => {
  await db.prepare('DELETE FROM sign_in_failures WHERE key = ?').bind(keys.name).run();
};
