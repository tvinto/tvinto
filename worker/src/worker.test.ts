import { fromBase64 } from '../../shared/auth/accountKeys';
import { ChangeSet } from '../../shared/sync';
import worker from './index';
import { Env } from './d1';
import { MAX_CHANGES_PER_PUSH } from './sync';
import { SALT, SALT_SECRET, keysFor } from './test-utils/keys';
import { TestD1, openTestD1 } from './test-utils/d1';
import { bucketOf } from './test-utils/updates';

/**
 * The sync service, driven the way a device drives it.
 *
 * Through `fetch` rather than by calling handlers, because the routing, the
 * session and the CORS are as much of the thing as the SQL is -- and because
 * a Worker is, in the end, a function that takes a Request.
 *
 * D1 is SQLite, so the statements here are the statements that will run. The
 * query budget is counted (see test-utils/d1.ts) and asserted directly: fifty
 * per request is what shaped the push, and a limit nobody measures is a limit
 * nobody keeps.
 */

const PASSWORD = 'a-good-long-password';

let db: TestD1;
let env: Env;

beforeEach(() => {
  db = openTestD1();
  env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };
});

afterEach(() => db.close());

const call = (
  method: string,
  path: string,
  options: { body?: unknown; token?: string; origin?: string; address?: string } = {}
): Promise<Response> =>
  worker.fetch(
    new Request(`https://sync.example${path}`, {
      method,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.address ? { 'CF-Connecting-IP': options.address } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }),
    env
  );

const body = async (response: Response) => (await response.json()) as { data?: never; message?: string };

/** An account, signed in, as a device would get one. */
const signedIn = async (username = 'petar') => {
  const keys = await keysFor(PASSWORD);
  const response = await call('POST', '/api/accounts/register', {
    body: { username, keys }
  });

  const payload = (await response.json()) as { data: { token: string; user: { id: number } } };
  return { token: payload.data.token, userId: payload.data.user.id, keys };
};

describe('getting in', () => {
  it('registers, signs in with the key, and never sees a password', async () => {
    const keys = await keysFor(PASSWORD);

    const registered = await call('POST', '/api/accounts/register', {
      body: { username: 'petar', keys }
    });
    expect(registered.status).toBe(201);

    const signIn = await call('POST', '/api/accounts/login', {
      body: { username: 'petar', auth: keys.auth }
    });
    expect(signIn.status).toBe(200);

    const stored = db.raw.prepare('SELECT * FROM users').get() as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain('password_hash');
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    // What is kept is a hash of the key, so a copy of this row is not a
    // sign-in.
    expect(String(stored['auth_verifier'])).not.toContain(keys.auth);
  });

  it('refuses a key from the wrong password, in the usual words', async () => {
    await signedIn();
    const wrong = await keysFor('some-other-password');

    const response = await call('POST', '/api/accounts/login', {
      body: { username: 'petar', auth: wrong.auth }
    });

    expect(response.status).toBe(401);
    expect((await body(response)).message).toBe('Incorrect username or password');
  });

  it('says the same about a name with no account', async () => {
    const keys = await keysFor(PASSWORD);

    const response = await call('POST', '/api/accounts/login', {
      body: { username: 'nobody-here', auth: keys.auth }
    });

    expect(response.status).toBe(401);
    expect((await body(response)).message).toBe('Incorrect username or password');
  });

  it('will not take the same name twice, whatever the case', async () => {
    await signedIn('Petar');

    const again = await call('POST', '/api/accounts/register', {
      body: { username: 'PETAR', keys: await keysFor(PASSWORD) }
    });

    expect(again.status).toBe(409);
  });

  it('refuses a derivation weaker than the shared policy allows', async () => {
    const response = await call('POST', '/api/accounts/register', {
      body: {
        username: 'petar',
        keys: await keysFor(PASSWORD, SALT, { cost: 1024, blockSize: 8, parallelism: 1 })
      }
    });

    expect(response.status).toBe(400);
    // And no account left behind by a refused one.
    expect(db.raw.prepare('SELECT COUNT(*) c FROM users').get()).toEqual({ c: 0 });
  });

  it('says plainly that it has no password to check', async () => {
    await signedIn();

    const response = await call('POST', '/api/accounts/login', {
      body: { username: 'petar', password: PASSWORD }
    });

    // A fact about this service, not about the account, so it gives nothing
    // away -- and it tells a device that has not been updated what is wrong.
    expect(response.status).toBe(400);
    expect((await body(response)).message).toContain('derived key');
  });
});

describe('wrong tries', () => {
  const tryWith = async (password: string, address = '203.0.113.7', username = 'petar') =>
    call('POST', '/api/accounts/login', {
      body: { username, auth: (await keysFor(password)).auth },
      address
    });

  const wrongTimes = async (times: number, address?: string, username?: string) => {
    for (let i = 0; i < times; i++) {
      expect((await tryWith('not-the-password', address, username)).status).toBe(401);
    }
  };

  it('shuts the door on a name for that address after ten, even to the right password', async () => {
    await signedIn();
    await wrongTimes(10);

    const right = await tryWith(PASSWORD);

    expect(right.status).toBe(429);
    expect((await body(right)).message).toBe('Too many tries. Wait 15 minutes and try again.');
  });

  it('leaves a user of the name free to sign in from their own address', async () => {
    await signedIn();
    await wrongTimes(10, '198.51.100.1');

    expect((await tryWith(PASSWORD, '203.0.113.7')).status).toBe(200);
  });

  // Thirty password checks, each a deliberately slow hash: past Jest's five
  // seconds when the whole suite runs at once.
  it('holds one address to thirty wrong tries across names', async () => {
    await signedIn();
    for (const name of ['luigi', 'peach', 'toad']) {
      await wrongTimes(10, '198.51.100.1', name);
    }

    expect((await tryWith(PASSWORD, '198.51.100.1')).status).toBe(429);
  }, 30_000);

  it('starts the count again after a right password', async () => {
    await signedIn();
    await wrongTimes(9);
    expect((await tryWith(PASSWORD)).status).toBe(200);

    await wrongTimes(9);
    expect((await tryWith(PASSWORD)).status).toBe(200);
  });

  it('opens again once the quarter of an hour has passed, and keeps nothing older', async () => {
    await signedIn();
    await wrongTimes(10);
    db.raw.prepare('UPDATE sign_in_failures SET since = ?').run(new Date(Date.now() - 16 * 60_000).toISOString());

    expect((await tryWith(PASSWORD)).status).toBe(200);
    await wrongTimes(1, '198.51.100.9');
    // The stale counters went with that wrong try; only its own two are left.
    expect(db.raw.prepare('SELECT COUNT(*) c FROM sign_in_failures').get()).toEqual({ c: 2 });
  });

  it('keeps no address in the clear', async () => {
    await wrongTimes(1);

    const keys = db.raw.prepare('SELECT key FROM sign_in_failures').all() as Array<{ key: string }>;
    expect(keys.some(row => row.key.includes('203.0.113.7'))).toBe(false);
  });
});

