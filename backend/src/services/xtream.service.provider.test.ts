import { AxiosError } from 'axios';
import zlib from 'zlib';
import { Readable } from 'stream';
import { SyncCancelledError, xtreamService } from './xtream.service';
import { AppError } from '../utils/errorHandler';
import { db } from '../utils/database';
import { TEST_USER, resetDatabase, seedCategories, seedStreams, testViewer } from '../test-utils/seed';

const SERVER = 'http://provider.example';

/** The axios instance the service holds. Stubbing it keeps tests off the network. */
const api = (xtreamService as unknown as { api: { get: jest.Mock } }).api;

const respond = (data: unknown, status = 200) => ({ status, data });

beforeEach(() => {
  resetDatabase();
  jest.spyOn(api, 'get');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('makeRequest error mapping', () => {
  it('turns a non-200 response into an error carrying that status', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond(null, 503));

    await expect(xtreamService.authenticate('joe', 'pw', SERVER)).rejects.toMatchObject({
      statusCode: 503
    });
  });

  it('rejects an empty body as a bad gateway', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond(null, 200));

    await expect(xtreamService.authenticate('joe', 'pw', SERVER)).rejects.toBeInstanceOf(AppError);
  });

  it('reports a timeout as 408', async () => {
    (api.get as jest.Mock).mockRejectedValue(
      Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' })
    );

    await expect(
      xtreamService.fetchCategoriesFromApi('joe', 'pw', 'live', SERVER)
    ).rejects.toMatchObject({ statusCode: 408 });
  });

  it('reports a request that got no answer as 502', async () => {
    (api.get as jest.Mock).mockRejectedValue(
      Object.assign(new Error('socket hang up'), { request: {} })
    );

    await expect(
      xtreamService.fetchCategoriesFromApi('joe', 'pw', 'live', SERVER)
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('refuses to build a request against an unusable server URL', async () => {
    await expect(xtreamService.fetchCategoriesFromApi('joe', 'pw', 'live', 'nonsense')).rejects.toThrow(
      /Invalid Xtream server URL/
    );
  });
});

describe('authenticate', () => {
  it('returns the provider payload on success', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      respond({ user_info: { username: 'joe', status: 'Active' }, server_info: { port: '80' } })
    );

    const result = await xtreamService.authenticate('joe', 'pw', SERVER);

    expect(result.user_info.status).toBe('Active');
  });

  it('rejects a response with no user_info as unauthorised', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond({ nothing: true }));

    await expect(xtreamService.authenticate('joe', 'pw', SERVER)).rejects.toMatchObject({
      statusCode: 401
    });
  });
});

describe('fetchCategoriesFromApi', () => {
  it('asks for the right action per stream type', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond([]));

    for (const [type, action] of [
      ['live', 'get_live_categories'],
      ['vod', 'get_vod_categories'],
      ['series', 'get_series_categories']
    ] as const) {
      await xtreamService.fetchCategoriesFromApi('joe', 'pw', type, SERVER);
      expect((api.get as jest.Mock).mock.calls.at(-1)?.[1].params.action).toBe(action);
    }
  });

  it('rejects an unsupported stream type', async () => {
    await expect(
      xtreamService.fetchCategoriesFromApi('joe', 'pw', 'radio' as never, SERVER)
    ).rejects.toThrow(/Unsupported stream type/);
  });

  it('honours a caller-supplied timeout', async () => {
    // Sync passes its own, longer one: this single list is the starting point
    // for the whole run, and losing it to the default fails everything.
    (api.get as jest.Mock).mockResolvedValue(respond([]));

    await xtreamService.fetchCategoriesFromApi('joe', 'pw', 'live', SERVER, 45000);

    expect((api.get as jest.Mock).mock.calls.at(-1)?.[1].timeout).toBe(45000);
  });

  it('is what getCategories falls back to when nothing is cached', async () => {
    // So a user who has never synced still sees content.
    (api.get as jest.Mock).mockResolvedValue(respond([{ category_id: '9', category_name: 'Live' }]));

    const categories = await xtreamService.getCategories(testViewer({ serverUrl: SERVER }), 'live');

    expect(categories.map(c => c.category_name)).toEqual(['Live']);
    expect(api.get).toHaveBeenCalled();
  });

  it('returns an empty list when the provider sends no categories', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond([]));
    expect(await xtreamService.fetchCategoriesFromApi('joe', 'pw', 'live', SERVER)).toEqual([]);
  });

  it('bypasses the cache, since sync must not read back what it is filling', async () => {
    seedCategories([{ category_id: '1', category_name: 'Cached' }]);
    (api.get as jest.Mock).mockResolvedValue(respond([{ category_id: '9', category_name: 'Fresh' }]));

    const categories = await xtreamService.fetchCategoriesFromApi(TEST_USER, 'pw', 'live', SERVER);

    expect(categories.map(c => c.category_name)).toEqual(['Fresh']);
  });
});

