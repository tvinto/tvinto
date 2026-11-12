import worker from './index';
import { Env } from './d1';
import { SALT_SECRET, keysFor } from './test-utils/keys';
import { TestD1, openTestD1 } from './test-utils/d1';
import { makeKeyPair, openWith, sealFor } from '../../shared/auth/keyPair';

/**
 * Tool sessions: the tvinto CLI signed in to an account.
 *
 * Mostly about what it cannot do. A tool is how an AI agent reaches an
 * account, and an agent can be talked into things by a channel name, so what
 * matters is that the password, invites and the family stay out of reach
 * whatever it sends, that it sees history only when that was allowed, and
 * that the account's own devices can see it and sign it out.
 */

const PASSWORD = 'a-good-long-password';
const NOW = '2026-10-11T10:00:00.000Z';

let db: TestD1;
let env: Env;

beforeEach(() => {
  db = openTestD1();
  env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };
});

afterEach(() => db.close());

const call = (method: string, path: string, options: { body?: unknown; token?: string } = {}) =>
  worker.fetch(
    new Request(`https://sync.example${path}`, {
      method,
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }),
    env
  );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = async (response: Response): Promise<any> => ((await response.json()) as { data: unknown }).data;

const register = async (username: string) => {
  const payload = await data(
    await call('POST', '/api/accounts/register', { body: { username, keys: await keysFor(PASSWORD) } })
  );
  return { token: payload.token as string, id: payload.user.id as number };
};

const signIn = async (username: string, tool?: unknown) =>
  call('POST', '/api/accounts/login', {
    body: { username, auth: (await keysFor(PASSWORD)).auth, ...(tool === undefined ? {} : { tool }) }
  });

const toolSession = async (username: string, history = false) => {
  const response = await signIn(username, { name: 'Tool on DESKTOP-1', history });
  expect(response.status).toBe(200);
  const payload = await data(response);
  return { token: payload.token as string, scope: payload.scope as string };
};

describe('signing a tool in', () => {
  it('says the service knows tools before anybody signs in', async () => {
    const health = await data(await call('GET', '/api/health'));
    expect(health.tools).toBe(true);
  });

  it('gives a tool the narrow session it asked for, and a device a full one', async () => {
    await register('petar');

    expect((await toolSession('petar')).scope).toBe('tool');
    expect((await toolSession('petar', true)).scope).toBe('tool-history');
    expect((await data(await signIn('petar'))).scope).toBe('full');
  });

  it('refuses a tool with no name, a long one, or one with control characters', async () => {
    await register('petar');

    for (const tool of [{}, { name: '' }, { name: 'x'.repeat(61) }, { name: 'Tool\non x' }, 'Tool']) {
      expect((await signIn('petar', tool)).status).toBe(400);
    }
  });

  it('refuses a wrong password for a tool exactly as for a device', async () => {
    await register('petar');
    const response = await call('POST', '/api/accounts/login', {
      body: { username: 'petar', auth: (await keysFor('not-the-password')).auth, tool: { name: 'Tool on X' } }
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { message: string }).message).toBe('Incorrect username or password');
  });
});

