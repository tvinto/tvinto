import worker from './index';
import { Env } from './d1';
import { SALT_SECRET, keysFor } from './test-utils/keys';
import { TestD1, openTestD1 } from './test-utils/d1';
import { makeKeyPair } from '../../shared/auth/keyPair';

/**
 * What the security audit of 7 November found, held: sessions one session
 * makes for another account end with their maker, a tool cannot loosen the
 * parental lock or read saved subtitles without history, and one account
 * cannot fill the database.
 */

const PASSWORD = 'a-good-long-password';

let db: TestD1;
let env: Env;

beforeEach(() => {
  db = openTestD1();
  env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };
});

afterEach(() => db.close());

const call = (method: string, path: string, options: { body?: unknown; token?: string; raw?: string } = {}) =>
  worker.fetch(
    new Request(`https://sync.example${path}`, {
      method,
      headers: {
        ...(options.body !== undefined || options.raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
    }),
    env
  );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = async (response: Response): Promise<any> => ((await response.json()) as { data: unknown }).data;

const register = async (username: string) => {
  const payload = await data(await call('POST', '/api/accounts/register', { body: { username, keys: await keysFor(PASSWORD) } }));
  return { token: payload.token as string, id: payload.user.id as number };
};

const signIn = async (username: string, tool?: unknown) =>
  data(
    await call('POST', '/api/accounts/login', {
      body: { username, auth: (await keysFor(PASSWORD)).auth, ...(tool === undefined ? {} : { tool }) }
    })
  );

const toolToken = async (username: string, history = false): Promise<string> =>
  (await signIn(username, { name: 'Tool on DESKTOP-1', history })).token;

const addMember = async (token: string, username: string, role: 'member' | 'kid' | 'admin', household: boolean) =>
  (
    await data(
      await call('POST', '/api/family/members', {
        token,
        body: {
          username,
          keys: await keysFor(PASSWORD),
          role,
          household,
          publicKey: (await makeKeyPair()).publicKey,
          sealedPrivateKey: 'sb1$aaaa$bbbb',
          managedKeys: []
        }
      })
    )
  ).id as number;

const mint = async (token: string, memberId: number, scope: 'setup' | 'full') =>
  (await data(await call('POST', `/api/family/members/${memberId}/session`, { token, body: { scope } }))).token as string;

const works = async (token: string) => (await call('GET', '/api/devices/settings', { token })).status;

describe('a session made by another session', () => {
  it('ends when the tool that made it is signed out', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana', 'member', false);
    const tool = await toolToken('petar');
    const setup = await mint(tool, ana, 'setup');
    expect(await works(setup)).toBe(200);

    const tools = await data(await call('GET', '/api/accounts/tools', { token: petar.token }));
    await call('DELETE', `/api/accounts/tools/${tools.tools[0].id}`, { token: petar.token });

    expect(await works(setup)).toBe(401);
  });

  it('ends with the session that made it, so a password change ends what a manager made', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana', 'member', false);
    const other = (await signIn('petar')).token as string;
    const setup = await mint(other, ana, 'setup');

    await call('POST', '/api/accounts/keys', { token: petar.token, body: await keysFor(PASSWORD) });

    expect(await works(setup)).toBe(401);
  });

  it('carries the limits of the tool that made it', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana', 'member', false);
    const setup = await mint(await toolToken('petar'), ana, 'setup');

    expect((await call('POST', '/api/devices/settings', { token: setup, body: { theme: 'dark' } })).status).toBe(403);
    expect((await call('GET', '/api/subtitles/account', { token: setup })).status).toBe(403);
  });

  it('ends when its maker stops being an admin', async () => {
    const petar = await register('petar');
    const bob = await addMember(petar.token, 'bob', 'admin', false);
    const bobToken = (await signIn('bob')).token as string;
    const cid = await addMember(bobToken, 'cid', 'kid', false);
    const setup = await mint(bobToken, cid, 'setup');
    expect(await works(setup)).toBe(200);

    await call('POST', `/api/family/members/${bob}`, { token: petar.token, body: { role: 'member' } });

    expect(await works(setup)).toBe(401);
  });

  it('as a household profile: never changes the password, and ends when the member leaves', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana', 'member', true);
    const profile = await mint(petar.token, ana, 'full');
    const anaToken = (await signIn('ana')).token as string;

    expect((await call('POST', '/api/accounts/keys', { token: profile, body: await keysFor('x'.repeat(12)) })).status).toBe(403);
    expect((await call('POST', '/api/family/leave', { token: profile })).status).toBe(403);

    expect((await call('POST', '/api/family/leave', { token: anaToken })).status).toBe(200);
    expect(await works(profile)).toBe(401);
    expect(await works(anaToken)).toBe(200);
  });

  it('as a household profile: ends when the member is taken out of the household', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana', 'member', true);
    const profile = await mint(petar.token, ana, 'full');

    await call('POST', `/api/family/members/${ana}`, { token: petar.token, body: { household: false } });

    expect(await works(profile)).toBe(401);
  });
});

describe('a tool and the parental lock', () => {
  const push = (token: string, settings: { key: string; value: string }[]) =>
    call('POST', '/api/devices/changes', {
      token,
      body: { settings: settings.map(setting => ({ ...setting, updatedAt: new Date().toISOString() })) }
    });

  it('may lock more, and never take a lock off or change the PIN', async () => {
    const petar = await register('petar');
    const locked = JSON.stringify({ live: ['9'], vod: [], series: [] });
    expect((await push(petar.token, [{ key: 'lockedCategories', value: locked }])).status).toBe(200);
    const tool = await toolToken('petar');

    const more = JSON.stringify({ live: ['9', '10'], vod: [], series: [] });
    expect((await push(tool, [{ key: 'lockedCategories', value: more }])).status).toBe(200);

    const fewer = JSON.stringify({ live: [], vod: [], series: [] });
    expect((await push(tool, [{ key: 'lockedCategories', value: fewer }])).status).toBe(403);
    expect((await push(tool, [{ key: 'parentalLock', value: '' }])).status).toBe(403);
    expect((await call('POST', '/api/devices/settings', { token: tool, body: { parentalLock: '' } })).status).toBe(403);
  });
});

describe('what a tool without history sees', () => {
  it('does not reach the saved subtitles, a record of what was watched', async () => {
    await register('petar');
    expect((await call('GET', '/api/subtitles', { token: await toolToken('petar') })).status).toBe(403);
    expect((await call('GET', '/api/subtitles', { token: await toolToken('petar', true) })).status).toBe(200);
  });
});

describe('what one account may keep', () => {
  it('refuses a body larger than any route takes', async () => {
    const petar = await register('petar');
    const response = await call('POST', '/api/devices/settings', { token: petar.token, raw: JSON.stringify({ big: 'x'.repeat(1_100_000) }) });
    expect(response.status).toBe(413);
  });

  it('refuses a setting larger than it keeps, and more settings than it keeps', async () => {
    const petar = await register('petar');
    expect((await call('POST', '/api/devices/settings', { token: petar.token, body: { big: 'x'.repeat(300_000) } })).status).toBe(413);

    for (let batch = 0; batch < 20; batch += 1) {
      const settings = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`key-${batch}-${n}`, 'v']));
      expect((await call('POST', '/api/devices/settings', { token: petar.token, body: settings })).status).toBe(200);
    }
    expect((await call('POST', '/api/devices/settings', { token: petar.token, body: { oneMore: 'v' } })).status).toBe(413);
    // One it already has may still change.
    expect((await call('POST', '/api/devices/settings', { token: petar.token, body: { 'key-0-0': 'w' } })).status).toBe(200);
  });
});