describe('fetchStreamsFromApi', () => {
  it('accepts the plain array most providers return', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      respond([{ stream_id: 1, name: 'One' }, { stream_id: 2, name: 'Two' }])
    );

    const streams = await xtreamService.fetchStreamsFromApi('joe', 'pw', 'live', '1', SERVER);

    expect(streams).toHaveLength(2);
  });

  it('flattens the keyed-object shape some providers return instead', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      respond({ a: [{ stream_id: 1, name: 'One' }], b: { stream_id: 2, name: 'Two' } })
    );

    const streams = await xtreamService.fetchStreamsFromApi('joe', 'pw', 'live', '1', SERVER);

    expect(streams.map(s => s.name).sort()).toEqual(['One', 'Two']);
  });

  it('drops entries with no id or name, which the cache cannot store', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      respond([
        { stream_id: 1, name: 'Good' },
        { stream_id: null, name: 'No id' },
        { stream_id: 3, name: '' }
      ])
    );

    const streams = await xtreamService.fetchStreamsFromApi('joe', 'pw', 'live', '1', SERVER);

    expect(streams.map(s => s.name)).toEqual(['Good']);
  });

  it('normalises the different field names providers use for series', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      respond([{ series_id: 5, title: 'A Show', cover: 'art.jpg', category_id: '3' }])
    );

    const [series] = await xtreamService.fetchStreamsFromApi('joe', 'pw', 'series', '3', SERVER);

    expect(series).toMatchObject({ stream_id: 5, name: 'A Show', stream_icon: 'art.jpg' });
  });

  it('filters series by category itself, since many servers ignore the parameter', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      respond([
        { series_id: 1, title: 'Wanted', category_id: '3' },
        { series_id: 2, title: 'Other category', category_id: '4' }
      ])
    );

    const streams = await xtreamService.fetchStreamsFromApi('joe', 'pw', 'series', '3', SERVER);

    expect(streams.map(s => s.name)).toEqual(['Wanted']);
  });

  it('returns nothing when the provider answers with nothing', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond([]));
    expect(await xtreamService.fetchStreamsFromApi('joe', 'pw', 'live', '1', SERVER)).toEqual([]);
  });

  it('rejects an unsupported stream type', async () => {
    await expect(
      xtreamService.fetchStreamsFromApi('joe', 'pw', 'radio' as never, '1', SERVER)
    ).rejects.toThrow(/Unsupported stream type/);
  });
});

