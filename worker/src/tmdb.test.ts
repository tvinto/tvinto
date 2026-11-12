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

const call = (path: string, token?: string) =>
  worker.fetch(
    new Request(`https://sync.example${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }),
    env
  );

const signedIn = async (): Promise<string> => {
  const response = await worker.fetch(
    new Request('https://sync.example/api/accounts/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'petar', keys: await keysFor('a-good-long-password') })
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
