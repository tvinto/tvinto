import request from 'supertest';
import { createTestApp } from '../test-utils/testApp';
import { resetDatabase } from '../test-utils/seed';
import { accountsService } from '../services/accounts.service';
import { xtreamService } from '../services/xtream.service';
import { db } from '../utils/database';

const app = createTestApp();

const PASSWORD = 'a-good-long-password';
const SUBSCRIPTION = {
  serverUrl: 'http://provider.example',
  username: 'c0ffee',
  password: 'provider-secret'
};

const providerAccepts = () =>
  jest.spyOn(xtreamService, 'authenticate').mockResolvedValue({
    user_info: { username: 'c0ffee', status: 'Active' }
  } as never);

const providerRejects = () =>
  jest
    .spyOn(xtreamService, 'authenticate')
    .mockRejectedValue(Object.assign(new Error('Invalid credentials'), { statusCode: 401 }));

const providerUnreachable = () =>
  jest
    .spyOn(xtreamService, 'authenticate')
    .mockRejectedValue(Object.assign(new Error('timed out'), { statusCode: 408 }));

beforeEach(() => {
  // These tests observe a server with nobody registered on it, so the fixture
  // account the other suites rely on would be a third party in every count.
  resetDatabase({ withAccount: false });
  delete process.env.ACCOUNT_REGISTRATION;
});

afterEach(() => {
  jest.restoreAllMocks();
});

const registerVia = async (username = 'petar', password = PASSWORD) => {
  const res = await request(app).post('/api/accounts/register').send({ username, password });
  return res.body.data.token as string;
};

const authed = (method: 'get' | 'post' | 'delete', path: string, token: string) =>
  request(app)[method](path).set('Authorization', `Bearer ${token}`);