describe('the salt handed out before sign-in', () => {
  it('gives an enrolled account the salt it was enrolled with', async () => {
    await signedIn();

    const response = await call('GET', '/api/accounts/salt?username=petar');
    const payload = (await response.json()) as { data: { salt: string; cost: number } };

    expect(response.status).toBe(200);
    expect(payload.data.salt).toBe(SALT);
  });

  it('answers a name with no account exactly as fully', async () => {
    const response = await call('GET', '/api/accounts/salt?username=nobody-here');
    const payload = (await response.json()) as { data: { salt: string; cost: number } };

    expect(response.status).toBe(200);
    expect(fromBase64(payload.data.salt)).toHaveLength(16);
    expect(payload.data.cost).toBeGreaterThan(0);
  });

  it('gives the same name the same answer, and different names different ones', async () => {
    const once = await (await call('GET', '/api/accounts/salt?username=nobody')).json();
    const again = await (await call('GET', '/api/accounts/salt?username=nobody')).json();
    const other = await (await call('GET', '/api/accounts/salt?username=somebody')).json();

    expect(once).toEqual(again);
    expect(once).not.toEqual(other);
  });

  it('refuses rather than inventing a secret it cannot keep', async () => {
    env = { DB: db };

    const response = await call('GET', '/api/accounts/salt?username=nobody');

    // A Worker has nowhere to put something it generated: the next isolate
    // would make a different one, and a salt that changes between two asks
    // answers the question the disguise exists to refuse.
    expect(response.status).toBe(500);
  });
});

