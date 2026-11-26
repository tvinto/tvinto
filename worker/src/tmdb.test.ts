import worker from './index';
import { Env } from './d1';
import { SALT_SECRET, keysFor } from './test-utils/keys';
import { TestD1, openTestD1 } from './test-utils/d1';

/** The TMDB key, handed out as the OpenSubtitles one is. */

const KEY = 'tmdb-test-key';

let db: TestD1;
let env: Env;

beforeEach(() => {
  db = openTestD1();
  env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, TMDB_API_KEY: KEY };
});

afterEach(() => db.close());

const call = (path: string, token?: string, method = 'GET', body?: unknown) =>
  worker.fetch(
    new Request(`https://sync.example${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    }),
    env
  );

const signedIn = async (username = 'petar'): Promise<string> => {
  const response = await worker.fetch(
    new Request('https://sync.example/api/accounts/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, keys: await keysFor('a-good-long-password') })
    }),
    env
  );
  return ((await response.json()) as { data: { token: string } }).data.token;
};

describe('the TMDB key', () => {
  it('is handed to a signed-in app', async () => {
    const response = await call('/api/tmdb/config', await signedIn());

    expect(await response.json()).toMatchObject({ data: { apiKey: KEY } });
  });

  it('is not handed to anybody else', async () => {
    const response = await call('/api/tmdb/config');

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(KEY);
  });

  it('says there is none rather than failing when it was never set', async () => {
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };

    const response = await call('/api/tmdb/config', await signedIn());

    expect(await response.json()).toMatchObject({ data: { apiKey: null } });
  });
});

describe("an account's own TMDB key", () => {
  const SEALED = 'sb1$bWFkZS11cA==$bm90LWEta2V5';

  it('is kept sealed and handed back to the same account', async () => {
    const token = await signedIn();
    expect(await (await call('/api/tmdb/key', token)).json()).toMatchObject({ data: null });

    expect((await call('/api/tmdb/key', token, 'POST', { payload: SEALED })).status).toBe(200);

    expect(await (await call('/api/tmdb/key', token)).json()).toMatchObject({ data: { payload: SEALED } });
  });

  it('is refused in the clear', async () => {
    const response = await call('/api/tmdb/key', await signedIn(), 'POST', { payload: 'deadbeefdeadbeefdeadbeefdeadbeef' });

    expect(response.status).toBe(400);
  });

  it('is gone once removed, and is never another account’s', async () => {
    const token = await signedIn();
    await call('/api/tmdb/key', token, 'POST', { payload: SEALED });
    env = { ...env, ACCOUNT_REGISTRATION: 'open' };
    const other = await signedIn('ana');

    expect(await (await call('/api/tmdb/key', other)).json()).toMatchObject({ data: null });
    await call('/api/tmdb/key', token, 'DELETE');
    expect(await (await call('/api/tmdb/key', token)).json()).toMatchObject({ data: null });
  });
});