describe('syncData', () => {
  const provider = (categories: unknown[], streams: unknown[]) =>
    (api.get as jest.Mock).mockImplementation((_url: string, opts: { params: { action: string } }) =>
      Promise.resolve(
        respond(opts.params.action.includes('categories') ? categories : streams)
      )
    );

  it('stores categories and streams for the type', async () => {
    provider(
      [{ category_id: '1', category_name: 'News' }],
      [{ stream_id: 1, name: 'BBC One', num: 101, epg_channel_id: 'chan.bbc' }]
    );

    const result = await xtreamService.syncData('live', TEST_USER, 'pw', SERVER);

    expect(result.success).toBe(true);
    expect(result.syncedItems).toBe(1);
    const row = db
      .prepare('SELECT name, num, epg_channel_id FROM streams WHERE username = ?')
      .get(TEST_USER);
    expect(row).toMatchObject({ name: 'BBC One', num: 101, epg_channel_id: 'chan.bbc' });
  });

  it('stores the provider channel number, the only basis for the provider\'s own order', async () => {
    provider([{ category_id: '1', category_name: 'News' }], [{ stream_id: 1, name: 'One', num: 42 }]);

    await xtreamService.syncData('live', TEST_USER, 'pw', SERVER);

    const { num } = db.prepare('SELECT num FROM streams WHERE username = ?').get(TEST_USER) as {
      num: number;
    };
    expect(num).toBe(42);
  });

  it('keeps the existing cache when the fetch fails', async () => {
    // The regression this guards destroyed 46,789 cached streams: the old code
    // deleted before fetching, so a failed sync left browsing with nothing.
    seedStreams([{ stream_id: 1, name: 'Previously Cached' }]);
    seedCategories([{ category_id: '1', category_name: 'Previously Cached' }]);
    (api.get as jest.Mock).mockRejectedValue(new Error('provider down'));

    const result = await xtreamService.syncData('live', TEST_USER, 'pw', SERVER);

    expect(result.success).toBe(false);
    expect(db.prepare('SELECT COUNT(*) n FROM streams WHERE username = ?').get(TEST_USER)).toEqual({
      n: 1
    });
    expect(
      db.prepare('SELECT COUNT(*) n FROM categories WHERE username = ?').get(TEST_USER)
    ).toEqual({ n: 1 });
  });

  it('records the failure as the last outcome', async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error('provider down'));

    await xtreamService.syncData('live', TEST_USER, 'pw', SERVER);

    const { status } = db
      .prepare('SELECT status FROM sync_status WHERE username = ? AND type = ?')
      .get(TEST_USER, 'live') as { status: string };
    expect(status).toBe('error');
  });

  it('replaces the previous contents rather than accumulating them', async () => {
    seedStreams([{ stream_id: 999, name: 'Gone From Provider' }]);
    provider([{ category_id: '1', category_name: 'News' }], [{ stream_id: 1, name: 'Still Here' }]);

    await xtreamService.syncData('live', TEST_USER, 'pw', SERVER);

    const names = db
      .prepare('SELECT name FROM streams WHERE username = ?')
      .all(TEST_USER)
      .map((r: unknown) => (r as { name: string }).name);
    expect(names).toEqual(['Still Here']);
  });

  it('skips a category the provider refuses and keeps the rest', async () => {
    (api.get as jest.Mock).mockImplementation((_url: string, opts: { params: Record<string, string> }) => {
      if (opts.params.action.includes('categories')) {
        return Promise.resolve(
          respond([
            { category_id: '1', category_name: 'Good' },
            { category_id: '2', category_name: 'Broken' }
          ])
        );
      }
      if (opts.params.category_id === '2') {
        return Promise.reject(new Error('category unavailable'));
      }
      return Promise.resolve(respond([{ stream_id: 1, name: 'From Good' }]));
    });

    const result = await xtreamService.syncData('live', TEST_USER, 'pw', SERVER);

    // Keeps what it could reach, but does not call the run a success: an
    // unreached category stays empty and pays a provider round trip on every
    // visit until someone re-syncs, so it has to be said out loud.
    expect(result.syncedItems).toBe(1);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/1 of 2 categories/);
    expect(result.message).toMatch(/could not be reached/);
  });

  it('reports a clean run as a success', async () => {
    provider([{ category_id: '1', category_name: 'News' }], [{ stream_id: 1, name: 'One' }]);

    const result = await xtreamService.syncData('live', TEST_USER, 'pw', SERVER);

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Synced 1 streams across 1 categories/);
  });

  it('stops asking once the provider refuses everything', async () => {
    // What got a real address blocked: the run kept asking for all 830
    // categories while every answer was a refusal.
    const categories = Array.from({ length: 200 }, (_, i) => ({
      category_id: String(i),
      category_name: `Category ${i}`
    }));

    let streamRequests = 0;
    (api.get as jest.Mock).mockImplementation((_url: string, opts: { params: { action: string } }) => {
      if (opts.params.action.includes('categories')) {
        return Promise.resolve(respond(categories));
      }
      streamRequests++;
      return Promise.resolve(respond(null, 403));
    });

    const result = await xtreamService.syncData('live', TEST_USER, 'pw', SERVER);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/stopped serving|Sync failed/i);
    // Two dead batches of five, and no retries for a refusal.
    expect(streamRequests).toBeLessThanOrEqual(10);
  });

  it('does not retry a category the provider refused outright', async () => {
    (api.get as jest.Mock).mockImplementation((_url: string, opts: { params: { action: string } }) => {
      if (opts.params.action.includes('categories')) {
        return Promise.resolve(respond([{ category_id: '1', category_name: 'One' }]));
      }
      return Promise.resolve(respond(null, 403));
    });

    await xtreamService.syncData('live', TEST_USER, 'pw', SERVER);

    // One request, not one plus a retry: a refusal will refuse again.
    const streamCalls = (api.get as jest.Mock).mock.calls.filter(
      call => !String(call[1].params.action).includes('categories')
    );
    expect(streamCalls).toHaveLength(1);
  });

  it('keeps going when only some categories fail', async () => {
    const categories = Array.from({ length: 30 }, (_, i) => ({
      category_id: String(i),
      category_name: `Category ${i}`
    }));

    (api.get as jest.Mock).mockImplementation((_url: string, opts: { params: Record<string, string> }) => {
      if (opts.params.action.includes('categories')) {
        return Promise.resolve(respond(categories));
      }
      // Every third category fails, so no batch ever fails outright.
      if (Number(opts.params.category_id) % 3 === 0) {
        return Promise.resolve(respond(null, 403));
      }
      return Promise.resolve(respond([{ stream_id: opts.params.category_id, name: 'A channel' }]));
    });

    const result = await xtreamService.syncData('live', TEST_USER, 'pw', SERVER);

    expect(result.syncedItems).toBe(20);
    expect(result.message).toMatch(/could not be reached/);
  });

  it('syncs every type when given none', async () => {
    // category_id is on the stream so the series pass, which filters by
    // category itself, keeps it too.
    provider(
      [{ category_id: '1', category_name: 'All' }],
      [{ stream_id: 1, name: 'One', category_id: '1' }]
    );

    const result = await xtreamService.syncData(undefined, TEST_USER, 'pw', SERVER);

    expect(result.details?.map(d => d.type).sort()).toEqual(['live', 'series', 'vod']);
    expect(result.syncedItems).toBe(3);
  });

  it('reports overall failure when one type fails but others succeed', async () => {
    (api.get as jest.Mock).mockImplementation((_url: string, opts: { params: { action: string } }) => {
      if (opts.params.action.includes('series')) {
        return Promise.reject(new Error('series unavailable'));
      }
      return Promise.resolve(
        respond(
          opts.params.action.includes('categories')
            ? [{ category_id: '1', category_name: 'All' }]
            : [{ stream_id: 1, name: 'One', category_id: '1' }]
        )
      );
    });

    const result = await xtreamService.syncData(undefined, TEST_USER, 'pw', SERVER);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/some errors/);
    expect(result.details?.find(d => d.type === 'live')?.success).toBe(true);
  });

  it('stops when cancelled, and marks the run cancelled rather than failed', async () => {
    provider([{ category_id: '1', category_name: 'News' }], [{ stream_id: 1, name: 'One' }]);
    // Cancel as soon as the sync registers itself.
    (api.get as jest.Mock).mockImplementationOnce(() => {
      xtreamService.cancelSync(TEST_USER);
      return Promise.resolve(respond([{ category_id: '1', category_name: 'News' }]));
    });

    await expect(xtreamService.syncData('live', TEST_USER, 'pw', SERVER)).rejects.toBeInstanceOf(
      SyncCancelledError
    );

    const { status } = db
      .prepare('SELECT status FROM sync_status WHERE username = ? AND type = ?')
      .get(TEST_USER, 'live') as { status: string };
    expect(status).toBe('cancelled');
  });

  it('reports a running sync to cancelSync, and stops tracking it afterwards', async () => {
    let seen = false;
    (api.get as jest.Mock).mockImplementation(() => {
      seen = xtreamService.cancelSync(TEST_USER);
      return Promise.resolve(respond([]));
    });

    await xtreamService.syncData('live', TEST_USER, 'pw', SERVER).catch(() => undefined);

    expect(seen).toBe(true);
    expect(xtreamService.cancelSync(TEST_USER)).toBe(false);
  });
});