describe('who may call what', () => {
  it('refuses everything else without a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/accounts/me'],
      ['GET', '/api/devices/changes'],
      ['POST', '/api/devices/changes'],
      ['GET', '/api/devices/settings'],
      ['GET', '/api/accounts/providers']
    ] as const) {
      const response = await call(method, path, { body: method === 'POST' ? {} : undefined });
      expect([method, response.status]).toEqual([method, 401]);
    }
  });

  // A television is off overnight. With a twelve-hour limit its owner signed
  // in again every morning.
  it('keeps a session that has not been used for a month', async () => {
    const { token } = await signedIn();
    db.raw.prepare('UPDATE sessions SET last_used_at = ?').run(
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    );

    const response = await call('GET', '/api/accounts/me', { token });
    expect(response.status).toBe(200);
  });

  it('ends a session that has not been used for over a year', async () => {
    const { token } = await signedIn();
    db.raw.prepare('UPDATE sessions SET last_used_at = ?').run(
      new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString()
    );

    const response = await call('GET', '/api/accounts/me', { token });
    expect(response.status).toBe(401);
  });

  it('refuses a token that is not one', async () => {
    const response = await call('GET', '/api/accounts/me', { token: 'not-a-real-token' });
    expect(response.status).toBe(401);
  });

  it('answers a browser only for origins it was told about', async () => {
    const allowed = await call('GET', '/api/accounts/salt?username=a', {
      origin: 'https://localhost'
    });
    const stranger = await call('GET', '/api/accounts/salt?username=a', {
      origin: 'https://somewhere-else.example'
    });

    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://localhost');
    expect(stranger.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers a preflight', async () => {
    const response = await call('OPTIONS', '/api/devices/changes', { origin: 'https://localhost' });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('has a 404 for a path it does not serve', async () => {
    const { token } = await signedIn();
    const response = await call('GET', '/api/nothing-here', { token });

    expect(response.status).toBe(404);
  });
});

describe('the change feed', () => {
  const favourite = (streamId: string, updatedAt: string) => ({
    type: 'live' as const,
    streamId,
    name: `Channel ${streamId}`,
    updatedAt
  });

  const push = (token: string, batch: Partial<ChangeSet>) =>
    call('POST', '/api/devices/changes', { token, body: batch });

  const pull = (token: string, since?: string) =>
    call('GET', `/api/devices/changes${since ? `?since=${encodeURIComponent(since)}` : ''}`, {
      token
    });

  it('carries what one device made to another', async () => {
    const { token } = await signedIn();

    const pushed = await push(token, { favourites: [favourite('101', '2026-08-30T10:00:00.000Z')] });
    expect((await pushed.json()) as never).toMatchObject({ data: { applied: 1, superseded: 0 } });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.favourites).toEqual([
      { type: 'live', streamId: '101', name: 'Channel 101', updatedAt: '2026-08-30T10:00:00.000Z' }
    ]);
  });

  it('keeps the newer of two opinions, whichever arrives second', async () => {
    const { token } = await signedIn();

    await push(token, { favourites: [favourite('101', '2026-08-30T12:00:00.000Z')] });
    const older = await push(token, { favourites: [favourite('101', '2026-08-30T10:00:00.000Z')] });

    expect((await older.json()) as never).toMatchObject({ data: { applied: 0, superseded: 1 } });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.favourites[0].updatedAt).toBe('2026-08-30T12:00:00.000Z');
  });

  describe('from a device whose clock runs ahead', () => {
    // A television box that boots believing it is next year.
    const NEXT_YEAR = '2099-01-01T00:00:00.000Z';
    const pause = () => new Promise(resolve => setTimeout(resolve, 5));

    it('counts its change as made now, so a later one from elsewhere still wins', async () => {
      const { token } = await signedIn();

      await push(token, { favourites: [favourite('101', NEXT_YEAR)] });
      await pause();
      const later = await push(token, { favourites: [{ ...favourite('101', new Date().toISOString()), name: 'Renamed' }] });

      expect((await later.json()) as never).toMatchObject({ data: { applied: 1 } });
      const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
      expect(pulled.data.favourites[0].name).toBe('Renamed');
      expect(pulled.data.favourites[0].updatedAt < NEXT_YEAR).toBe(true);
    });

    it('lets a change replace a time stamped ahead before pushes were capped', async () => {
      const { token, userId } = await signedIn();
      db.raw
        .prepare('INSERT INTO favorites (user_id, type, stream_id, name, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, 'live', '101', 'From the future', NEXT_YEAR, NEXT_YEAR);

      const now = await push(token, { favourites: [{ ...favourite('101', new Date().toISOString()), name: 'Now' }] });

      expect((await now.json()) as never).toMatchObject({ data: { applied: 1 } });
      expect(db.raw.prepare('SELECT name FROM favorites WHERE stream_id = ?').get('101')).toEqual({ name: 'Now' });
    });

    it('lets a deletion remove a row stamped ahead', async () => {
      const { token, userId } = await signedIn();
      db.raw
        .prepare('INSERT INTO favorites (user_id, type, stream_id, name, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, 'live', '101', 'From the future', NEXT_YEAR, NEXT_YEAR);

      await push(token, { deletions: [{ kind: 'favourite', key: 'live:101', deletedAt: new Date().toISOString() }] });

      expect(db.raw.prepare('SELECT COUNT(*) c FROM favorites').get()).toEqual({ c: 0 });
    });
  });

  it('makes a deletion stick', async () => {
    const { token } = await signedIn();

    await push(token, { favourites: [favourite('101', '2026-08-30T10:00:00.000Z')] });
    await push(token, {
      deletions: [{ kind: 'favourite', key: 'live:101', deletedAt: '2026-08-30T11:00:00.000Z' }]
    });

    // The row is gone, and a stale device re-pushing the old add does not
    // bring it back.
    await push(token, { favourites: [favourite('101', '2026-08-30T10:30:00.000Z')] });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.favourites).toEqual([]);
    expect(pulled.data.deletions).toHaveLength(1);
  });

  it('lets something be starred again after it was removed', async () => {
    const { token } = await signedIn();

    await push(token, {
      deletions: [{ kind: 'favourite', key: 'live:101', deletedAt: '2026-08-30T11:00:00.000Z' }]
    });
    await push(token, { favourites: [favourite('101', '2026-08-30T12:00:00.000Z')] });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.favourites).toHaveLength(1);
    // The tombstone is forgotten, or the next pull would delete it right back
    // off the device that just re-added it.
    expect(pulled.data.deletions).toEqual([]);
  });

  it('applies a removal and a re-add in the same batch, in that order', async () => {
    const { token } = await signedIn();

    await push(token, {
      favourites: [favourite('101', '2026-08-30T12:00:00.000Z')],
      deletions: [{ kind: 'favourite', key: 'live:101', deletedAt: '2026-08-30T11:00:00.000Z' }]
    });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.favourites).toHaveLength(1);
  });

  it('spends nothing on a deletion it has already recorded', async () => {
    const { token } = await signedIn();
    const deletion = {
      kind: 'favourite' as const,
      key: 'live:101',
      deletedAt: '2026-08-30T11:00:00.000Z'
    };

    await push(token, { deletions: [deletion] });

    db.resetQueryCount();
    const again = await push(token, { deletions: [deletion] });

    // A device offering a new service everything it holds re-sends every
    // tombstone it has. Writing the same row and deleting the same nothing
    // would be two statements each, out of a budget of fifty.
    expect((await again.json()) as never).toMatchObject({
      data: { applied: 0, superseded: 1 }
    });
    // The session, and the one read that decided it.
    expect(db.queries).toBe(2);
  });

  it('still records a deletion that is newer than the one it has', async () => {
    const { token } = await signedIn();

    await push(token, {
      deletions: [
        { kind: 'favourite', key: 'live:101', deletedAt: '2026-08-30T11:00:00.000Z' }
      ]
    });
    const later = await push(token, {
      deletions: [
        { kind: 'favourite', key: 'live:101', deletedAt: '2026-08-30T12:00:00.000Z' }
      ]
    });

    expect((await later.json()) as never).toMatchObject({ data: { applied: 1 } });
  });

  it('carries an arrangement whole', async () => {
    const { token } = await signedIn();

    await push(token, {
      arrangements: [
        {
          scope: 'category:live',
          itemIds: ['3', '1', '2'],
          names: { '3': 'Sport', '1': 'News' },
          updatedAt: '2026-08-30T10:00:00.000Z'
        }
      ]
    });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.arrangements[0].itemIds).toEqual(['3', '1', '2']);
    expect(pulled.data.arrangements[0].names).toEqual({ '3': 'Sport', '1': 'News' });
  });

  it('carries watch history with its details intact', async () => {
    const { token } = await signedIn();

    await push(token, {
      progress: [
        {
          type: 'series',
          itemId: '55',
          seriesId: '9',
          season: 2,
          episodeNum: 4,
          name: 'A Series',
          episodeTitle: 'An Episode',
          icon: null,
          containerExtension: 'mkv',
          positionSeconds: 1902,
          durationSeconds: 3600,
          completed: false,
          updatedAt: '2026-08-30T10:00:00.000Z'
        }
      ]
    });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.progress[0]).toMatchObject({
      itemId: '55',
      season: 2,
      episodeNum: 4,
      containerExtension: 'mkv',
      positionSeconds: 1902,
      completed: false
    });
  });

  it('hands back a cursor that does not step over a change', async () => {
    const { token } = await signedIn();

    const first = (await (await pull(token)).json()) as { data: { serverTime: string } };
    await push(token, { favourites: [favourite('101', '2026-08-30T10:00:00.000Z')] });

    const second = (await (await pull(token, first.data.serverTime)).json()) as {
      data: ChangeSet;
    };

    // The cursor lags deliberately, so a change written in the same instant as
    // a pull is delivered twice rather than never. See clock.ts.
    expect(second.data.favourites).toHaveLength(1);
  });

  it('refuses a cursor that is not a time', async () => {
    const { token } = await signedIn();
    const response = await pull(token, 'last tuesday');

    expect(response.status).toBe(400);
  });

  it('shows one account nothing of another', async () => {
    const mine = await signedIn('petar');
    const theirs = await signedIn('luigi');

    await push(mine.token, { favourites: [favourite('101', '2026-08-30T10:00:00.000Z')] });

    const pulled = (await (await pull(theirs.token)).json()) as { data: ChangeSet };
    expect(pulled.data.favourites).toEqual([]);
  });

  it('turns away a batch too big to fit the budget, and says how big', async () => {
    const { token } = await signedIn();

    const tooMany = Array.from({ length: MAX_CHANGES_PER_PUSH + 1 }, (_, index) =>
      favourite(String(index), '2026-08-30T10:00:00.000Z')
    );

    const response = await push(token, { favourites: tooMany });

    expect(response.status).toBe(413);
    // Named rather than merely refused, so a device can split to fit instead
    // of guessing at what would have been acceptable.
    expect((await body(response)).message).toContain(String(MAX_CHANGES_PER_PUSH));
  });
});

