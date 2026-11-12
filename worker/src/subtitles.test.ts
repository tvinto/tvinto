import { MAX_SUBTITLE_BYTES, MAX_SUBTITLES_PER_ITEM, NewSubtitle, SavedSubtitle } from '../../shared/subtitles';
import worker from './index';
import { Env } from './d1';
import { SALT_SECRET, keysFor } from './test-utils/keys';
import { TestD1, openTestD1 } from './test-utils/d1';

/**
 * Subtitles on the sync service: the key handed to signed-in apps, and the
 * files each account keeps. Driven through `fetch`, as worker.test.ts is.
 */

const KEY = 'test-opensubtitles-key';

let db: TestD1;
let env: Env;

beforeEach(() => {
  db = openTestD1();
  env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET, OPENSUBTITLES_API_KEY: KEY };
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

const data = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data;

const signedIn = async (username = 'petar') => {
  const response = await call('POST', '/api/accounts/register', {
    body: { username, keys: await keysFor('a-good-long-password') }
  });
  return (await data<{ token: string }>(response)).token;
};

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nDobar dan.\n';

const film = (over: Partial<NewSubtitle> = {}): NewSubtitle => ({
  type: 'vod',
  itemId: '4512',
  name: 'Ne diraj mi mamu',
  language: 'hr',
  release: 'Ne.diraj.mi.mamu.2004.1080p.WEB-DL.x264',
  fileId: 7001,
  hearingImpaired: false,
  text: VTT,
  ...over
});

describe('the OpenSubtitles key', () => {
  it('is handed to a signed-in app', async () => {
    const token = await signedIn();
    const response = await call('GET', '/api/subtitles/config', { token });

    expect(response.status).toBe(200);
    expect(await data(response)).toEqual({ apiKey: KEY });
  });

  it('is not handed to anybody else', async () => {
    const response = await call('GET', '/api/subtitles/config');

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(KEY);
  });

  it('says there is none rather than failing when it was never set', async () => {
    env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };
    const token = await signedIn();

    expect(await data(await call('GET', '/api/subtitles/config', { token }))).toEqual({ apiKey: null });
  });
});

describe('the linked OpenSubtitles account', () => {
  const SEALED = 'sb1$AAECAwQFBgcICQoL$c2VhbGVkIGJ5dGVzIGdvIGhlcmU=';

  it('is nothing until one is linked', async () => {
    const token = await signedIn();

    expect(await data(await call('GET', '/api/subtitles/account', { token }))).toBeNull();
  });

  it('keeps a sealed login, replaces it, and forgets it', async () => {
    const token = await signedIn();

    expect((await call('POST', '/api/subtitles/account', { token, body: { payload: SEALED } })).status).toBe(200);
    expect(await data(await call('GET', '/api/subtitles/account', { token }))).toMatchObject({ payload: SEALED });

    const again = SEALED.replace('AAEC', 'ZZEC');
    await call('POST', '/api/subtitles/account', { token, body: { payload: again } });
    expect(await data(await call('GET', '/api/subtitles/account', { token }))).toMatchObject({ payload: again });
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM subtitle_accounts').get() as { n: number }).n).toBe(1);

    await call('DELETE', '/api/subtitles/account', { token });
    expect(await data(await call('GET', '/api/subtitles/account', { token }))).toBeNull();
  });

  it('refuses a login that is not sealed, so a password can never be stored in the clear', async () => {
    const token = await signedIn();

    for (const payload of [JSON.stringify({ username: 'marko.hr', password: 'tajna' }), 'sb1$only-one-part', '', 42]) {
      expect((await call('POST', '/api/subtitles/account', { token, body: { payload } })).status).toBe(400);
    }
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM subtitle_accounts').get() as { n: number }).n).toBe(0);
  });

  it('shows one account nothing of another, and asks a stranger to sign in', async () => {
    const petar = await signedIn('petar');
    const ana = await signedIn('ana');
    await call('POST', '/api/subtitles/account', { token: petar, body: { payload: SEALED } });

    expect(await data(await call('GET', '/api/subtitles/account', { token: ana }))).toBeNull();
    expect((await call('GET', '/api/subtitles/account')).status).toBe(401);
  });
});