describe('EPG persistence', () => {
  beforeEach(() => {
    seedStreams([{ stream_id: 1, name: 'BBC One', epg_channel_id: 'chan.bbc' }]);
  });

  const listing = (over: Record<string, unknown> = {}) =>
    respond({
      epg_listings: [
        {
          title: Buffer.from('The News', 'utf8').toString('base64'),
          description: '',
          lang: 'en',
          start_timestamp: 1767225600,
          stop_timestamp: 1767229200,
          ...over
        }
      ]
    });

  it('decodes and stores what it fetches', async () => {
    (api.get as jest.Mock).mockResolvedValue(listing());

    const epg = await xtreamService.getEPGShort(TEST_USER, 'pw', '1', SERVER);

    expect((epg as { epg_listings: Array<{ title: string }> }).epg_listings[0].title).toBe('The News');
    const stored = db
      .prepare('SELECT title, start, stop FROM epg_listings WHERE username = ?')
      .get(TEST_USER) as { title: string; start: string; stop: string };
    expect(stored.title).toBe('The News');
    expect(stored.start).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts a millisecond timestamp as well as seconds', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      listing({ start_timestamp: 1767225600000, stop_timestamp: 1767229200000 })
    );

    await xtreamService.getEPGShort(TEST_USER, 'pw', '1', SERVER);

    const { start } = db.prepare('SELECT start FROM epg_listings WHERE username = ?').get(TEST_USER) as {
      start: string;
    };
    expect(start).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts a date string', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      listing({ start_timestamp: undefined, start: '2026-03-04 20:00:00', stop_timestamp: undefined, stop: '2026-03-04 21:00:00' })
    );

    await xtreamService.getEPGShort(TEST_USER, 'pw', '1', SERVER);

    const { start } = db.prepare('SELECT start FROM epg_listings WHERE username = ?').get(TEST_USER) as {
      start: string;
    };
    expect(start).toContain('2026-03-04');
  });

  it('stores nothing for a stream the provider gave no channel id for', async () => {
    seedStreams([{ stream_id: 2, name: 'Untagged', epg_channel_id: null }]);
    (api.get as jest.Mock).mockResolvedValue(listing());

    await xtreamService.getEPGShort(TEST_USER, 'pw', '2', SERVER);

    expect(db.prepare('SELECT COUNT(*) n FROM epg_listings').get()).toEqual({ n: 0 });
  });

  it('passes a limit through on the long-form request', async () => {
    (api.get as jest.Mock).mockResolvedValue(listing());

    await xtreamService.getEPG(TEST_USER, 'pw', '1', 5, SERVER);

    expect((api.get as jest.Mock).mock.calls.at(-1)?.[1].params.limit).toBe(5);
  });

  it('returns the whole-account guide without trying to attribute it', async () => {
    (api.get as jest.Mock).mockResolvedValue(listing());

    await xtreamService.getAllEPG(TEST_USER, 'pw', SERVER);

    expect(db.prepare('SELECT COUNT(*) n FROM epg_listings').get()).toEqual({ n: 0 });
  });
});