describe('guides following the account', () => {
  const push = (token: string, batch: Partial<ChangeSet>) =>
    call('POST', '/api/devices/changes', { token, body: batch });

  const pull = (token: string) => call('GET', '/api/devices/changes', { token });

  /** What the device sends: an id that says nothing, and a sealed blob. */
  const source = (id: string, updatedAt: string, payload = 'sb1$aXY=$c2VhbGVk') => ({
    id,
    payload,
    updatedAt
  });

  const mapping = (streamId: string, channelId: string, updatedAt: string) => ({
    streamId,
    sourceId: 'src-1a2b3c4d',
    channelId,
    updatedAt
  });

  it('carries a guide from one device to another', async () => {
    const { token } = await signedIn();

    await push(token, { guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z')] });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.guideSources).toEqual([
      { id: 'src-1a2b3c4d', payload: 'sb1$aXY=$c2VhbGVk', updatedAt: '2026-08-30T10:00:00.000Z' }
    ]);
  });

  it('stores the guide as something it cannot read', async () => {
    const { token } = await signedIn();
    const sealed = 'sb1$bm9uY2U=$Y2lwaGVydGV4dA==';

    await push(token, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z', sealed)]
    });

    const row = db.raw.prepare('SELECT * FROM guide_sources').get() as Record<string, unknown>;

    // The label, the URL and whether it is on are all inside the payload. An
    // Xtream guide URL carries a password in its query string, so a column
    // here holding one would undo the whole arrangement.
    expect(Object.keys(row)).not.toContain('url');
    expect(Object.keys(row)).not.toContain('label');
    expect(String(row['payload'])).toBe(sealed);
  });

  it('makes removing a guide stick', async () => {
    const { token } = await signedIn();

    await push(token, { guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z')] });
    await push(token, {
      deletions: [
        { kind: 'guideSource', key: 'src-1a2b3c4d', deletedAt: '2026-08-30T11:00:00.000Z' }
      ]
    });

    // A device that still holds it re-pushes the old version; without the
    // tombstone that would bring it back.
    await push(token, { guideSources: [source('src-1a2b3c4d', '2026-08-30T10:30:00.000Z')] });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.guideSources).toEqual([]);
  });

  it('lets a guide be added again after it was removed', async () => {
    const { token } = await signedIn();

    await push(token, {
      deletions: [
        { kind: 'guideSource', key: 'src-1a2b3c4d', deletedAt: '2026-08-30T11:00:00.000Z' }
      ]
    });
    await push(token, { guideSources: [source('src-1a2b3c4d', '2026-08-30T12:00:00.000Z')] });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.guideSources).toHaveLength(1);
    expect(pulled.data.deletions).toEqual([]);
  });

  it('carries a channel mapping in the clear, because it is not a secret', async () => {
    const { token } = await signedIn();

    await push(token, { channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')] });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.channelMappings).toEqual([
      {
        streamId: '101',
        sourceId: 'src-1a2b3c4d',
        channelId: 'HTV1.hr',
        updatedAt: '2026-08-30T10:00:00.000Z'
      }
    ]);
  });

  it('keeps one mapping per stream, replacing rather than accumulating', async () => {
    const { token } = await signedIn();

    await push(token, { channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')] });
    await push(token, {
      channelMappings: [mapping('101', 'HTV1.HD.hr', '2026-08-30T11:00:00.000Z')]
    });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.channelMappings).toHaveLength(1);
    expect(pulled.data.channelMappings[0].channelId).toBe('HTV1.HD.hr');
  });

  it('keeps the older choice when an older one arrives late', async () => {
    const { token } = await signedIn();

    await push(token, {
      channelMappings: [mapping('101', 'HTV1.HD.hr', '2026-08-30T12:00:00.000Z')]
    });
    const late = await push(token, {
      channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')]
    });

    // Work done by hand on two devices must not be lost to whichever pushed
    // second.
    expect((await late.json()) as never).toMatchObject({ data: { applied: 0, superseded: 1 } });
  });

  it('makes unmapping a channel stick', async () => {
    const { token } = await signedIn();

    await push(token, { channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')] });
    await push(token, {
      deletions: [
        { kind: 'channelMapping', key: '101', deletedAt: '2026-08-30T11:00:00.000Z' }
      ]
    });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.channelMappings).toEqual([]);
  });

  it('refuses a source or a mapping missing what identifies it', async () => {
    const { token } = await signedIn();

    const response = await push(token, {
      guideSources: [{ id: '', payload: 'sb1$x$y', updatedAt: '2026-08-30T10:00:00.000Z' }],
      channelMappings: [
        { streamId: '101', sourceId: '', channelId: 'HTV1.hr', updatedAt: '2026-08-30T10:00:00.000Z' }
      ]
    });

    // Counted as superseded rather than refused with an error: one bad entry
    // in a batch should not cost a device the rest of it.
    expect((await response.json()) as never).toMatchObject({ data: { applied: 0, superseded: 2 } });
  });

  it('shows one account nothing of another', async () => {
    const mine = await signedIn('petar');
    const theirs = await signedIn('luigi');

    await push(mine.token, { guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z')] });
    await push(mine.token, {
      channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')]
    });

    const pulled = (await (await pull(theirs.token)).json()) as { data: ChangeSet };
    expect(pulled.data.guideSources).toEqual([]);
    expect(pulled.data.channelMappings).toEqual([]);
  });
});

describe('the query budget', () => {
  /**
   * The number that shaped the push.
   *
   * Fifty per request on the free plan. The Express backend does a SELECT and
   * an INSERT per change, which would put a full batch at eighty before
   * anything else; this reads once per kind and writes in one batch.
   */
  const LIMIT = 50;

  it('stays under it for a full push of every kind at once', async () => {
    const { token } = await signedIn();

    const batch: Partial<ChangeSet> = {
      favourites: Array.from({ length: 8 }, (_, index) => ({
        type: 'live' as const,
        streamId: String(index),
        name: null,
        updatedAt: '2026-08-30T10:00:00.000Z'
      })),
      progress: Array.from({ length: 5 }, (_, index) => ({
        type: 'vod' as const,
        itemId: String(index),
        seriesId: null,
        season: null,
        episodeNum: null,
        name: 'A Film',
        episodeTitle: null,
        icon: null,
        containerExtension: null,
        positionSeconds: 10,
        durationSeconds: 100,
        completed: false,
        updatedAt: '2026-08-30T10:00:00.000Z'
      })),
      settings: [{ key: 'theme', value: 'dark', updatedAt: '2026-08-30T10:00:00.000Z' }],
      arrangements: [
        {
          scope: 'category:live',
          // 830 categories is what this account actually has. A row per
          // position would be 830 statements to save one drag.
          itemIds: Array.from({ length: 830 }, (_, index) => String(index)),
          names: {},
          updatedAt: '2026-08-30T10:00:00.000Z'
        }
      ],
      deletions: Array.from({ length: 5 }, (_, index) => ({
        kind: 'progress' as const,
        key: `vod:gone-${index}`,
        deletedAt: '2026-08-30T10:00:00.000Z'
      }))
    };

    db.resetQueryCount();
    const response = await call('POST', '/api/devices/changes', { token, body: batch });

    expect(response.status).toBe(200);
    expect(db.queries).toBeLessThan(LIMIT);
  });

  it('stays under it for a pull, whatever the account holds', async () => {
    const { token } = await signedIn();

    for (let index = 0; index < MAX_CHANGES_PER_PUSH; index += 1) {
      await call('POST', '/api/devices/changes', {
        token,
        body: {
          favourites: [
            {
              type: 'live',
              streamId: String(index),
              name: null,
              updatedAt: '2026-08-30T10:00:00.000Z'
            }
          ]
        }
      });
    }

    db.resetQueryCount();
    const response = await call('GET', '/api/devices/changes', { token });

    expect(response.status).toBe(200);
    // Six reads and a session lookup, and it does not grow with the account.
    expect(db.queries).toBeLessThan(10);
  });

  it('spends nothing on an empty push', async () => {
    const { token } = await signedIn();

    db.resetQueryCount();
    await call('POST', '/api/devices/changes', { token, body: {} });

    // One for the session, and nothing else. A device with nothing to say
    // still says it every five minutes, on four devices.
    expect(db.queries).toBe(1);
  });
});

describe('settings', () => {
  it('saves and reads them back', async () => {
    const { token } = await signedIn();

    const saved = await call('POST', '/api/devices/settings', {
      token,
      body: { theme: 'dark', sortLive: 'name' }
    });

    expect(saved.status).toBe(200);
    expect((await saved.json()) as never).toMatchObject({
      data: { theme: 'dark', sortLive: 'name' }
    });

    const read = await call('GET', '/api/devices/settings', { token });
    expect((await read.json()) as never).toMatchObject({ data: { theme: 'dark' } });
  });

  it('refuses a value that is not text', async () => {
    const { token } = await signedIn();

    const response = await call('POST', '/api/devices/settings', {
      token,
      body: { theme: 3 }
    });

    expect(response.status).toBe(400);
  });

  it('shows a saved setting in the change feed', async () => {
    const { token } = await signedIn();

    await call('POST', '/api/devices/settings', { token, body: { theme: 'dark' } });

    const pulled = (await (await call('GET', '/api/devices/changes', { token })).json()) as {
      data: ChangeSet;
    };

    expect(pulled.data.settings).toEqual([
      expect.objectContaining({ key: 'theme', value: 'dark' })
    ]);
  });
});

describe('the subscription', () => {
  it('keeps it as ciphertext and hands it back unread', async () => {
    const { token } = await signedIn();
    const payload = 'v1$aXY=$dGFn$Y2lwaGVydGV4dA==';

    const saved = await call('POST', '/api/accounts/providers', {
      token,
      body: { id: 'a1b2c3', payload }
    });
    expect(saved.status).toBe(201);

    const active = await call('GET', '/api/accounts/providers/active', { token });
    expect((await active.json()) as never).toMatchObject({ data: { id: 'a1b2c3', payload } });

    // Nothing in the row says where the provider is, who the user is there, or
    // what the password is. It cannot: this service has never held the key.
    const row = db.raw.prepare('SELECT * FROM provider_accounts').get() as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain('xtream_username');
    expect(Object.keys(row)).not.toContain('server_url');
  });

  it('replaces a subscription rather than accumulating one', async () => {
    const { token } = await signedIn();

    await call('POST', '/api/accounts/providers', { token, body: { id: 'a1', payload: 'first' } });
    await call('POST', '/api/accounts/providers', { token, body: { id: 'a1', payload: 'second' } });

    const active = await call('GET', '/api/accounts/providers/active', { token });
    expect((await active.json()) as never).toMatchObject({ data: { payload: 'second' } });
    expect(db.raw.prepare('SELECT COUNT(*) c FROM provider_accounts').get()).toEqual({ c: 1 });
  });

  it('says so plainly when there is none', async () => {
    const { token } = await signedIn();

    const response = await call('GET', '/api/accounts/providers/active', { token });

    // 409 rather than 404: the account is fine, it just has nothing to watch
    // with. The devices already send that to the subscription screen.
    expect(response.status).toBe(409);
  });

  it('tells a sign-in whether there is one', async () => {
    const { token, keys } = await signedIn();
    await call('POST', '/api/accounts/providers', { token, body: { id: 'a1', payload: 'x' } });

    const again = await call('POST', '/api/accounts/login', {
      body: { username: 'petar', auth: keys.auth }
    });

    expect((await again.json()) as never).toMatchObject({ data: { hasSubscription: true } });
  });

  it('removes one', async () => {
    const { token } = await signedIn();
    await call('POST', '/api/accounts/providers', { token, body: { id: 'a1', payload: 'x' } });

    const removed = await call('DELETE', '/api/accounts/providers/a1', { token });

    expect(removed.status).toBe(200);
    expect(db.raw.prepare('SELECT COUNT(*) c FROM provider_accounts').get()).toEqual({ c: 0 });
  });
});

describe('changing the keys', () => {
  it('takes new ones and stops accepting the old', async () => {
    const { token } = await signedIn();
    const fresh = await keysFor('an-even-better-password');

    const replaced = await call('POST', '/api/accounts/keys', { token, body: fresh });
    expect(replaced.status).toBe(200);

    const stale = await keysFor(PASSWORD);
    const refused = await call('POST', '/api/accounts/login', {
      body: { username: 'petar', auth: stale.auth }
    });
    const accepted = await call('POST', '/api/accounts/login', {
      body: { username: 'petar', auth: fresh.auth }
    });

    expect(refused.status).toBe(401);
    expect(accepted.status).toBe(200);
  });

  it("signs the account's other devices out, and keeps the one that changed it", async () => {
    const { token } = await signedIn();
    const other = (await call('POST', '/api/accounts/login', {
      body: { username: 'petar', auth: (await keysFor(PASSWORD)).auth }
    }).then(response => response.json())) as { data: { token: string } };

    await call('POST', '/api/accounts/keys', { token, body: await keysFor('an-even-better-password') });

    expect((await call('GET', '/api/accounts/me', { token })).status).toBe(200);
    expect((await call('GET', '/api/accounts/me', { token: other.data.token })).status).toBe(401);
  });
});

describe('registration can be shut', () => {
  it('closes the door when told to', async () => {
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, ACCOUNT_REGISTRATION: 'closed' };

    const response = await call('POST', '/api/accounts/register', {
      body: { username: 'petar', keys: await keysFor(PASSWORD) }
    });

    expect(response.status).toBe(403);
  });

  it('leaves it open for exactly one account when told that', async () => {
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, ACCOUNT_REGISTRATION: 'first-only' };

    const first = await call('POST', '/api/accounts/register', {
      body: { username: 'petar', keys: await keysFor(PASSWORD) }
    });
    const second = await call('POST', '/api/accounts/register', {
      body: { username: 'luigi', keys: await keysFor(PASSWORD) }
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(403);
  });

  /** What /api/health tells the sign-in page about making an account. */
  const registrationSaid = async (): Promise<unknown> =>
    ((await (await call('GET', '/api/health')).json()) as { data: { registration: unknown } }).data.registration;

  it('tells the sign-in page whether an account needs an invite', async () => {
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, ACCOUNT_REGISTRATION: 'closed' };
    expect(await registrationSaid()).toBe('invite');

    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };
    expect(await registrationSaid()).toBe('open');
  });

  it('says a new server of somebody’s own is open until its first account, then needs invites', async () => {
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, ACCOUNT_REGISTRATION: 'first-only' };
    expect(await registrationSaid()).toBe('open');

    await call('POST', '/api/accounts/register', { body: { username: 'petar', keys: await keysFor(PASSWORD) } });
    expect(await registrationSaid()).toBe('invite');
  });
});