describe('what a tool cannot do', () => {
  it('never reaches the password or the OpenSubtitles login, nor adds, removes or resets a member', async () => {
    const petar = await register('petar');
    const pair = await makeKeyPair();
    const member = await data(
      await call('POST', '/api/family/members', {
        token: petar.token,
        body: {
          username: 'ana',
          keys: await keysFor(PASSWORD),
          role: 'member',
          household: false,
          publicKey: pair.publicKey,
          sealedPrivateKey: 'sb1$aaaa$bbbb',
          managedKeys: []
        }
      })
    );
    const { token } = await toolSession('petar', true);

    const refused: [string, string, unknown?][] = [
      ['POST', '/api/accounts/keys', await keysFor('x'.repeat(12))],
      ['POST', '/api/family/key', { publicKey: pair.publicKey, sealedPrivateKey: 'sb1$a$b' }],
      ['POST', '/api/family/managed-keys', { keys: [] }],
      ['POST', '/api/family/members', { username: 'eve' }],
      ['POST', `/api/family/members/${member.id}/password`, {}],
      ['POST', `/api/family/members/${member.id}/session`, { scope: 'full' }],
      ['POST', `/api/family/members/${member.id}/release`],
      ['DELETE', `/api/family/members/${member.id}`],
      ['POST', '/api/family/leave'],
      ['POST', '/api/family/join', { code: 'ABCD' }],
      ['GET', '/api/subtitles/account'],
      ['POST', '/api/subtitles/account', { payload: 'sb1$a$b' }],
      ['DELETE', '/api/subtitles/account'],
      ['GET', '/api/accounts/tools']
    ];
    for (const [method, path, body] of refused) {
      const response = await call(method, path, { token, body });
      expect([method, path, response.status]).toEqual([method, path, 403]);
    }

    // And nothing happened: Ana is still there, with her manager.
    const family = await data(await call('GET', '/api/family', { token: petar.token }));
    expect(family.members.map((one: { username: string }) => one.username)).toEqual(['ana']);
  });

  it("sets a member up, changes a member's role, and manages invites", async () => {
    const petar = await register('petar');
    const member = await data(
      await call('POST', '/api/family/members', {
        token: petar.token,
        body: {
          username: 'ana',
          keys: await keysFor(PASSWORD),
          role: 'member',
          household: false,
          publicKey: (await makeKeyPair()).publicKey,
          sealedPrivateKey: 'sb1$aaaa$bbbb',
          managedKeys: []
        }
      })
    );
    const { token } = await toolSession('petar');

    expect((await call('POST', `/api/family/members/${member.id}`, { token, body: { role: 'kid' } })).status).toBe(200);
    const setup = await data(await call('POST', `/api/family/members/${member.id}/session`, { token, body: { scope: 'setup' } }));
    expect(setup.scope).toBe('setup');
    expect((await call('GET', '/api/devices/settings', { token: setup.token })).status).toBe(200);

    const invite = await call('POST', '/api/accounts/invites', { token });
    expect(invite.status).toBe(201);
    expect((await data(await call('GET', '/api/accounts/invites', { token }))).length).toBe(1);

    const family = await data(await call('GET', '/api/family', { token: petar.token }));
    expect(family.members).toEqual([expect.objectContaining({ username: 'ana', role: 'kid' })]);
  });

  it('reads the family with its sealed keys, as the account itself does', async () => {
    const petar = await register('petar');
    const pair = await makeKeyPair();
    await call('POST', '/api/family/key', {
      token: petar.token,
      body: { publicKey: pair.publicKey, sealedPrivateKey: 'sb1$aaaa$bbbb' }
    });
    await call('POST', '/api/family/members', {
      token: petar.token,
      body: {
        username: 'ana',
        keys: await keysFor(PASSWORD),
        role: 'kid',
        household: true,
        publicKey: (await makeKeyPair()).publicKey,
        sealedPrivateKey: 'sb1$cccc$dddd',
        managedKeys: [{ managerId: petar.id, sealedEnc: 'pk1$aaaa$sb1$cccc$dddd' }]
      }
    });
    const { token } = await toolSession('petar');

    const family = await data(await call('GET', '/api/family', { token }));
    expect(family.me.username).toBe('petar');
    expect(family.me.sealedPrivateKey).toBe('sb1$aaaa$bbbb');
    expect(family.members).toEqual([expect.objectContaining({ username: 'ana', role: 'kid', sealedEnc: 'pk1$aaaa$sb1$cccc$dddd' })]);
  });

  it('keeps out of favourites and history unless they were allowed', async () => {
    await register('petar');
    const own = (await data(await signIn('petar'))).token as string;
    await call('POST', '/api/devices/changes', {
      token: own,
      body: {
        favourites: [{ type: 'live', streamId: '7', name: 'HRT 1', updatedAt: NOW }],
        settings: [{ key: 'theme', value: 'dark', updatedAt: NOW }]
      }
    });

    const narrow = (await toolSession('petar')).token;
    const seen = await data(await call('GET', '/api/devices/changes', { token: narrow }));
    expect(seen.favourites).toEqual([]);
    expect(seen.settings).toEqual([expect.objectContaining({ key: 'theme' })]);

    const pushed = await data(
      await call('POST', '/api/devices/changes', {
        token: narrow,
        body: {
          favourites: [{ type: 'live', streamId: '8', name: 'Planted', updatedAt: '2026-10-11T11:00:00.000Z' }],
          settings: [{ key: 'theme', value: 'light', updatedAt: '2026-10-11T11:00:00.000Z' }]
        }
      })
    );
    expect(pushed).toMatchObject({ applied: 1, superseded: 1 });

    const wide = (await toolSession('petar', true)).token;
    const all = await data(await call('GET', '/api/devices/changes', { token: wide }));
    expect(all.favourites.map((one: { streamId: string }) => one.streamId)).toEqual(['7']);
  });

  it("changes nothing on a kid's account that the kid could not", async () => {
    const petar = await register('petar');
    await call('POST', '/api/family/members', {
      token: petar.token,
      body: {
        username: 'ana',
        keys: await keysFor(PASSWORD),
        role: 'kid',
        household: false,
        publicKey: (await makeKeyPair()).publicKey,
        sealedPrivateKey: 'sb1$aaaa$bbbb',
        managedKeys: []
      }
    });
    const { token } = await toolSession('ana');

    const pushed = await data(
      await call('POST', '/api/devices/changes', {
        token,
        body: { settings: [{ key: 'hiddenCategories', value: '{"live":[]}', updatedAt: NOW }] }
      })
    );
    expect(pushed).toMatchObject({ applied: 0, superseded: 1 });
    expect((await call('POST', '/api/accounts/providers', { token, body: { id: 'p1', payload: 'sb1$x$y' } })).status).toBe(
      403
    );
  });
});