describe('POST /api/accounts/register', () => {
  it('creates the account and signs them in at once', async () => {
    const res = await request(app)
      .post('/api/accounts/register')
      .send({ username: 'petar', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.data.user.username).toBe('petar');
  });

  it('never echoes the password back', async () => {
    const res = await request(app)
      .post('/api/accounts/register')
      .send({ username: 'petar', password: PASSWORD });

    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
  });

  it('refuses a name already taken', async () => {
    await registerVia();

    const res = await request(app)
      .post('/api/accounts/register')
      .send({ username: 'PETAR', password: PASSWORD });

    expect(res.status).toBe(409);
  });

  it('refuses a weak password with a reason', async () => {
    const res = await request(app)
      .post('/api/accounts/register')
      .send({ username: 'petar', password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least 8/);
  });

  it('can be closed entirely', async () => {
    process.env.ACCOUNT_REGISTRATION = 'closed';

    const res = await request(app)
      .post('/api/accounts/register')
      .send({ username: 'petar', password: PASSWORD });

    expect(res.status).toBe(403);
  });

  it('can be left open for exactly one account', async () => {
    process.env.ACCOUNT_REGISTRATION = 'first-only';

    const first = await request(app)
      .post('/api/accounts/register')
      .send({ username: 'petar', password: PASSWORD });
    const second = await request(app)
      .post('/api/accounts/register')
      .send({ username: 'someone', password: PASSWORD });

    expect(first.status).toBe(201);
    expect(second.status).toBe(403);
  });
});

describe('POST /api/accounts/login', () => {
  it('returns a session for the right password', async () => {
    await registerVia();

    const res = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('says whether a subscription is set up, so the client knows where to go', async () => {
    const token = await registerVia();
    providerAccepts();

    const before = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', password: PASSWORD });
    expect(before.body.data.hasSubscription).toBe(false);

    await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);

    const after = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', password: PASSWORD });
    expect(after.body.data.hasSubscription).toBe(true);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    await registerVia();

    const wrongPassword = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', password: 'not-the-password' });
    const unknownUser = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'nobody', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
  });

  it('rejects a request missing either field', async () => {
    const res = await request(app).post('/api/accounts/login').send({ username: 'petar' });
    expect(res.status).toBe(400);
  });
});

describe('account routes require a session', () => {
  it('refuses every one without a token', async () => {
    const routes: Array<['get' | 'post' | 'delete', string]> = [
      ['get', '/api/accounts/me'],
      ['post', '/api/accounts/password'],
      ['get', '/api/accounts/providers'],
      ['post', '/api/accounts/providers'],
      ['get', '/api/accounts/providers/active/credentials'],
      ['delete', '/api/accounts/providers/1']
    ];

    for (const [method, path] of routes) {
      const res = await request(app)[method](path).send({});
      expect([path, res.status]).toEqual([path, 401]);
    }
  });

  it('refuses a token that is not an account session', async () => {
    const res = await authed('get', '/api/accounts/me', 'a'.repeat(64));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/accounts/me', () => {
  it('returns the account and its subscriptions without any secret', async () => {
    const token = await registerVia();
    providerAccepts();
    await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);

    const res = await authed('get', '/api/accounts/me', token);

    expect(res.body.data.user.username).toBe('petar');
    expect(res.body.data.providers).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('provider-secret');
  });
});

describe('GET /api/accounts/providers/active/credentials', () => {
  const CREDENTIALS = '/api/accounts/providers/active/credentials';

  it('hands the account its own subscription, password and all', async () => {
    const token = await registerVia();
    providerAccepts();
    await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);

    const res = await authed('get', CREDENTIALS, token);

    expect(res.status).toBe(200);
    // Deliberately the one route that returns this. A device talking to the
    // provider itself has no other way to get it: Xtream has no tokens, and
    // every request and playback URL carries the password.
    expect(res.body.data).toMatchObject({
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'provider-secret'
    });
  });

  it('says so plainly when there is no subscription to hand over', async () => {
    const token = await registerVia();

    const res = await authed('get', CREDENTIALS, token);

    // 404 rather than 401: the account is fine, it just has nothing attached.
    expect(res.status).toBe(404);
  });

  it('never hands over another account\'s subscription', async () => {
    const mine = await registerVia();
    providerAccepts();
    await authed('post', '/api/accounts/providers', mine).send(SUBSCRIPTION);

    const theirs = await registerVia('someone-else');
    const res = await authed('get', CREDENTIALS, theirs);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('provider-secret');
  });

  it('returns the renewed credentials after a subscription is replaced', async () => {
    const token = await registerVia();
    providerAccepts();
    await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);
    await authed('post', '/api/accounts/providers', token).send({
      ...SUBSCRIPTION,
      password: 'next-years-secret'
    });

    const res = await authed('get', CREDENTIALS, token);

    // The renewal case this whole account layer exists for. A device that
    // fetched the old password keeps working only if this returns the new one.
    expect(res.body.data.password).toBe('next-years-secret');
  });
});

describe('POST /api/accounts/providers', () => {
  it('stores a subscription the provider accepts', async () => {
    const token = await registerVia();
    providerAccepts();

    const res = await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);

    expect(res.status).toBe(201);
    expect(res.body.data.verified).toBe(true);
    expect(res.body.data.provider.xtreamUsername).toBe('c0ffee');
  });

  it('refuses credentials the provider rejects, rather than storing them', async () => {
    const token = await registerVia();
    providerRejects();

    const res = await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);

    expect(res.status).toBe(401);
    expect(await authed('get', '/api/accounts/providers', token).then(r => r.body.data)).toHaveLength(0);
  });

  it('stores them unverified when the provider cannot be reached', async () => {
    // An outage must not look like a typo, or nobody can set up during one.
    const token = await registerVia();
    providerUnreachable();

    const res = await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);

    expect(res.status).toBe(201);
    expect(res.body.data.verified).toBe(false);
  });

  it('renewing replaces the credentials in place', async () => {
    const token = await registerVia();
    providerAccepts();

    await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);
    await authed('post', '/api/accounts/providers', token).send({
      ...SUBSCRIPTION,
      password: 'this-years-password'
    });

    const listed = await authed('get', '/api/accounts/providers', token);
    expect(listed.body.data).toHaveLength(1);
  });

  it('rejects an incomplete subscription', async () => {
    const token = await registerVia();

    const res = await authed('post', '/api/accounts/providers', token).send({
      serverUrl: 'http://provider.example'
    });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/accounts/providers/:id', () => {
  it('removes one', async () => {
    const token = await registerVia();
    providerAccepts();
    const created = await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);

    const res = await authed('delete', `/api/accounts/providers/${created.body.data.provider.id}`, token);

    expect(res.status).toBe(200);
    expect(await authed('get', '/api/accounts/providers', token).then(r => r.body.data)).toHaveLength(0);
  });

  it('will not remove another account\'s subscription', async () => {
    const mine = await registerVia('petar');
    const theirs = await registerVia('someone');
    providerAccepts();
    const created = await authed('post', '/api/accounts/providers', theirs).send(SUBSCRIPTION);

    const res = await authed('delete', `/api/accounts/providers/${created.body.data.provider.id}`, mine);

    expect(res.status).toBe(404);
    expect(await authed('get', '/api/accounts/providers', theirs).then(r => r.body.data)).toHaveLength(1);
  });

  it('rejects an id that is not a number', async () => {
    const token = await registerVia();
    const res = await authed('delete', '/api/accounts/providers/nonsense', token);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/accounts/password', () => {
  it('changes it and hands back a fresh token', async () => {
    const token = await registerVia();

    const res = await authed('post', '/api/accounts/password', token).send({
      currentPassword: PASSWORD,
      newPassword: 'a-brand-new-password'
    });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.data.token).not.toBe(token);
  });

  it('signs other devices out, since a change often means it was known', async () => {
    const first = await registerVia();
    const second = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', password: PASSWORD })
      .then(r => r.body.data.token);

    await authed('post', '/api/accounts/password', first).send({
      currentPassword: PASSWORD,
      newPassword: 'a-brand-new-password'
    });

    expect((await authed('get', '/api/accounts/me', second)).status).toBe(401);
  });

  it('refuses without the current password', async () => {
    const token = await registerVia();

    const res = await authed('post', '/api/accounts/password', token).send({
      currentPassword: 'wrong',
      newPassword: 'a-brand-new-password'
    });

    expect(res.status).toBe(403);
  });
});

describe('a session follows the account, not the credentials', () => {
  it('picks up renewed credentials without signing in again', async () => {
    const token = await registerVia();
    providerAccepts();
    await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);

    // The subscription is renewed with a different password behind the scenes.
    await authed('post', '/api/accounts/providers', token).send({
      ...SUBSCRIPTION,
      password: 'this-years-password'
    });

    // The same token now resolves to the new credentials.
    const stored = accountsService.getActiveCredentials(
      accountsService.findByUsername('petar')!.id
    );
    expect(stored?.password).toBe('this-years-password');
  });

  it('adopts work filed under the provider username when the subscription is added', async () => {
    db.prepare('INSERT INTO favorites (username, stream_id, type) VALUES (?, ?, ?)').run(
      'c0ffee',
      '101',
      'live'
    );

    const token = await registerVia();
    providerAccepts();
    await authed('post', '/api/accounts/providers', token).send(SUBSCRIPTION);

    const user = accountsService.findByUsername('petar')!;
    const owned = db
      .prepare('SELECT COUNT(*) c FROM favorites WHERE user_id = ?')
      .get(user.id) as { c: number };
    expect(owned.c).toBe(1);
  });
});