describe('invite codes', () => {
  /** An account, made while registration was open, which then closes. */
  const inviter = async () => {
    const account = await signedIn('petar');
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, ACCOUNT_REGISTRATION: 'closed' };
    return account;
  };

  const invite = async (token: string) => {
    const response = await call('POST', '/api/accounts/invites', { token });
    expect(response.status).toBe(201);
    return (await response.json()) as { data: { id: number; code: string; expiresAt: string } };
  };

  const register = async (username: string, code?: string) =>
    call('POST', '/api/accounts/register', {
      body: { username, keys: await keysFor(PASSWORD), ...(code === undefined ? {} : { invite: code }) }
    });

  it('stops codes being guessed one after another', async () => {
    const { token } = await inviter();
    const { data } = await invite(token);
    for (let i = 0; i < 10; i++) {
      expect((await register(`guess${i}`, `AAAA-${String(i).padStart(4, 'B')}`)).status).toBe(403);
    }

    // Even the right code, from the address that guessed.
    expect((await register('luigi', data.code)).status).toBe(429);
  });

  it('lets one account through a closed registration, once', async () => {
    const { token } = await inviter();
    const { data } = await invite(token);

    expect(data.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await register('luigi', data.code)).status).toBe(201);
    expect((await register('peach', data.code)).status).toBe(403);
  });

  it('takes a code however it was typed', async () => {
    const { token } = await inviter();
    const { data } = await invite(token);

    expect((await register('luigi', ` ${data.code.replace('-', '').toLowerCase()} `)).status).toBe(201);
  });

  it('keeps a closed registration closed to anybody without one', async () => {
    await inviter();

    expect((await register('luigi')).status).toBe(403);
    expect((await register('luigi', 'AAAA-BBBB')).status).toBe(403);
  });

  it('does not spend a code on a username that is taken', async () => {
    const { token } = await inviter();
    const { data } = await invite(token);

    expect((await register('petar', data.code)).status).toBe(409);
    expect((await register('luigi', data.code)).status).toBe(201);
  });

  it('refuses a code that has run out', async () => {
    const { token } = await inviter();
    const { data } = await invite(token);
    db.raw.prepare('UPDATE invites SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());

    expect((await register('luigi', data.code)).status).toBe(403);
  });

  it('cancels a code, and says who used one', async () => {
    const { token } = await inviter();
    const used = await invite(token);
    const cancelled = await invite(token);
    await register('luigi', used.data.code);

    const revoke = await call('DELETE', `/api/accounts/invites/${cancelled.data.id}`, { token });
    expect(revoke.status).toBe(200);
    expect((await register('peach', cancelled.data.code)).status).toBe(403);

    const list = (await (await call('GET', '/api/accounts/invites', { token })).json()) as {
      data: { usedBy: string | null }[];
    };
    expect(list.data.map(entry => entry.usedBy)).toEqual(['luigi']);
  });

  it('keeps the code itself out of the database', async () => {
    const { token } = await inviter();
    const { data } = await invite(token);

    const stored = JSON.stringify(db.raw.prepare('SELECT * FROM invites').all());
    expect(stored).not.toContain(data.code.replace('-', ''));
  });

  it('holds an account to five unused codes', async () => {
    const { token } = await inviter();
    for (let i = 0; i < 5; i++) {
      await invite(token);
    }

    expect((await call('POST', '/api/accounts/invites', { token })).status).toBe(409);
  });

  it('will not cancel somebody else’s code', async () => {
    const { token } = await inviter();
    const { data } = await invite(token);
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };
    const other = await signedIn('luigi');

    await call('DELETE', `/api/accounts/invites/${data.id}`, { token: other.token });
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, ACCOUNT_REGISTRATION: 'closed' };
    expect((await register('peach', data.code)).status).toBe(201);
  });
});

