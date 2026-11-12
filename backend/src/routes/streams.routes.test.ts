import request from 'supertest';
import { createTestApp } from '../test-utils/testApp';
import { xtreamService } from '../services/xtream.service';
import { sessionStore } from '../utils/sessions';
import { playbackTickets } from '../utils/playbackTickets';
import {
  TEST_USER,
  TEST_USER_ID,
  resetDatabase,
  seedCategories,
  seedEPG,
  seedStreams
} from '../test-utils/seed';
import { accountsService } from '../services/accounts.service';

const app = createTestApp();
let token: string;

beforeEach(() => {
  resetDatabase();
  // A session names the account; requireSession reads its subscription to get
  // the credentials, so the fixture account needs one.
  accountsService.addProviderAccount(TEST_USER_ID, {
    serverUrl: 'http://provider.example',
    username: TEST_USER,
    password: 'hunter2'
  });
  token = sessionStore.createForUser(TEST_USER_ID);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const authed = (method: 'get' | 'post' | 'delete', path: string) =>
  request(app)[method](path).set('Authorization', `Bearer ${token}`);

describe('authentication', () => {
  it('refuses every account endpoint without a session', async () => {
    const routes: Array<[('get' | 'post' | 'delete'), string]> = [
      ['get', '/api/streams/categories/live'],
      ['get', '/api/streams/live/1'],
      ['post', '/api/streams/search'],
      ['get', '/api/streams/favorites'],
      ['post', '/api/streams/favorites'],
      ['delete', '/api/streams/favorites'],
      ['get', '/api/streams/order'],
      ['post', '/api/streams/order'],
      ['post', '/api/streams/play/ticket'],
      ['get', '/api/streams/epg-now'],
      ['post', '/api/sync'],
      ['get', '/api/sync/status/live'],
      ['post', '/api/sync/cancel']
    ];

    for (const [method, path] of routes) {
      const res = await request(app)[method](path).send({});
      expect([path, res.status]).toEqual([path, 401]);
    }
  });
});

describe('GET /api/streams/categories/:type', () => {
  beforeEach(() => {
    seedCategories([
      { category_id: '2', category_name: 'Sport' },
      { category_id: '1', category_name: 'News' }
    ]);
  });

  it('returns the cached categories', async () => {
    const res = await authed('get', '/api/streams/categories/live');

    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { category_name: string }) => c.category_name)).toEqual([
      'News',
      'Sport'
    ]);
  });

  it('honours a sort parameter', async () => {
    const res = await authed('get', '/api/streams/categories/live?sort=name_desc');
    expect(res.body.data[0].category_name).toBe('Sport');
  });

  it('falls back to the default sort when the client sends nonsense', async () => {
    const res = await authed('get', '/api/streams/categories/live?sort=by_vibes');

    expect(res.status).toBe(200);
    expect(res.body.data[0].category_name).toBe('News');
  });

  it('reports a lookup failure as a 500', async () => {
    jest.spyOn(xtreamService, 'getCategories').mockRejectedValue(new Error('provider down'));

    const res = await authed('get', '/api/streams/categories/live');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/streams/:type/:categoryId', () => {
  it('returns the cached streams for a category', async () => {
    seedStreams([
      { stream_id: 1, name: 'Zulu TV', category_id: '7' },
      { stream_id: 2, name: 'Alpha TV', category_id: '7' }
    ]);

    const res = await authed('get', '/api/streams/live/7');

    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { name: string }) => s.name)).toEqual(['Alpha TV', 'Zulu TV']);
  });

  it('reports a provider failure as a 500 rather than crashing', async () => {
    jest.spyOn(xtreamService, 'fetchStreamsFromApi').mockRejectedValue(new Error('provider down'));

    const res = await authed('get', '/api/streams/live/empty');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/streams/search', () => {
  beforeEach(() => {
    seedStreams([{ stream_id: 1, name: 'BBC One' }]);
  });

  it('searches the cache', async () => {
    const res = await authed('post', '/api/streams/search').send({ query: 'bbc', types: ['live'] });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('reports a search failure as a 500', async () => {
    jest.spyOn(xtreamService, 'searchStreamsInDatabase').mockRejectedValue(new Error('db locked'));

    const res = await authed('post', '/api/streams/search').send({ query: 'bbc', types: ['live'] });

    expect(res.status).toBe(500);
  });

  it('rejects a search with no query or no types', async () => {
    expect((await authed('post', '/api/streams/search').send({ types: ['live'] })).status).toBe(400);
    expect((await authed('post', '/api/streams/search').send({ query: 'bbc', types: [] })).status).toBe(400);
  });
});

describe('favourites', () => {
  beforeEach(() => {
    seedStreams([{ stream_id: 1, name: 'BBC One' }]);
  });

  it('adds, lists and removes a favourite', async () => {
    const added = await authed('post', '/api/streams/favorites').send({ streamId: '1', type: 'live' });
    expect(added.status).toBe(200);
    expect(added.body.data).toEqual({ streamId: '1', favorite: true });

    const ids = await authed('get', '/api/streams/favorites/ids?type=live');
    expect(ids.body.data).toEqual(['1']);

    const list = await authed('get', '/api/streams/favorites?type=live');
    expect(list.body.data.map((s: { name: string }) => s.name)).toEqual(['BBC One']);

    const removed = await authed('delete', '/api/streams/favorites').send({ streamId: '1', type: 'live' });
    expect(removed.body.data).toEqual({ streamId: '1', favorite: false });
    expect((await authed('get', '/api/streams/favorites/ids?type=live')).body.data).toEqual([]);
  });

  it('rejects an add or remove without both parameters', async () => {
    expect((await authed('post', '/api/streams/favorites').send({ type: 'live' })).status).toBe(400);
    expect((await authed('delete', '/api/streams/favorites').send({ streamId: '1' })).status).toBe(400);
  });

  it('defaults to live when no type is given', async () => {
    const res = await authed('get', '/api/streams/favorites/ids');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('manual ordering', () => {
  it('saves and returns a category arrangement', async () => {
    const saved = await authed('post', '/api/streams/order').send({
      kind: 'category',
      type: 'live',
      itemIds: ['3', '1', '2']
    });

    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ scope: 'category:live', saved: 3 });

    const read = await authed('get', '/api/streams/order?kind=category&type=live');
    expect(read.body.data).toEqual({ scope: 'category:live', itemIds: ['3', '1', '2'] });
  });

  it('scopes a stream arrangement to its category', async () => {
    const saved = await authed('post', '/api/streams/order').send({
      kind: 'stream',
      type: 'live',
      categoryId: '7',
      itemIds: ['2', '1']
    });

    expect(saved.body.data.scope).toBe('stream:live:7');
  });

  it('refuses a stream arrangement with no category to scope to', async () => {
    const res = await authed('post', '/api/streams/order').send({
      kind: 'stream',
      type: 'live',
      itemIds: ['1']
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Missing or invalid ordering scope');
  });

  it('refuses an unknown scope kind, and a save without a list', async () => {
    expect((await authed('get', '/api/streams/order?kind=nonsense&type=live')).status).toBe(400);
    expect((await authed('get', '/api/streams/order')).status).toBe(400);
    expect(
      (await authed('post', '/api/streams/order').send({ kind: 'category', type: 'live' })).status
    ).toBe(400);
  });
});

describe('playback', () => {
  it('issues a ticket whose URL carries a media extension', async () => {
    // An extensionless URL makes hls.js sit out and the browser choke on the
    // manifest, so the suffix is load-bearing.
    const live = await authed('post', '/api/streams/play/ticket').send({
      type: 'live',
      streamId: '42'
    });

    expect(live.status).toBe(200);
    expect(live.body.data.url).toMatch(/^\/api\/streams\/play\/[0-9a-f]{48}\.m3u8$/);

    const vod = await authed('post', '/api/streams/play/ticket').send({
      type: 'vod',
      streamId: '42',
      extension: 'mkv'
    });
    expect(vod.body.data.url).toMatch(/\.mkv$/);
  });

  it('never puts the session token in the playback URL', async () => {
    const res = await authed('post', '/api/streams/play/ticket').send({
      type: 'live',
      streamId: '42'
    });

    expect(res.body.data.url).not.toContain(token);
  });

  it('rejects a ticket request missing a type or stream', async () => {
    expect((await authed('post', '/api/streams/play/ticket').send({ type: 'live' })).status).toBe(400);
    expect((await authed('post', '/api/streams/play/ticket').send({ streamId: '1' })).status).toBe(400);
  });

  it('redirects a ticket to the provider URL without needing a header', async () => {
    const issued = await authed('post', '/api/streams/play/ticket').send({
      type: 'live',
      streamId: '42'
    });

    // No Authorization header: a <video> element cannot send one.
    const res = await request(app).get(issued.body.data.url).redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://provider.example/live/tester/hunter2/42.m3u8');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('refuses a ticket it never issued', async () => {
    const res = await request(app).get('/api/streams/play/made-up.m3u8');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Playback link expired or invalid');
  });

  it('refuses a ticket whose session has ended', async () => {
    const issued = await authed('post', '/api/streams/play/ticket').send({
      type: 'live',
      streamId: '42'
    });
    sessionStore.destroy(token);

    const res = await request(app).get(issued.body.data.url).redirects(0);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Session expired or invalid');
  });

  it('refuses an expired ticket', async () => {
    const ticket = playbackTickets.issue(token, { type: 'live', streamId: '42' });
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);

    const res = await request(app).get(`/api/streams/play/${ticket}.m3u8`).redirects(0);

    expect(res.status).toBe(401);
  });
});

describe('EPG endpoints', () => {
  beforeEach(() => {
    seedStreams([{ stream_id: 1, name: 'BBC One', epg_channel_id: 'chan.bbc' }]);
  });

  it('returns what is on now from the cache', async () => {
    seedEPG('chan.bbc', { startsInHours: -0.5, endsInHours: 0.5, title: 'The News' });

    const res = await authed('get', '/api/streams/epg-now');

    expect(res.status).toBe(200);
    expect(res.body.data.some((row: { title: string }) => row.title === 'The News')).toBe(true);
  });

  it('returns stored listings for the streams asked about', async () => {
    seedEPG('chan.bbc', { startsInHours: 1, endsInHours: 2, title: 'Later' });

    const res = await authed('post', '/api/streams/epg/db').send({ streamIds: ['1'] });

    expect(res.status).toBe(200);
    expect(res.body.data['1'][0].title).toBe('Later');
  });

  it('rejects the batch endpoints without a list of streams', async () => {
    expect((await authed('post', '/api/streams/epg/db').send({})).status).toBe(400);
    expect((await authed('post', '/api/streams/epg-now/streams').send({ streamIds: [] })).status).toBe(400);
    expect((await authed('post', '/api/streams/epg/refresh').send({})).status).toBe(400);
  });

  it('returns the guide for one stream, long and short form', async () => {
    const epg = { epg_listings: [{ title: 'Tonight' }] };
    jest.spyOn(xtreamService, 'getEPG').mockResolvedValue(epg as never);
    jest.spyOn(xtreamService, 'getEPGShort').mockResolvedValue(epg as never);

    expect((await authed('get', '/api/streams/epg/1?limit=5')).body.data).toEqual(epg);
    expect((await authed('get', '/api/streams/epg-short/1')).body.data).toEqual(epg);
  });

  it('returns the whole-account guide', async () => {
    jest.spyOn(xtreamService, 'getAllEPG').mockResolvedValue({ epg_listings: [] } as never);

    expect((await authed('get', '/api/streams/epg-all')).status).toBe(200);
  });

  it('reports a provider failure on the guide endpoints as a 500', async () => {
    jest.spyOn(xtreamService, 'getEPG').mockRejectedValue(new Error('down'));
    jest.spyOn(xtreamService, 'getEPGShort').mockRejectedValue(new Error('down'));
    jest.spyOn(xtreamService, 'getAllEPG').mockRejectedValue(new Error('down'));
    jest.spyOn(xtreamService, 'getNowEPGForUser').mockRejectedValue(new Error('down'));

    expect((await authed('get', '/api/streams/epg/1')).status).toBe(500);
    expect((await authed('get', '/api/streams/epg-short/1')).status).toBe(500);
    expect((await authed('get', '/api/streams/epg-all')).status).toBe(500);
    expect((await authed('get', '/api/streams/epg-now')).status).toBe(500);
  });

  it('refreshes the guide for the streams asked about', async () => {
    jest
      .spyOn(xtreamService, 'refreshEPGForStreamIds')
      .mockResolvedValue({ refreshed: ['1'], skipped: [] });

    const res = await authed('post', '/api/streams/epg/refresh').send({ streamIds: ['1'] });

    expect(res.status).toBe(200);
    expect(res.body.data.refreshed).toEqual(['1']);
  });

  it('returns what is on now for the streams asked about', async () => {
    seedEPG('chan.bbc', { startsInHours: -0.5, endsInHours: 0.5, title: 'On Now' });

    const res = await authed('post', '/api/streams/epg-now/streams').send({ streamIds: ['1'] });

    expect(res.status).toBe(200);
    expect(res.body.data['1'].title).toBe('On Now');
  });

  it('prunes old listings', async () => {
    const res = await authed('delete', '/api/streams/epg/prune?olderThanHours=1');

    expect(res.status).toBe(200);
    expect(typeof res.body.data.deleted).toBe('number');
  });
});

describe('stream and series info', () => {
  it('returns stream info', async () => {
    jest.spyOn(xtreamService, 'getStreamInfo').mockResolvedValue({ name: 'A Film' } as never);

    const res = await authed('get', '/api/streams/info?stream_id=1&type=vod');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ name: 'A Film' });
  });

  it('returns series info', async () => {
    jest.spyOn(xtreamService, 'getSeriesInfo').mockResolvedValue({ episodes: {} } as never);

    expect((await authed('get', '/api/streams/series/info/7')).status).toBe(200);
  });

  it('rejects stream info without both parameters', async () => {
    expect((await authed('get', '/api/streams/info?stream_id=1')).status).toBe(400);
    expect((await authed('get', '/api/streams/info?type=vod')).status).toBe(400);
  });

  it('reports a provider failure as a 500', async () => {
    jest.spyOn(xtreamService, 'getStreamInfo').mockRejectedValue(new Error('down'));
    jest.spyOn(xtreamService, 'getSeriesInfo').mockRejectedValue(new Error('down'));

    expect((await authed('get', '/api/streams/info?stream_id=1&type=vod')).status).toBe(500);
    expect((await authed('get', '/api/streams/series/info/7')).status).toBe(500);
  });
});

describe('POST /api/streams/epg/external', () => {
  it('needs a session: it makes this server fetch an address the caller chose', async () => {
    jest.spyOn(xtreamService, 'getExternalEPG').mockResolvedValue({ total: 0 });

    const res = await request(app)
      .post('/api/streams/epg/external')
      .send({ url: 'http://guide.example/epg.xml' });

    expect(res.status).toBe(401);
  });

  it('fetches for a signed-in caller', async () => {
    jest.spyOn(xtreamService, 'getExternalEPG').mockResolvedValue({ total: 0 });

    const res = await authed('post', '/api/streams/epg/external').send({ url: 'http://guide.example/epg.xml' });

    expect(res.status).toBe(200);
  });

  it('rejects a request with no URL', async () => {
    const res = await authed('post', '/api/streams/epg/external').send({});
    expect(res.status).toBe(400);
  });

  it('reports a fetch failure as a 500', async () => {
    jest.spyOn(xtreamService, 'getExternalEPG').mockRejectedValue(new Error('unreachable'));

    const res = await authed('post', '/api/streams/epg/external').send({ url: 'http://guide.example/epg.xml' });

    expect(res.status).toBe(500);
  });
});

describe('sync', () => {
  it('reports status for a type', async () => {
    seedStreams([{ stream_id: 1, name: 'One' }]);

    const res = await authed('get', '/api/sync/status/live');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: 'live', synced: true, totalStreams: 1 });
  });

  it('reports a status lookup failure as a 500', async () => {
    jest.spyOn(xtreamService, 'getSyncStatus').mockRejectedValue(new Error('db locked'));

    expect((await authed('get', '/api/sync/status/live')).status).toBe(500);
  });

  it('answers a cancel for an account with nothing running', async () => {
    const res = await authed('post', '/api/sync/cancel');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false, message: 'No active sync found' });
  });

  it('returns 499 when a sync is cancelled mid-flight', async () => {
    const { SyncCancelledError } = await import('../services/xtream.service');
    jest.spyOn(xtreamService, 'syncData').mockRejectedValue(new SyncCancelledError());

    const res = await authed('post', '/api/sync').send({ type: 'live' });

    expect(res.status).toBe(499);
    expect(res.body.success).toBe(false);
  });

  it('reports a sync failure as a 500', async () => {
    jest.spyOn(xtreamService, 'syncData').mockRejectedValue(new Error('provider down'));

    const res = await authed('post', '/api/sync').send({ type: 'live' });

    expect(res.status).toBe(500);
  });

  it('passes a successful sync through', async () => {
    jest.spyOn(xtreamService, 'syncData').mockResolvedValue({
      success: true,
      syncedItems: 12,
      details: []
    } as never);

    const res = await authed('post', '/api/sync').send({});

    expect(res.status).toBe(200);
    expect(res.body.syncedItems).toBe(12);
  });
});