describe('subtitles an account keeps', () => {
  it('keeps one, lists it without the text, and hands the text back on request', async () => {
    const token = await signedIn();

    const added = await call('POST', '/api/subtitles', { token, body: film() });
    expect(added.status).toBe(201);
    const saved = await data<SavedSubtitle>(added);
    expect(saved).toMatchObject({ type: 'vod', itemId: '4512', language: 'hr', fileId: 7001, offsetMs: 0 });

    const listed = await data<SavedSubtitle[]>(
      await call('GET', '/api/subtitles?type=vod&itemId=4512', { token })
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('text');

    const one = await data<{ text: string }>(await call('GET', `/api/subtitles/${saved.id}`, { token }));
    expect(one.text).toBe(VTT);
  });

  it('keeps an episode with its show, season and episode', async () => {
    const token = await signedIn();
    const episode = film({ type: 'series', itemId: '90811', seriesId: '14178', season: 3, episodeNum: 2, name: 'Friends' });

    const saved = await data<SavedSubtitle>(await call('POST', '/api/subtitles', { token, body: episode }));

    expect(saved).toMatchObject({ type: 'series', itemId: '90811', seriesId: '14178', season: 3, episodeNum: 2 });
  });

  it('replaces the same file for the same item, keeping its id and offset', async () => {
    const token = await signedIn();
    const first = await data<SavedSubtitle>(await call('POST', '/api/subtitles', { token, body: film() }));
    await call('POST', `/api/subtitles/${first.id}`, { token, body: { offsetMs: 1500 } });

    const again = await call('POST', '/api/subtitles', { token, body: film({ release: 'renamed' }) });

    expect(again.status).toBe(200);
    expect(await data(again)).toMatchObject({ id: first.id, offsetMs: 1500, release: 'renamed' });
    expect(await data<unknown[]>(await call('GET', '/api/subtitles', { token }))).toHaveLength(1);
  });

  it('saves an offset, and refuses one a minute out', async () => {
    const token = await signedIn();
    const saved = await data<SavedSubtitle>(await call('POST', '/api/subtitles', { token, body: film() }));

    const nudged = await call('POST', `/api/subtitles/${saved.id}`, { token, body: { offsetMs: -2500 } });
    expect(await data(nudged)).toMatchObject({ offsetMs: -2500 });

    const silly = await call('POST', `/api/subtitles/${saved.id}`, { token, body: { offsetMs: 61_000 } });
    expect(silly.status).toBe(400);
  });

  it('removes one', async () => {
    const token = await signedIn();
    const saved = await data<SavedSubtitle>(await call('POST', '/api/subtitles', { token, body: film() }));

    expect((await call('DELETE', `/api/subtitles/${saved.id}`, { token })).status).toBe(200);
    expect((await call('GET', `/api/subtitles/${saved.id}`, { token })).status).toBe(404);
    expect((await call('DELETE', `/api/subtitles/${saved.id}`, { token })).status).toBe(404);
  });

  it('shows one account nothing of another', async () => {
    const petar = await signedIn('petar');
    const ana = await signedIn('ana');
    const saved = await data<SavedSubtitle>(await call('POST', '/api/subtitles', { token: petar, body: film() }));

    expect(await data<unknown[]>(await call('GET', '/api/subtitles', { token: ana }))).toEqual([]);
    expect((await call('GET', `/api/subtitles/${saved.id}`, { token: ana })).status).toBe(404);
    expect((await call('POST', `/api/subtitles/${saved.id}`, { token: ana, body: { offsetMs: 500 } })).status).toBe(404);
    expect((await call('DELETE', `/api/subtitles/${saved.id}`, { token: ana })).status).toBe(404);
  });

  it('refuses what is not a WebVTT file, or too big to keep', async () => {
    const token = await signedIn();

    const srt = await call('POST', '/api/subtitles', { token, body: film({ text: '1\n00:00:01,000 --> 00:00:03,000\nHi\n' }) });
    expect(srt.status).toBe(400);

    const huge = await call('POST', '/api/subtitles', { token, body: film({ text: VTT + 'x'.repeat(MAX_SUBTITLE_BYTES) }) });
    expect(huge.status).toBe(413);
  });

  it('refuses what does not say which item or file it is', async () => {
    const token = await signedIn();

    for (const bad of [
      film({ type: 'live' as never }),
      film({ itemId: '' }),
      film({ fileId: 0 }),
      film({ language: 'Croatian, please' }),
      film({ release: '' })
    ]) {
      expect((await call('POST', '/api/subtitles', { token, body: bad })).status).toBe(400);
    }
    expect((await call('GET', '/api/subtitles?type=vod', { token })).status).toBe(400);
  });

  it('stops at a sensible number for one title', async () => {
    const token = await signedIn();
    for (let file = 1; file <= MAX_SUBTITLES_PER_ITEM; file++) {
      expect((await call('POST', '/api/subtitles', { token, body: film({ fileId: file }) })).status).toBe(201);
    }

    const one = await call('POST', '/api/subtitles', { token, body: film({ fileId: 999 }) });
    expect(one.status).toBe(409);
    // Replacing one already kept is still fine.
    expect((await call('POST', '/api/subtitles', { token, body: film({ fileId: 1 }) })).status).toBe(200);
  });

  it('needs a session, and says so rather than 404', async () => {
    expect((await call('GET', '/api/subtitles')).status).toBe(401);
    expect((await call('POST', '/api/subtitles', { body: film() })).status).toBe(401);
    expect((await call('DELETE', '/api/subtitles/0b7c8d4e-aaaa-bbbb-cccc-1234567890ab')).status).toBe(401);
    expect((await call('GET', '/api/subtitles/../accounts')).status).toBe(404);
  });

  it('spends a handful of queries, not fifty', async () => {
    const token = await signedIn();
    db.resetQueryCount();

    const saved = await data<SavedSubtitle>(await call('POST', '/api/subtitles', { token, body: film() }));
    const adding = db.queries;
    expect(adding).toBeLessThanOrEqual(5);

    db.resetQueryCount();
    await call('GET', `/api/subtitles/${saved.id}`, { token });
    expect(db.queries).toBeLessThanOrEqual(3);
  });
});