describe('serving the desktop updates', () => {
  const MANIFEST = 'version: 1.0.1\nfiles:\n  - url: Xtream-Setup-1.0.1.exe\n';
  const INSTALLER = 'MZ-this-would-be-eighty-megabytes';

  const bucket = () =>
    bucketOf({ 'latest.yml': MANIFEST, 'Xtream-Setup-1.0.1.exe': INSTALLER });

  const ask = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    worker.fetch(new Request(`https://sync.example${path}`, { method, headers }), env);

  beforeEach(() => {
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, UPDATES: bucket() };
  });

  it('hands over the manifest to nobody in particular', async () => {
    // No token anywhere in this file's update tests, and that is the point: an
    // app checking for a new version has nobody signed in to it.
    const response = await ask('/updates/latest.yml');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MANIFEST);
  });

  it('ignores the cache-buster the updater puts on the end', async () => {
    // Observed, not guessed: electron-updater asks for
    // `latest.yml?noCache=<random>`, defeating a cache it does not control.
    // The query string is not part of the name of anything.
    const response = await ask('/updates/latest.yml?noCache=1k1cp5v0n');

    expect(await response.text()).toBe(MANIFEST);
  });

  it('lets the manifest be cached for a minute and the installer forever', async () => {
    // The manifest is the answer to "is there something newer", so caching it
    // is caching that answer. An installer is named after its own version and
    // cannot change, so it can be kept for good.
    const manifest = await ask('/updates/latest.yml');
    const installer = await ask('/updates/Xtream-Setup-1.0.1.exe');

    expect(manifest.headers.get('Cache-Control')).toContain('max-age=60');
    expect(manifest.headers.get('Content-Type')).toContain('yaml');
    expect(installer.headers.get('Cache-Control')).toContain('immutable');
  });

  it('answers a byte range with those bytes', async () => {
    // What makes a differential update possible: electron-updater reads the
    // blockmap, works out which blocks changed, and asks for only those. A
    // server that ignores the header still works and downloads the lot.
    const response = await ask('/updates/Xtream-Setup-1.0.1.exe', { Range: 'bytes=3-7' });

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(INSTALLER.slice(3, 8));
    expect(response.headers.get('Content-Range')).toBe(`bytes 3-7/${INSTALLER.length}`);
  });

  it('reads a suffix range as the end of the file, not the start', async () => {
    const response = await ask('/updates/Xtream-Setup-1.0.1.exe', { Range: 'bytes=-4' });

    expect(await response.text()).toBe(INSTALLER.slice(-4));
  });

  it('refuses a range that is past the end', async () => {
    const response = await ask('/updates/Xtream-Setup-1.0.1.exe', { Range: 'bytes=9000-9999' });

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe(`bytes */${INSTALLER.length}`);
  });

  it('answers a HEAD with the size and no body', async () => {
    const response = await ask('/updates/Xtream-Setup-1.0.1.exe', {}, 'HEAD');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(INSTALLER.length));
  });

  it('does not let a name be a path out of the directory', async () => {
    // One flat directory is all electron-builder writes and all this serves.
    // A name with a slash or a dot segment in it is not a typo.
    for (const name of ['..%2Fschema.sql', '.%2E%2Flatest.yml', 'sub%2Ffile.yml', 'a%00.yml']) {
      expect((await ask(`/updates/${name}`)).status).toBe(404);
    }
  });

  it('never reaches the bucket for a path that climbs out in the open', async () => {
    // `/updates/..` is not refused here, because it never arrives: the URL
    // parser resolves it to `/` and the request lands on the health route.
    // Worth a test of its own so the absence of a 404 is a recorded fact
    // rather than something that looks like a hole.
    const response = await ask('/updates/..');

    expect(await response.json()).toMatchObject({ data: { service: 'sync' } });
  });

  it('says there is no such file rather than inventing one', async () => {
    expect((await ask('/updates/Xtream-Setup-9.9.9.exe')).status).toBe(404);
  });

  it('says so plainly when no bucket is bound', async () => {
    // Not a 404: "there is no such version" and "updates are not set up here"
    // send somebody looking in opposite directions.
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };

    const response = await ask('/updates/latest.yml');

    expect(response.status).toBe(503);
  });

  it('leaves the account service alone', async () => {
    // The reason updates live on this Worker at all is that the address then
    // belongs to us. The reason that is safe is this: a bucket that is missing,
    // broken or empty cannot stop anybody signing in.
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };

    expect((await signedIn()).token).toBeTruthy();
  });
});