describe('signing a tool in by allowing it on a device', () => {
  /** A tool asking to be let in, as tvinto asks. */
  const ask = async (username: string, history = false) => {
    const pair = await makeKeyPair();
    const response = await call('POST', '/api/tools/requests', {
      body: { username, name: 'Tool on DESKTOP-1', history, publicKey: pair.publicKey }
    });
    return { status: response.status, pair, ...((await data(response)) as { id: string; code: string; secret: string }) };
  };

  const poll = (id: string, secret: string, confirm?: string) =>
    worker.fetch(
      new Request(`https://sync.example/api/tools/requests/${id}`, {
        headers: { 'X-Tool-Secret': secret, ...(confirm ? { 'X-Tool-Confirm': confirm } : {}) }
      }),
      env
    );

  it('hands the tool its session and key once allowed, sealed so only the tool opens them', async () => {
    const petar = await register('petar');
    const asked = await ask('petar', true);
    expect(asked.status).toBe(201);
    expect(asked.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(await data(await poll(asked.id, asked.secret))).toEqual({ status: 'pending' });

    const waiting = await data(await call('GET', '/api/accounts/tools/requests', { token: petar.token }));
    expect(waiting.requests).toEqual([expect.objectContaining({ id: asked.id, name: 'Tool on DESKTOP-1', code: asked.code, history: true })]);

    const sealedEnc = await sealFor('the-account-enc', asked.pair.publicKey);
    const allowed = await data(await call('POST', `/api/accounts/tools/requests/${asked.id}`, { token: petar.token, body: { allow: true, sealedEnc } }));
    expect(allowed.confirm).toMatch(/^[A-Z2-9]{6}$/);

    // Nothing yet without the confirmation the app showed, typed into the tool.
    expect(await data(await poll(asked.id, asked.secret))).toEqual({ status: 'confirm' });
    expect(await data(await poll(asked.id, asked.secret, 'WRONG1'))).toEqual({ status: 'confirm', wrong: true });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE scope LIKE 'tool%'").get()).toEqual({ n: 0 });

    const answered = await data(await poll(asked.id, asked.secret, allowed.confirm));
    expect(answered).toEqual(expect.objectContaining({ status: 'approved', username: 'petar' }));
    expect(await openWith(answered.sealedEnc, asked.pair.privateKey)).toBe('the-account-enc');
    const token = (await openWith(answered.sealedToken, asked.pair.privateKey))!;
    expect((await call('GET', '/api/accounts/me', { token })).status).toBe(200);
    expect((await call('POST', '/api/accounts/keys', { token, body: await keysFor('x'.repeat(12)) })).status).toBe(403);
    expect(JSON.stringify(db.raw.prepare('SELECT * FROM sessions').all())).not.toContain(token);

    // Handed over once, then gone.
    expect((await poll(asked.id, asked.secret, allowed.confirm)).status).toBe(404);
  });

  it('refuses after five wrong confirmations, and makes no session', async () => {
    const petar = await register('petar');
    const asked = await ask('petar');
    const sealedEnc = await sealFor('x', asked.pair.publicKey);
    const allowed = await data(await call('POST', `/api/accounts/tools/requests/${asked.id}`, { token: petar.token, body: { allow: true, sealedEnc } }));

    for (let tries = 0; tries < 4; tries += 1) {
      expect(await data(await poll(asked.id, asked.secret, 'WRONG1'))).toEqual({ status: 'confirm', wrong: true });
    }
    expect(await data(await poll(asked.id, asked.secret, 'WRONG1'))).toEqual({ status: 'denied' });
    expect((await poll(asked.id, asked.secret, allowed.confirm)).status).toBe(404);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE scope LIKE 'tool%'").get()).toEqual({ n: 0 });
  });

  it('answers nobody without the secret, and an unknown account exactly like a known one', async () => {
    await register('petar');
    const asked = await ask('petar');
    expect((await poll(asked.id, 'not-the-secret')).status).toBe(404);

    const nobody = await ask('nobody-here');
    expect(nobody.status).toBe(201);
    expect(Object.keys(nobody).sort()).toEqual(Object.keys(asked).sort());
    // Waiting, as a real one would be, until it runs out: asking how it went
    // says nothing about whether the account exists.
    expect(await data(await poll(nobody.id, nobody.secret))).toEqual({ status: 'pending' });
    expect((await poll(nobody.id, 'not-the-secret')).status).toBe(404);
  });

  it('tells the tool when it was refused, and makes no session', async () => {
    const petar = await register('petar');
    const asked = await ask('petar');
    await call('POST', `/api/accounts/tools/requests/${asked.id}`, { token: petar.token, body: { allow: false } });

    expect(await data(await poll(asked.id, asked.secret))).toEqual({ status: 'denied' });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE scope LIKE 'tool%'").get()).toEqual({ n: 0 });
  });

  it('is answered only by a device of that account, never by a tool or another account', async () => {
    const petar = await register('petar');
    const ana = await register('ana');
    const asked = await ask('petar');
    const tool = await toolSession('petar');
    const body = { allow: true, sealedEnc: await sealFor('x', asked.pair.publicKey) };

    expect((await call('POST', `/api/accounts/tools/requests/${asked.id}`, { token: tool.token, body })).status).toBe(403);
    expect((await call('GET', '/api/accounts/tools/requests', { token: tool.token })).status).toBe(403);
    expect((await call('POST', `/api/accounts/tools/requests/${asked.id}`, { token: ana.token, body })).status).toBe(404);
    expect((await data(await call('GET', '/api/accounts/tools/requests', { token: ana.token }))).requests).toEqual([]);
    expect((await call('POST', `/api/accounts/tools/requests/${asked.id}`, { token: petar.token, body: { allow: true } })).status).toBe(400);
  });

  it('keeps three requests waiting at most, and lets them run out after ten minutes', async () => {
    const petar = await register('petar');
    await ask('petar');
    await ask('petar');
    const third = await ask('petar');
    // A fourth is answered like any other, and waits like one, but nothing
    // is kept: refusing it would say the account exists.
    const fourth = await ask('petar');
    expect(fourth.status).toBe(201);
    expect(await data(await poll(fourth.id, fourth.secret))).toEqual({ status: 'pending' });
    expect((await data(await call('GET', '/api/accounts/tools/requests', { token: petar.token }))).requests).toHaveLength(3);

    db.raw.prepare('UPDATE tool_requests SET expires_at = ?').run('2026-01-01T00:00:00.000Z');
    expect((await poll(third.id, third.secret)).status).toBe(404);
    expect((await data(await call('GET', '/api/accounts/tools/requests', { token: petar.token }))).requests).toEqual([]);
    expect((await ask('petar')).status).toBe(201);
  });
});

describe('asking the app to do what only a person may', () => {
  it('keeps a request for the app, which does it and says so; the tool learns only that', async () => {
    const petar = await register('petar');
    const { token } = await toolSession('petar');

    const asked = await data(
      await call('POST', '/api/accounts/tools/actions', { token, body: { kind: 'add-member', details: { username: 'ana', role: 'kid' } } })
    );
    expect(await data(await call('GET', `/api/accounts/tools/actions/${asked.id}`, { token }))).toEqual({ status: 'pending' });

    const waiting = (await data(await call('GET', '/api/accounts/tools/actions', { token: petar.token }))).actions;
    expect(waiting).toEqual([
      expect.objectContaining({ id: asked.id, kind: 'add-member', toolName: 'Tool on DESKTOP-1', details: { username: 'ana', role: 'kid', household: false } })
    ]);

    await call('POST', `/api/accounts/tools/actions/${asked.id}`, { token: petar.token, body: { done: true } });
    expect(await data(await call('GET', `/api/accounts/tools/actions/${asked.id}`, { token }))).toEqual({ status: 'done' });
  });

  it('is answered only by the account itself, and asked only for what it knows', async () => {
    const petar = await register('petar');
    const ana = await register('ana');
    const { token } = await toolSession('petar');
    const asked = await data(await call('POST', '/api/accounts/tools/actions', { token, body: { kind: 'pin-off' } }));

    expect((await call('POST', `/api/accounts/tools/actions/${asked.id}`, { token, body: { done: true } })).status).toBe(403);
    expect((await call('GET', '/api/accounts/tools/actions', { token })).status).toBe(403);
    expect((await call('POST', `/api/accounts/tools/actions/${asked.id}`, { token: ana.token, body: { done: true } })).status).toBe(404);
    expect((await call('GET', `/api/accounts/tools/actions/${asked.id}`, { token: ana.token })).status).toBe(404);

    for (const body of [{ kind: 'delete-account' }, { kind: 'add-member', details: { username: 'a b', role: 'kid' } }, { kind: 'remove-member', details: {} }]) {
      expect((await call('POST', '/api/accounts/tools/actions', { token, body })).status).toBe(400);
    }
    expect((await call('POST', `/api/accounts/tools/actions/${asked.id}`, { token: petar.token, body: { done: false } })).status).toBe(200);
    expect(await data(await call('GET', `/api/accounts/tools/actions/${asked.id}`, { token }))).toEqual({ status: 'refused' });
  });
});

describe('how much a tool may change', () => {
  const settings = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({ key: `key${from + i}`, value: 'x', updatedAt: NOW }));

  it('takes thirty changes a minute from a tool, and refuses the rest with 429', async () => {
    const petar = await register('petar');
    const { token } = await toolSession('petar');

    expect((await call('POST', '/api/devices/changes', { token, body: { settings: settings(20) } })).status).toBe(200);
    const over = await call('POST', '/api/devices/changes', { token, body: { settings: settings(11, 20) } });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { message: string }).message).toContain('30 changes a minute');
    expect((await call('POST', '/api/devices/changes', { token, body: { settings: settings(10, 20) } })).status).toBe(200);

    // Nothing of the refused push arrived, and the account's own devices are not counted.
    const stored = db.raw.prepare('SELECT COUNT(*) AS n FROM user_settings').get() as { n: number };
    expect(stored.n).toBe(30);
    expect((await call('POST', '/api/devices/changes', { token: petar.token, body: { settings: settings(20, 40) } })).status).toBe(200);
  });

  it('starts counting again the next minute', async () => {
    await register('petar');
    const { token } = await toolSession('petar');
    await call('POST', '/api/devices/changes', { token, body: { settings: settings(20) } });
    db.raw.prepare("UPDATE sessions SET tool_window = '2026-10-11T09:59|30' WHERE scope = 'tool'").run();

    expect((await call('POST', '/api/devices/changes', { token, body: { settings: settings(20, 20) } })).status).toBe(200);
  });
});