describe('refreshEPGForStreamIds', () => {
  beforeEach(() => {
    seedStreams([
      { stream_id: 1, name: 'BBC One', epg_channel_id: 'chan.bbc' },
      { stream_id: 2, name: 'Untagged', epg_channel_id: null }
    ]);
  });

  it('does nothing when given no streams', async () => {
    expect(await xtreamService.refreshEPGForStreamIds(TEST_USER, 'pw', [], SERVER)).toEqual({
      refreshed: [],
      skipped: []
    });
  });

  it('skips a stream with no channel id, and refreshes one that has it', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond({ epg_listings: [] }));

    const result = await xtreamService.refreshEPGForStreamIds(TEST_USER, 'pw', ['1', '2'], SERVER);

    expect(result.refreshed).toEqual(['1']);
    expect(result.skipped).toEqual(['2']);
  });

  it('skips a channel whose guide is still within its TTL', async () => {
    db.prepare(
      `INSERT INTO epg_listings (epg_channel_id, start, stop, title, description, lang, username)
       VALUES ('chan.bbc', ?, ?, 'Recent', '', 'en', ?)`
    ).run(new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString(), TEST_USER);

    const result = await xtreamService.refreshEPGForStreamIds(TEST_USER, 'pw', ['1'], SERVER, 2);

    expect(result.skipped).toEqual(['1']);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('skips a stream the provider fails on rather than aborting the batch', async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error('provider down'));

    const result = await xtreamService.refreshEPGForStreamIds(TEST_USER, 'pw', ['1'], SERVER);

    expect(result).toEqual({ refreshed: [], skipped: ['1'] });
  });
});