describe('what a caller with no session is told', () => {
  const ask = (path: string, method = 'GET') =>
    worker.fetch(new Request(`https://sync.example${path}`, { method }), env);

  beforeEach(() => {
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };
  });

  it('says there is no such endpoint rather than asking them to sign in', async () => {
    // A browser asks any page it loads for these, unprompted. They came back
    // 401, so the public downloads page logged three console errors on every
    // load -- which is how this was found.
    for (const path of ['/favicon.ico', '/apple-touch-icon.png', '/manifest.json', '/robots.txt']) {
      expect((await ask(path)).status).toBe(404);
    }
  });

  it('does not claim something is there when it is not', async () => {
    // "Sign in to continue" is a statement about a thing that exists. Saying
    // it about every path answers a question nobody asked.
    const response = await ask('/api/nothing/here');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: 'No such endpoint' });
  });

  it('still says sign in for a route that is real', async () => {
    const response = await ask('/api/devices/changes');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ message: 'Sign in to continue' });
  });

  it('says sign in for removing a provider, which names one in the path', async () => {
    // The one route whose path is not a fixed string, so the check that runs
    // before the session has to match it as a pattern.
    expect((await ask('/api/accounts/providers/sub-05a8cf30', 'DELETE')).status).toBe(401);
  });

  it('leaves the open routes open', async () => {
    expect((await ask('/api/accounts/salt?username=petar')).status).not.toBe(404);
    expect((await ask('/api/health')).status).toBe(200);
  });
});