describe("the account's own devices see its tools", () => {
  it('lists them, marks none as the asking device, and signs one out', async () => {
    const petar = await register('petar');
    const first = await toolSession('petar');
    await toolSession('petar', true);

    const listed = await data(await call('GET', '/api/accounts/tools', { token: petar.token }));
    expect(listed.tools).toHaveLength(2);
    expect(listed.tools[0]).toEqual(
      expect.objectContaining({ name: 'Tool on DESKTOP-1', current: false, id: expect.stringMatching(/^[0-9a-f]{16}$/) })
    );
    expect(listed.tools.map((tool: { history: boolean }) => tool.history).sort()).toEqual([false, true]);

    // Which of the two is `first`: the one without history.
    const id = listed.tools.find((tool: { history: boolean }) => !tool.history).id as string;
    expect((await call('DELETE', `/api/accounts/tools/${id}`, { token: petar.token })).status).toBe(200);
    expect((await call('GET', '/api/accounts/me', { token: first.token })).status).toBe(401);
    expect((await call('DELETE', `/api/accounts/tools/${id}`, { token: petar.token })).status).toBe(404);
  });

  it('lets a tool sign itself out and no other', async () => {
    const petar = await register('petar');
    const first = await toolSession('petar');
    const second = await toolSession('petar');
    const ids = (await data(await call('GET', '/api/accounts/tools', { token: petar.token }))).tools.map(
      (tool: { id: string }) => tool.id
    ) as string[];

    // Each id tried with the first tool's token: one is itself.
    const answers = await Promise.all(ids.map(id => call('DELETE', `/api/accounts/tools/${id}`, { token: first.token })));
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 403]);
    expect((await call('GET', '/api/accounts/me', { token: first.token })).status).toBe(401);
    expect((await call('GET', '/api/accounts/me', { token: second.token })).status).toBe(200);
  });

  it("is never another account's to sign out", async () => {
    await register('petar');
    const ana = await register('ana');
    await toolSession('petar');
    const id = (db.raw.prepare("SELECT token_hash FROM sessions WHERE scope = 'tool'").get() as { token_hash: string })
      .token_hash.slice(0, 16);

    expect((await call('DELETE', `/api/accounts/tools/${id}`, { token: ana.token })).status).toBe(404);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE scope = 'tool'").get()).toEqual({ n: 1 });
  });

  it('ends a tool after thirty days unused, and a device only after a year', async () => {
    const petar = await register('petar');
    const { token } = await toolSession('petar');
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.raw.prepare('UPDATE sessions SET last_used_at = ?').run(old);

    expect((await call('GET', '/api/accounts/me', { token })).status).toBe(401);
    expect((await call('GET', '/api/accounts/me', { token: petar.token })).status).toBe(200);
  });
});
