/**
 * server/ end to end, as somebody who pressed "Deploy to Cloudflare" would
 * meet it, against a local copy of it: in server/,
 * `npx wrangler d1 migrations apply DB --local` and then
 * `npx wrangler dev --port 8788` (with a .dev.vars from .dev.vars.example).
 *
 * A throwaway account with a generated password, on that local database
 * only. Never against a hosted service: see CLAUDE.md.
 *
 *   backend/node_modules/.bin/ts-node --transpile-only worker/scripts/e2e-server.ts
 */
import crypto from 'crypto';
import { CURRENT_KDF, SALT_BYTES, deriveAccountKeys, toBase64 } from '../../shared/auth/accountKeys';
import { nodeKdf } from '../../cli/src/nodeKdf';

const API = process.env['TVINTO_SERVER'] ?? 'http://127.0.0.1:8788/api';

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json()) as { data?: Record<string, unknown>; message?: string } };
};

const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) {
    process.exitCode = 1;
  }
};

async function main(): Promise<void> {
  const health = await call('GET', '/health');
  check('health answers', health.status === 200);
  check('a new server is open for its first account', health.body.data?.['registration'] === 'open', String(health.body.data?.['registration']));

  const username = `server-e2e-${crypto.randomBytes(3).toString('hex')}`;
  const password = crypto.randomBytes(18).toString('base64url');
  const salt = crypto.randomBytes(SALT_BYTES);
  const { auth } = await deriveAccountKeys(password, salt, CURRENT_KDF, nodeKdf);
  const registered = await call('POST', '/accounts/register', { username, keys: { salt: toBase64(salt), ...CURRENT_KDF, auth: toBase64(auth) } });
  check('the first account is made', registered.status === 201, String(registered.status));

  const after = await call('GET', '/health');
  check('then it needs an invite code', after.body.data?.['registration'] === 'invite', String(after.body.data?.['registration']));
  const second = await call('POST', '/accounts/register', { username: `${username}-2`, keys: { salt: toBase64(salt), ...CURRENT_KDF, auth: toBase64(auth) } });
  check('a second account without a code is refused', second.status === 403, String(second.status));

  const login = await call('POST', '/accounts/login', { username, auth: toBase64(auth) });
  check('signs in', login.status === 200, String(login.status));
  const token = String(login.body.data?.['token'] ?? '');

  const pushed = await call('POST', '/devices/changes', { favourites: [{ type: 'live', streamId: '1', name: 'One', updatedAt: '2099-01-01T00:00:00.000Z' }] }, token);
  check('a device pushes a change', pushed.status === 200, String(pushed.status));
  const pulled = await call('GET', '/devices/changes', undefined, token);
  const favourites = (pulled.body.data?.['favourites'] ?? []) as Array<{ updatedAt: string }>;
  check('a clock running ahead is capped', favourites.length === 1 && favourites[0].updatedAt < '2099', favourites[0]?.updatedAt);

  const wrong = toBase64(crypto.randomBytes(32));
  let refused = 0;
  for (let i = 0; i < 10; i++) {
    refused += (await call('POST', '/accounts/login', { username, auth: wrong })).status === 401 ? 1 : 0;
  }
  check('ten wrong passwords are refused', refused === 10, String(refused));
  const locked = await call('POST', '/accounts/login', { username, auth: toBase64(auth) });
  check('then even the right one waits', locked.status === 429, `${locked.status} ${locked.body.message}`);
}

void main();