describe('pruneOldEPG', () => {
  it('deletes listings that have already finished', async () => {
    seedStreams([{ stream_id: 1, name: 'BBC One', epg_channel_id: 'chan.bbc' }]);
    const insert = db.prepare(
      `INSERT INTO epg_listings (epg_channel_id, start, stop, title, description, lang, username)
       VALUES ('chan.bbc', ?, ?, ?, '', 'en', ?)`
    );
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    insert.run(at(-100), at(-99), 'Old', TEST_USER);
    insert.run(at(-1), at(1), 'Current', TEST_USER);

    expect(await xtreamService.pruneOldEPG(TEST_USER, 72)).toBe(1);
    expect(db.prepare('SELECT title FROM epg_listings').get()).toMatchObject({ title: 'Current' });
  });
});

describe('getNowEPGForStreamIds', () => {
  it('returns nothing for an empty request or unknown streams', async () => {
    expect(await xtreamService.getNowEPGForStreamIds(TEST_USER, [])).toEqual({});
    expect(await xtreamService.getNowEPGForStreamIds(TEST_USER, ['404'])).toEqual({});
  });

  it('maps each stream to what is on now', async () => {
    seedStreams([{ stream_id: 1, name: 'BBC One', epg_channel_id: 'chan.bbc' }]);
    db.prepare(
      `INSERT INTO epg_listings (epg_channel_id, start, stop, title, description, lang, username)
       VALUES ('chan.bbc', ?, ?, 'On Now', '', 'en', ?)`
    ).run(new Date(Date.now() - 600_000).toISOString(), new Date(Date.now() + 600_000).toISOString(), TEST_USER);

    const mapping = await xtreamService.getNowEPGForStreamIds(TEST_USER, ['1']);

    expect(mapping['1']?.title).toBe('On Now');
  });
});