describe('the page people install from', () => {
  const MANIFEST = 'version: 1.0.9\nfiles:\n  - url: Xtream-Setup-1.0.9.exe\n';
  const APK_MANIFEST = JSON.stringify({
    version: '1.0.1',
    versionCode: 2,
    file: 'xtream-1.0.1.apk',
    sha256: 'ab'.repeat(32)
  });

  const published = (over: Record<string, string> = {}) =>
    bucketOf({
      'latest.yml': MANIFEST,
      'Xtream-Setup-1.0.9.exe': 'MZ-this-would-be-a-hundred-megabytes',
      'android-apk.json': APK_MANIFEST,
      'xtream-1.0.1.apk': 'PK-this-would-be-a-hundred-and-seventy',
      ...over
    });

  const ask = (path: string) =>
    worker.fetch(new Request(`https://sync.example${path}`), env);

  beforeEach(() => {
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, UPDATES: published() };
  });

  it('names both versions, from the manifests rather than from itself', async () => {
    // The whole point of the page being generated: there is nothing on it for
    // a release to forget to update, so it cannot offer an old build to
    // somebody who has no way of telling.
    const body = await (await ask('/downloads')).text();

    expect(body).toContain('Version 1.0.1');
    expect(body).toContain('Version 1.0.9');
  });

  it('links to the file each manifest names', async () => {
    const body = await (await ask('/downloads')).text();

    expect(body).toContain('/updates/xtream-1.0.1.apk');
    expect(body).toContain('/updates/Xtream-Setup-1.0.9.exe');
  });

  it('gives the size and the date off the objects themselves', async () => {
    // Not out of the manifest: a manifest says what was meant to be uploaded
    // and the object is what was.
    const body = await (await ask('/downloads')).text();

    expect(body).toContain('7 September 2026');
  });

  it('prints the short address for the television', async () => {
    // Read off the request, so a copy of this reached through a shorter
    // hostname prints that hostname rather than the one it was written with.
    const body = await (
      await worker.fetch(new Request('https://x.example/downloads'), env)
    ).text();

    expect(body).toContain('x.example/a');
  });

  it('says so plainly when there is nothing to download yet', async () => {
    // The state this page is in before the first APK is published, which is
    // where it started. An empty card beats a link that 404s.
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, UPDATES: bucketOf({}) };

    const body = await (await ask('/downloads')).text();

    expect(body).toContain('No APK has been published yet');
    expect(body).toContain('No Windows installer has been published yet');
  });

  it('does not offer a file the manifest names but the bucket has not got', async () => {
    // Files go up before the manifest that names them, so this should never
    // happen -- but "never" is a property of the publishing script, and this
    // page is where somebody would find out that it had failed.
    env = {
      DB: db,
      ACCOUNT_SALT_SECRET: SALT_SECRET,
      UPDATES: bucketOf({ 'latest.yml': MANIFEST })
    };

    const body = await (await ask('/downloads')).text();

    expect(body).not.toContain('Version 1.0.9');
    expect(body).toContain('No Windows installer');
  });

  it('sends /a to the current APK', async () => {
    // One letter because it is typed with a remote control, an arrow-key
    // journey per character.
    const response = await ask('/a');

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/updates/xtream-1.0.1.apk');
  });

  it('sends /w to the current installer', async () => {
    const response = await ask('/w');

    expect(response.headers.get('Location')).toBe('/updates/Xtream-Setup-1.0.9.exe');
  });

  it('serves the APK as a package rather than as bytes', async () => {
    // Android decides whether what arrived can be installed partly by this.
    const response = await ask('/updates/xtream-1.0.1.apk');

    expect(response.headers.get('Content-Type')).toBe('application/vnd.android.package-archive');
  });

  it('lets a manifest be cached for a minute, whatever it is written in', async () => {
    // `android-latest.json` was on the immutable side of this rule until the
    // APK's manifest needed the same treatment: a year-held answer to "is
    // there a new version" is the one caching mistake that cannot be undone
    // from here.
    const response = await ask('/updates/android-apk.json');

    expect(response.headers.get('Cache-Control')).toContain('max-age=60');
  });

  it('does not cache the short address for longer than the manifest behind it', async () => {
    expect((await ask('/a')).headers.get('Cache-Control')).toContain('max-age=60');
    expect((await ask('/downloads')).headers.get('Cache-Control')).toContain('max-age=60');
  });

  it('says there is nothing there rather than redirecting nowhere', async () => {
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, UPDATES: bucketOf({}) };

    expect((await ask('/a')).status).toBe(404);
  });

  describe('with no bucket, as on a service somebody runs for themselves', () => {
    const realFetch = globalThis.fetch;
    const APK = 'https://github.com/tvinto/tvinto/releases/download/android-1.0.140/tvinto-1.0.140.apk';
    let feed: Record<string, string>;

    beforeEach(() => {
      env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };
      feed = {};
      globalThis.fetch = (async (url: string) => {
        const name = String(url).replace('https://github.com/tvinto/tvinto/releases/download/feed/', '');
        return name in feed ? new Response(feed[name]) : new Response('Not Found', { status: 404 });
      }) as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('sends /downloads to the project’s releases', async () => {
      const response = await ask('/downloads');
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://github.com/tvinto/tvinto/releases/latest');
    });

    it('sends /a to the APK the project’s feed names', async () => {
      feed['android-apk.json'] = JSON.stringify({ version: '1.0.140', file: APK });
      const response = await ask('/a');
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe(APK);
    });

    it('follows the feed nowhere but the project’s own releases, and says when it has nothing', async () => {
      expect((await ask('/w')).status).toBe(404);
      feed['android-apk.json'] = JSON.stringify({ version: '1.0.140', file: 'https://elsewhere.example/x.apk' });
      expect((await ask('/a')).status).toBe(404);
    });
  });
});

describe('the tracks a film was watched with', () => {
  const push = (token: string, batch: Partial<ChangeSet>) =>
    call('POST', '/api/devices/changes', { token, body: batch });

  const pull = (token: string) => call('GET', '/api/devices/changes', { token });

  /** Progress as a device sends it, with the parts under test filled in. */
  const watched = (over: Record<string, unknown> = {}) => ({
    type: 'vod' as const,
    itemId: '77',
    seriesId: null,
    season: null,
    episodeNum: null,
    name: 'A Film',
    episodeTitle: null,
    icon: null,
    containerExtension: 'mkv',
    positionSeconds: 600,
    durationSeconds: 5400,
    completed: false,
    updatedAt: '2026-09-06T10:00:00.000Z',
    ...over
  });

  it('travels with the resume point', async () => {
    const { token } = await signedIn();

    await push(token, {
      progress: [watched({ audioLanguage: 'eng', subtitleLanguage: 'hrv', subtitlesEnabled: true })]
    });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.progress[0]).toMatchObject({
      audioLanguage: 'eng',
      subtitleLanguage: 'hrv',
      subtitlesEnabled: true
    });
  });

  it('says nobody has chosen, rather than saying no subtitles', async () => {
    // Null and "off" are different answers: one means the account has never
    // been told, and the account preference decides; the other is a decision.
    const { token } = await signedIn();

    await push(token, { progress: [watched()] });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.progress[0]).toMatchObject({
      audioLanguage: null,
      subtitleLanguage: null,
      subtitlesEnabled: null
    });
  });

  it('is not forgotten by a device that cannot report tracks', async () => {
    // The reason the upsert coalesces. A phone whose player says nothing still
    // sends its resume point, and that must not wipe what the desktop learned.
    const { token } = await signedIn();

    await push(token, {
      progress: [watched({ subtitleLanguage: 'hrv', subtitlesEnabled: true })]
    });
    await push(token, {
      progress: [watched({ positionSeconds: 900, updatedAt: '2026-09-06T11:00:00.000Z' })]
    });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.progress[0]).toMatchObject({
      positionSeconds: 900,
      subtitleLanguage: 'hrv',
      subtitlesEnabled: true
    });
  });

  it('lets subtitles be turned off for one film and remembered that way', async () => {
    const { token } = await signedIn();

    await push(token, {
      progress: [watched({ subtitlesEnabled: true, subtitleLanguage: 'hrv' })]
    });
    await push(token, {
      progress: [watched({ subtitlesEnabled: false, updatedAt: '2026-09-06T12:00:00.000Z' })]
    });

    const pulled = (await (await pull(token)).json()) as { data: ChangeSet };
    expect(pulled.data.progress[0].subtitlesEnabled).toBe(false);
  });
});