describe('getExternalEPG', () => {
  const XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
    <tv>
      <channel id="chan.one"><display-name>Channel One</display-name></channel>
      <programme channel="chan.one" start="20260807222300 +0000" stop="20260807232300 +0000">
        <title>Cops &amp; Robbers</title>
        <desc>${Buffer.from('An encoded description here', 'utf8').toString('base64')}</desc>
        <category>Drama</category>
      </programme>
    </tv>`;

  const streamOf = (body: string | Buffer) => respond(Readable.from([Buffer.from(body)]));

  it('parses channels and programmes out of an XMLTV feed', async () => {
    (api.get as jest.Mock).mockResolvedValue(streamOf(XMLTV));

    const epg = await xtreamService.getExternalEPG('http://guide.example/epg.xml');

    expect(epg.channels).toEqual([{ id: 'chan.one', name: 'Channel One' }]);
    expect(epg.total).toBe(1);
    expect(epg.programmes[0]).toMatchObject({
      channel: 'chan.one',
      start: '20260807222300 +0000',
      category: 'Drama'
    });
  });

  it('decodes the HTML entities XMLTV escaping leaves behind', async () => {
    (api.get as jest.Mock).mockResolvedValue(streamOf(XMLTV));

    const epg = await xtreamService.getExternalEPG('http://guide.example/epg.xml');

    expect(epg.programmes[0].title).toBe('Cops & Robbers');
  });

  it('decodes Base64 fields, which some feeds use', async () => {
    (api.get as jest.Mock).mockResolvedValue(streamOf(XMLTV));

    const epg = await xtreamService.getExternalEPG('http://guide.example/epg.xml');

    expect(epg.programmes[0].description).toBe('An encoded description here');
  });

  it('decompresses a gzipped feed', async () => {
    (api.get as jest.Mock).mockResolvedValue(streamOf(zlib.gzipSync(Buffer.from(XMLTV))));

    const epg = await xtreamService.getExternalEPG('http://guide.example/epg.xml.gz');

    expect(epg.total).toBe(1);
  });

  it('handles a feed with a single channel and programme, not a list', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      streamOf('<tv><channel id="a"><display-name>A</display-name></channel></tv>')
    );

    const epg = await xtreamService.getExternalEPG('http://guide.example/epg.xml');

    expect(epg.channels).toHaveLength(1);
    expect(epg.programmes).toEqual([]);
  });

  it('reads a title wrapped in CDATA', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      streamOf(
        `<tv><programme channel="a" start="1" stop="2"><title><![CDATA[Late Night]]></title></programme></tv>`
      )
    );

    const epg = await xtreamService.getExternalEPG('http://guide.example/epg.xml');

    expect(epg.programmes[0].title).toBe('Late Night');
  });

  it('reads a title carrying attributes alongside its text', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      streamOf(
        `<tv><programme channel="a" start="1" stop="2"><title lang="en">Breakfast</title></programme></tv>`
      )
    );

    const epg = await xtreamService.getExternalEPG('http://guide.example/epg.xml');

    expect(epg.programmes[0].title).toBe('Breakfast');
  });

  it('takes the first usable value when a field is repeated per language', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      streamOf(
        `<tv><channel id="a"><display-name>First Name</display-name><display-name>Second Name</display-name></channel></tv>`
      )
    );

    const epg = await xtreamService.getExternalEPG('http://guide.example/epg.xml');

    expect(epg.channels[0].name).toBe('First Name');
  });

  it('leaves a missing field as an empty string', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      streamOf(`<tv><programme channel="a" start="1" stop="2"><title>Only A Title</title></programme></tv>`)
    );

    const epg = await xtreamService.getExternalEPG('http://guide.example/epg.xml');

    expect(epg.programmes[0]).toMatchObject({ description: '', category: '' });
  });

  it('strips a byte order mark rather than choking on it', async () => {
    (api.get as jest.Mock).mockResolvedValue(streamOf('﻿' + XMLTV));

    const epg = await xtreamService.getExternalEPG('http://guide.example/epg.xml');

    expect(epg.total).toBe(1);
  });

  it('rejects a malformed URL before making a request', async () => {
    await expect(xtreamService.getExternalEPG('not a url')).rejects.toMatchObject({
      statusCode: 400
    });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('reports a missing feed as a 404 naming the URL', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond(null, 404));

    await expect(xtreamService.getExternalEPG('http://guide.example/gone.xml')).rejects.toMatchObject(
      { statusCode: 404 }
    );
  });

  it('passes another server error through with its status', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond(null, 500));

    await expect(xtreamService.getExternalEPG('http://guide.example/epg.xml')).rejects.toMatchObject(
      { statusCode: 500 }
    );
  });

  it('returns the body untouched for a non-XML format', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond({ some: 'json' }));

    expect(await xtreamService.getExternalEPG('http://guide.example/epg.json', 'json')).toEqual({
      some: 'json'
    });
  });

  it('wraps a transport failure as a bad gateway', async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error('socket hang up'));

    await expect(xtreamService.getExternalEPG('http://guide.example/epg.xml')).rejects.toMatchObject(
      { statusCode: 502 }
    );
  });

  it('reports a timed-out fetch as 408', async () => {
    const timeout = new AxiosError('timeout of 60000ms exceeded', 'ECONNABORTED');
    (api.get as jest.Mock).mockRejectedValue(timeout);

    await expect(xtreamService.getExternalEPG('http://guide.example/epg.xml')).rejects.toMatchObject(
      { statusCode: 408 }
    );
  });

  it('passes an error status the guide server sent through', async () => {
    const failed = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
    failed.response = { status: 403 } as never;
    (api.get as jest.Mock).mockRejectedValue(failed);

    await expect(xtreamService.getExternalEPG('http://guide.example/epg.xml')).rejects.toMatchObject(
      { statusCode: 403 }
    );
  });

  it('reports a guide server that never answered as 502', async () => {
    const noAnswer = new AxiosError('No response', 'ECONNRESET');
    noAnswer.request = {};
    (api.get as jest.Mock).mockRejectedValue(noAnswer);

    await expect(xtreamService.getExternalEPG('http://guide.example/epg.xml')).rejects.toMatchObject(
      { statusCode: 502 }
    );
  });
});

describe('getStreamInfo and getSeriesInfo', () => {
  it('asks the provider for a single stream', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond({ info: { name: 'A Film' } }));

    const info = await xtreamService.getStreamInfo(TEST_USER, 'pw', '1', 'vod', SERVER);

    expect(info).toEqual({ info: { name: 'A Film' } });
  });

  it('asks the provider for a series', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond({ episodes: {} }));

    await xtreamService.getSeriesInfo(TEST_USER, 'pw', '7', SERVER);

    expect((api.get as jest.Mock).mock.calls.at(-1)?.[1].params).toMatchObject({
      action: 'get_series_info',
      series_id: '7'
    });
  });
});

describe('authenticate', () => {
  /**
   * These servers answer about credentials in the body, not the status line.
   * A check that only looks for user_info therefore treats a refusal as a
   * success -- and the subscription stored on the strength of it looks
   * verified while failing every request that follows.
   */
  it('refuses a wrong password, which arrives as a 200 carrying auth: 0', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      respond({ user_info: { username: 'joe', auth: 0, status: '' } })
    );

    await expect(xtreamService.authenticate('joe', 'wrong', SERVER)).rejects.toMatchObject({
      statusCode: 401
    });
  });

  it('accepts a good password', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      respond({ user_info: { username: 'joe', auth: 1, status: 'Active' } })
    );

    await expect(xtreamService.authenticate('joe', 'right', SERVER)).resolves.toMatchObject({
      user_info: { status: 'Active' }
    });
  });

  it('accepts a server that omits auth entirely when it worked', async () => {
    (api.get as jest.Mock).mockResolvedValue(
      respond({ user_info: { username: 'joe', status: 'Active' } })
    );

    await expect(xtreamService.authenticate('joe', 'right', SERVER)).resolves.toBeTruthy();
  });

  it('refuses a response with no user_info at all', async () => {
    (api.get as jest.Mock).mockResolvedValue(respond({}));

    await expect(xtreamService.authenticate('joe', 'x', SERVER)).rejects.toMatchObject({
      statusCode: 401
    });
  });
});
