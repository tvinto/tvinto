import { xtreamService } from './xtream.service';
import { AppError } from '../utils/errorHandler';
import { TEST_USER, TEST_USER_ID, resetDatabase, seedCategories, seedEPG, seedEPGAttempt, seedStreams, testViewer } from '../test-utils/seed';
import { db } from '../utils/database';

const credentials = { username: 'joe', password: 'hunter2' };

beforeEach(() => {
  resetDatabase();
});

describe('buildPlaybackUrl', () => {
  it('builds the provider URL for each stream type', () => {
    const base = { ...credentials, serverUrl: 'http://provider.example' };

    expect(xtreamService.buildPlaybackUrl(base, 'live', '42')).toBe(
      'http://provider.example/live/joe/hunter2/42.m3u8'
    );
    expect(xtreamService.buildPlaybackUrl(base, 'vod', '42')).toBe(
      'http://provider.example/movie/joe/hunter2/42.mp4'
    );
    expect(xtreamService.buildPlaybackUrl(base, 'series', '42')).toBe(
      'http://provider.example/series/joe/hunter2/42.mp4'
    );
  });

  it('honours an explicit extension', () => {
    // hls.js only engages when the URL looks like a manifest, so the extension
    // is load-bearing rather than cosmetic.
    const url = xtreamService.buildPlaybackUrl(
      { ...credentials, serverUrl: 'http://provider.example' },
      'live',
      '42',
      'ts'
    );
    expect(url).toBe('http://provider.example/live/joe/hunter2/42.ts');
  });

  it('strips the API path, since playback lives at the server root', () => {
    const url = xtreamService.buildPlaybackUrl(
      { ...credentials, serverUrl: 'http://provider.example/player_api.php' },
      'live',
      '42'
    );
    expect(url).toBe('http://provider.example/live/joe/hunter2/42.m3u8');
  });

  it('tolerates a trailing slash on the server URL', () => {
    const url = xtreamService.buildPlaybackUrl(
      { ...credentials, serverUrl: 'http://provider.example/' },
      'live',
      '42'
    );
    expect(url).toBe('http://provider.example/live/joe/hunter2/42.m3u8');
  });

  it('rejects an unusable server URL rather than building a broken one', () => {
    expect(() =>
      xtreamService.buildPlaybackUrl({ ...credentials, serverUrl: 'not a url' }, 'live', '42')
    ).toThrow(AppError);
  });

  it('rejects an unsupported stream type', () => {
    expect(() =>
      xtreamService.buildPlaybackUrl(
        { ...credentials, serverUrl: 'http://provider.example' },
        'radio' as never,
        '42'
      )
    ).toThrow(/Unsupported stream type/);
  });
});

describe('getCategories', () => {
  beforeEach(() => {
    seedCategories([
      { category_id: '3', category_name: 'Sport' },
      { category_id: '1', category_name: 'News' },
      { category_id: '2', category_name: 'Movies' }
    ]);
  });

  it('serves from the cache without touching the provider', async () => {
    // The provider URL is unreachable by design: a network call would throw.
    const categories = await xtreamService.getCategories(testViewer(), 'live');
    expect(categories.map(c => c.category_name)).toEqual(['Movies', 'News', 'Sport']);
  });

  it('sorts by name descending', async () => {
    const categories = await xtreamService.getCategories(testViewer(), 'live', 'name_desc');
    expect(categories.map(c => c.category_name)).toEqual(['Sport', 'News', 'Movies']);
  });

  it('applies a saved manual arrangement', async () => {
    xtreamService.saveManualOrder(TEST_USER_ID, 'category:live', ['3', '1', '2']);

    const categories = await xtreamService.getCategories(testViewer(), 'live', 'manual');
    expect(categories.map(c => c.category_name)).toEqual(['Sport', 'News', 'Movies']);
  });

  it('appends categories the user never arranged, rather than dropping them', async () => {
    // The case a later sync creates: new content must stay visible.
    xtreamService.saveManualOrder(TEST_USER_ID, 'category:live', ['3']);

    const categories = await xtreamService.getCategories(testViewer(), 'live', 'manual');
    expect(categories[0].category_name).toBe('Sport');
    expect(categories.map(c => c.category_name).sort()).toEqual(['Movies', 'News', 'Sport']);
  });

  it('leaves the natural order alone when nothing has been arranged', async () => {
    const categories = await xtreamService.getCategories(testViewer(), 'live', 'manual');
    expect(categories).toHaveLength(3);
  });

  it('keeps another account\'s categories out of the result', async () => {
    seedCategories([{ category_id: '9', category_name: 'Someone Else' }], 'live', 'other-user');

    const categories = await xtreamService.getCategories(testViewer(), 'live');
    expect(categories.map(c => c.category_id)).not.toContain('9');
  });
});

describe('getStreams', () => {
  beforeEach(() => {
    seedStreams([
      { stream_id: 1, name: 'Channel 10', num: 10, added: '1700000300' },
      { stream_id: 2, name: 'Channel 2', num: 2, added: '1700000100' },
      { stream_id: 3, name: 'channel 1', num: null, added: '1700000200' }
    ]);
  });

  const names = async (sort: Parameters<typeof xtreamService.getStreams>[3]) =>
    (await xtreamService.getStreams(testViewer(), 'live', '1', sort)).map(s => s.name);

  it('sorts names digit-aware, so Channel 2 precedes Channel 10', async () => {
    expect(await names('name_asc')).toEqual(['channel 1', 'Channel 2', 'Channel 10']);
  });

  it('sorts names descending', async () => {
    expect(await names('name_desc')).toEqual(['Channel 10', 'Channel 2', 'channel 1']);
  });

  it('sinks unnumbered channels below numbered ones', async () => {
    // Otherwise every channel without a number collides at position zero.
    expect(await names('number')).toEqual(['Channel 2', 'Channel 10', 'channel 1']);
  });

  it('sorts by date added in both directions', async () => {
    expect(await names('added_desc')).toEqual(['Channel 10', 'channel 1', 'Channel 2']);
    expect(await names('added_asc')).toEqual(['Channel 2', 'channel 1', 'Channel 10']);
  });

  it('applies a manual arrangement scoped to the category', async () => {
    xtreamService.saveManualOrder(TEST_USER_ID, 'stream:live:1', ['3', '1', '2']);
    expect(await names('manual')).toEqual(['channel 1', 'Channel 10', 'Channel 2']);
  });

  it('falls back to name order when a manual sort has no category to scope to', async () => {
    // A manual arrangement is stored per category, so an unscoped listing has
    // nothing to apply and must not return the provider's arbitrary order.
    jest.spyOn(xtreamService, 'fetchStreamsFromApi').mockResolvedValue([
      { stream_id: 1, name: 'Zulu' },
      { stream_id: 2, name: 'Alpha' }
    ] as never);

    const streams = await xtreamService.getStreams(testViewer(), 'live', undefined, 'manual');

    expect(streams.map(s => s.name)).toEqual(['Alpha', 'Zulu']);
    jest.restoreAllMocks();
  });

  // Browsing goes through the shared catalogue now, so these stub the one
  // thing beneath it that touches a network rather than a method in between.
  const api = (xtreamService as unknown as { api: { get: jest.Mock } }).api;
  const provider = (streams: unknown[]) =>
    jest.spyOn(api, 'get').mockResolvedValue({ status: 200, data: streams });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reaches the provider only when the cache has nothing for the category', async () => {
    const fetch = provider([]);

    await xtreamService.getStreams(testViewer(), 'live', '1');
    expect(fetch).not.toHaveBeenCalled();

    await xtreamService.getStreams(testViewer(), 'live', 'empty-category');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps what it had to fetch, so the next visit is served from the cache', async () => {
    // Sync can leave a category empty, and without this every visit to it pays
    // the provider round trip again.
    const fetch = provider([
      { stream_id: 90, name: 'Fetched One', num: 5, epg_channel_id: 'chan.90' },
      { stream_id: 91, name: 'Fetched Two' }
    ]);

    const first = await xtreamService.getStreams(testViewer(), 'live', 'cold');
    expect(first.map(s => s.name)).toEqual(['Fetched One', 'Fetched Two']);
    expect(fetch).toHaveBeenCalledTimes(1);

    const second = await xtreamService.getStreams(testViewer(), 'live', 'cold');
    expect(second.map(s => s.name)).toEqual(['Fetched One', 'Fetched Two']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the fields the cached copy is browsed and sorted by', async () => {
    provider([{ stream_id: 90, name: 'Fetched One', num: 5, epg_channel_id: 'chan.90' }]);
    await xtreamService.getStreams(testViewer(), 'live', 'cold');
    jest.restoreAllMocks();

    const [cached] = await xtreamService.getStreams(testViewer(), 'live', 'cold');
    expect(cached).toMatchObject({
      stream_id: 90,
      num: 5,
      epg_channel_id: 'chan.90',
      category_id: 'cold'
    });
  });

  it('adds the category without disturbing what is already cached', async () => {
    provider([{ stream_id: 90, name: 'Fetched One' }]);

    await xtreamService.getStreams(testViewer(), 'live', 'cold');
    jest.restoreAllMocks();

    // The three seeded streams in category 1 are untouched.
    const existing = await xtreamService.getStreams(testViewer(), 'live', '1');
    expect(existing).toHaveLength(3);
  });

  it('remembers a category that came back empty rather than asking on every visit', async () => {
    // A category with no rows used to be indistinguishable from one never
    // fetched, so a genuinely empty one was asked about every time it was
    // opened. On this account 54% of live categories were empty.
    const fetch = provider([]);

    await xtreamService.getStreams(testViewer(), 'live', 'cold');
    await xtreamService.getStreams(testViewer(), 'live', 'cold');
    await xtreamService.getStreams(testViewer(), 'live', 'cold');

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('favourites', () => {
  beforeEach(() => {
    seedStreams([
      { stream_id: 1, name: 'BBC One' },
      { stream_id: 2, name: 'ITV' },
      { stream_id: 3, name: 'Channel 4' }
    ]);
  });

  it('records and lists a favourite', () => {
    xtreamService.addFavorite(TEST_USER_ID, 'live', '2');

    expect(xtreamService.getFavoriteIds(TEST_USER_ID, 'live')).toEqual(['2']);
    expect(xtreamService.getFavorites(testViewer(), 'live').map(s => s.name)).toEqual(['ITV']);
  });

  it('ignores a repeated add rather than duplicating the row', () => {
    xtreamService.addFavorite(TEST_USER_ID, 'live', '2');
    xtreamService.addFavorite(TEST_USER_ID, 'live', '2');

    expect(xtreamService.getFavoriteIds(TEST_USER_ID, 'live')).toEqual(['2']);
  });

  it('removes a favourite', () => {
    xtreamService.addFavorite(TEST_USER_ID, 'live', '2');
    xtreamService.removeFavorite(TEST_USER_ID, 'live', '2');

    expect(xtreamService.getFavoriteIds(TEST_USER_ID, 'live')).toEqual([]);
    expect(xtreamService.getFavorites(testViewer(), 'live')).toEqual([]);
  });

  it('skips a favourite whose channel a later sync dropped', () => {
    // A favourite outlives the row it points at. It must not surface as a blank.
    xtreamService.addFavorite(TEST_USER_ID, 'live', '1');
    xtreamService.addFavorite(TEST_USER_ID, 'live', '404');

    const favourites = xtreamService.getFavorites(testViewer(), 'live');
    expect(favourites.map(s => s.name)).toEqual(['BBC One']);
  });

  it('returns nothing when there are no favourites', () => {
    expect(xtreamService.getFavorites(testViewer(), 'live')).toEqual([]);
  });

  it('keeps favourites separate per stream type', () => {
    xtreamService.addFavorite(TEST_USER_ID, 'live', '1');
    expect(xtreamService.getFavoriteIds(TEST_USER_ID, 'vod')).toEqual([]);
  });

  it('sorts favourites like any other list', () => {
    xtreamService.addFavorite(TEST_USER_ID, 'live', '2');
    xtreamService.addFavorite(TEST_USER_ID, 'live', '1');

    expect(xtreamService.getFavorites(testViewer(), 'live', 'name_asc').map(s => s.name)).toEqual([
      'BBC One',
      'ITV'
    ]);
  });
});

describe('manual order', () => {
  it('round-trips an arrangement', () => {
    xtreamService.saveManualOrder(TEST_USER_ID, 'category:live', ['c', 'a', 'b']);
    expect(xtreamService.getManualOrder(TEST_USER_ID, 'category:live')).toEqual(['c', 'a', 'b']);
  });

  it('replaces the previous arrangement instead of merging with it', () => {
    xtreamService.saveManualOrder(TEST_USER_ID, 'category:live', ['a', 'b', 'c']);
    xtreamService.saveManualOrder(TEST_USER_ID, 'category:live', ['c', 'a']);

    expect(xtreamService.getManualOrder(TEST_USER_ID, 'category:live')).toEqual(['c', 'a']);
  });

  it('clears an arrangement when handed an empty list', () => {
    xtreamService.saveManualOrder(TEST_USER_ID, 'category:live', ['a', 'b']);
    xtreamService.saveManualOrder(TEST_USER_ID, 'category:live', []);

    expect(xtreamService.getManualOrder(TEST_USER_ID, 'category:live')).toEqual([]);
  });

  it('keeps arrangements in different scopes apart', () => {
    xtreamService.saveManualOrder(TEST_USER_ID, 'category:live', ['a']);
    xtreamService.saveManualOrder(TEST_USER_ID, 'category:vod', ['b']);

    expect(xtreamService.getManualOrder(TEST_USER_ID, 'category:live')).toEqual(['a']);
    expect(xtreamService.getManualOrder(TEST_USER_ID, 'category:vod')).toEqual(['b']);
  });

  it('returns nothing for a scope that was never arranged', () => {
    expect(xtreamService.getManualOrder(TEST_USER_ID, 'category:series')).toEqual([]);
  });
});

describe('searchStreamsInDatabase', () => {
  beforeEach(() => {
    seedStreams([
      { stream_id: 1, name: 'BBC One HD' },
      { stream_id: 2, name: 'Sky Sports' },
      { stream_id: 10, name: 'The BBC Documentary', type: 'vod', category_id: '5' }
    ]);
  });

  it('matches case-insensitively on a substring', async () => {
    const results = await xtreamService.searchStreamsInDatabase('bbc', ['live'], TEST_USER);
    expect(results.map(s => s.name)).toEqual(['BBC One HD']);
  });

  it('searches the types it is given, and only those', async () => {
    // Sync stores the StreamType verbatim; a remapping here once made every
    // VOD search return nothing despite a full cache.
    const vod = await xtreamService.searchStreamsInDatabase('bbc', ['vod'], TEST_USER);
    expect(vod.map(s => s.name)).toEqual(['The BBC Documentary']);

    const both = await xtreamService.searchStreamsInDatabase('bbc', ['live', 'vod'], TEST_USER);
    expect(both).toHaveLength(2);
  });

  it('returns nothing for a term that matches no stream', async () => {
    expect(await xtreamService.searchStreamsInDatabase('zzzz', ['live'], TEST_USER)).toEqual([]);
  });

  it('reports a database failure as a server error', async () => {
    await expect(
      xtreamService.searchStreamsInDatabase('bbc', ['live; drop table streams' as never], TEST_USER)
    ).resolves.toEqual([]);

    jest.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('database is locked');
    });
    await expect(xtreamService.searchStreamsInDatabase('bbc', ['live'], TEST_USER)).rejects.toThrow(
      /Database search failed/
    );
    jest.restoreAllMocks();
  });

  it('does not search another account\'s cache', async () => {
    seedStreams([{ stream_id: 77, name: 'BBC Secret' }], 'other-user');
    const results = await xtreamService.searchStreamsInDatabase('bbc', ['live'], TEST_USER);
    expect(results.map(s => s.stream_id)).not.toContain(77);
  });
});

describe('getSyncStatus', () => {
  it('reports nothing synced for an account with no cache', async () => {
    const status = await xtreamService.getSyncStatus('live', TEST_USER);

    expect(status.synced).toBe(false);
    expect(status.totalStreams).toBe(0);
    expect(status.status).toBe('not_synced');
  });

  it('counts what is actually cached, not what the last attempt claimed', async () => {
    // A cancelled run leaves a partial figure in sync_status while the previous
    // complete data is still on disk. The UI must see the data.
    seedStreams([
      { stream_id: 1, name: 'One' },
      { stream_id: 2, name: 'Two' }
    ]);
    seedCategories([{ category_id: '1', category_name: 'News' }]);
    db.prepare(
      `INSERT INTO sync_status (username, type, status, total_streams, total_categories)
       VALUES (?, 'live', 'cancelled', 500, 400)`
    ).run(TEST_USER);

    const status = await xtreamService.getSyncStatus('live', TEST_USER);

    expect(status.totalStreams).toBe(2);
    expect(status.totalCategories).toBe(1);
    expect(status.synced).toBe(true);
    expect(status.status).toBe('cancelled');
  });
});

describe('cancelSync', () => {
  it('reports false when the account has no sync running', () => {
    expect(xtreamService.cancelSync(TEST_USER)).toBe(false);
  });
});

describe('concurrent syncs', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses a second sync while one is running for the account', async () => {
    // Two at once doubles the request rate the provider sees, and the second
    // used to overwrite the first's handle so neither could be cancelled.
    let releaseFirst!: () => void;
    jest.spyOn(xtreamService, 'fetchCategoriesFromApi').mockImplementation(
      () => new Promise(resolve => {
        releaseFirst = () => resolve([]);
      })
    );

    const first = xtreamService.syncData('live', TEST_USER, 'pw', 'http://provider.example');
    await Promise.resolve();

    await expect(
      xtreamService.syncData('vod', TEST_USER, 'pw', 'http://provider.example')
    ).rejects.toMatchObject({ statusCode: 409 });

    releaseFirst();
    await first;
  });

  it('allows a sync again once the previous one has finished', async () => {
    jest.spyOn(xtreamService, 'fetchCategoriesFromApi').mockResolvedValue([]);

    await xtreamService.syncData('live', TEST_USER, 'pw', 'http://provider.example');
    await expect(
      xtreamService.syncData('live', TEST_USER, 'pw', 'http://provider.example')
    ).resolves.toBeDefined();
  });

  it('does not block a different account', async () => {
    // Each call gets its own resolver, so releasing one cannot accidentally
    // release the other and make the test pass for the wrong reason.
    const releases: Array<() => void> = [];
    jest.spyOn(xtreamService, 'fetchCategoriesFromApi').mockImplementation(
      () => new Promise(resolve => releases.push(() => resolve([])))
    );

    const mine = xtreamService.syncData('live', TEST_USER, 'pw', 'http://provider.example');
    await Promise.resolve();

    // Accepted rather than rejected: the lock is per account.
    const theirs = xtreamService.syncData('live', 'other-user', 'pw', 'http://provider.example');
    await Promise.resolve();
    expect(releases).toHaveLength(2);

    releases.forEach(release => release());
    await expect(theirs).resolves.toBeDefined();
    await mine;
  });
});

describe('selectChannelsNeedingEPG', () => {
  beforeEach(() => {
    seedStreams([
      { stream_id: 1, name: 'One', epg_channel_id: 'chan.one' },
      { stream_id: 2, name: 'Two', epg_channel_id: 'chan.two' },
      { stream_id: 3, name: 'Three', epg_channel_id: 'chan.three' }
    ]);
  });

  const pick = (limit = 10) =>
    xtreamService.selectChannelsNeedingEPG(TEST_USER, limit, 6, 12, TEST_USER_ID);

  it('picks channels whose guide is empty', () => {
    expect(pick().map(c => c.channelId).sort()).toEqual(['chan.one', 'chan.three', 'chan.two']);
  });

  it('skips a channel whose guide already reaches past the horizon', () => {
    seedEPG('chan.two', { startsInHours: -1, endsInHours: 8 });
    expect(pick().map(c => c.channelId)).not.toContain('chan.two');
  });

  it('picks a channel whose guide has run out before the horizon', () => {
    seedEPG('chan.two', { startsInHours: -4, endsInHours: -1 });
    expect(pick().map(c => c.channelId)).toContain('chan.two');
  });

  it('skips a channel asked about recently', () => {
    seedEPGAttempt('chan.two', 1);
    expect(pick().map(c => c.channelId)).not.toContain('chan.two');
  });

  it('comes back to a channel once the retry window has passed', () => {
    seedEPGAttempt('chan.two', 13);
    expect(pick().map(c => c.channelId)).toContain('chan.two');
  });

  it('advances past channels the provider had nothing for', () => {
    // The bug this guards: selecting purely on missing data hands back the same
    // barren channels every pass, so the fill never reaches the rest of the list.
    seedEPGAttempt('chan.one', 0);
    seedEPGAttempt('chan.two', 0);

    const next = pick().map(c => c.channelId);

    expect(next).toEqual(['chan.three']);
  });

  it('ignores channels the provider gave no channel id for', () => {
    seedStreams([
      { stream_id: 4, name: 'Untagged', epg_channel_id: null },
      { stream_id: 5, name: 'Blank', epg_channel_id: '' }
    ]);
    const ids = pick(50).map(c => c.streamId);
    expect(ids).not.toContain('4');
    expect(ids).not.toContain('5');
  });

  it('ignores non-live streams, which carry no guide', () => {
    seedStreams([{ stream_id: 6, name: 'A Film', type: 'vod', epg_channel_id: 'chan.film' }]);
    expect(pick(50).map(c => c.channelId)).not.toContain('chan.film');
  });

  it('puts favourites at the front of the queue', () => {
    xtreamService.addFavorite(TEST_USER_ID, 'live', '3');
    expect(pick()[0].channelId).toBe('chan.three');
  });

  it('asks about each channel id once, however many streams share it', () => {
    seedStreams([{ stream_id: 99, name: 'One (backup)', epg_channel_id: 'chan.one' }]);
    expect(pick(50).filter(c => c.channelId === 'chan.one')).toHaveLength(1);
  });

  it('honours the batch limit', () => {
    expect(pick(2)).toHaveLength(2);
  });

  it('leaves another account\'s channels alone', () => {
    seedStreams([{ stream_id: 50, name: 'Theirs', epg_channel_id: 'chan.theirs' }], 'other-user');
    expect(pick(50).map(c => c.channelId)).not.toContain('chan.theirs');
  });
});

describe('refreshEPGBatch', () => {
  beforeEach(() => {
    seedStreams([
      { stream_id: 1, name: 'One', epg_channel_id: 'chan.one' },
      { stream_id: 2, name: 'Two', epg_channel_id: 'chan.two' },
      { stream_id: 3, name: 'Three', epg_channel_id: 'chan.three' }
    ]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const options = { batchSize: 10, requestDelayMs: 0, freshForHours: 6, retryAfterHours: 12 };

  const stubEPG = (impl: (streamId: string) => unknown) =>
    jest
      .spyOn(xtreamService, 'getEPGShort')
      .mockImplementation(async (_u, _p, streamId) => impl(streamId) as never);

  it('counts channels that returned a guide separately from empty ones', async () => {
    // Reporting requests as successes is what made a stuck queue look healthy.
    stubEPG(id => (id === '1' ? { epg_listings: [{ title: 'Show' }] } : { epg_listings: [] }));

    const result = await xtreamService.refreshEPGBatch(TEST_USER, 'pw', undefined, options);

    expect(result).toEqual({ attempted: 3, withData: 1, empty: 2, failed: 0 });
  });

  it('records an attempt even when the provider had nothing, so the queue moves on', async () => {
    stubEPG(() => ({ epg_listings: [] }));

    await xtreamService.refreshEPGBatch(TEST_USER, 'pw', undefined, options);

    expect(xtreamService.selectChannelsNeedingEPG(TEST_USER, 10, 6, 12)).toEqual([]);
  });

  it('counts a failed channel and carries on with the rest', async () => {
    stubEPG(id => {
      if (id === '2') throw new Error('provider refused');
      return { epg_listings: [] };
    });

    const result = await xtreamService.refreshEPGBatch(TEST_USER, 'pw', undefined, options);

    expect(result.failed).toBe(1);
    expect(result.attempted).toBe(3);
  });

  it('records an attempt for a channel the provider itself refused', async () => {
    stubEPG(() => {
      throw new Error('provider refused');
    });

    await xtreamService.refreshEPGBatch(TEST_USER, 'pw', undefined, options);

    expect(xtreamService.selectChannelsNeedingEPG(TEST_USER, 10, 6, 12)).toEqual([]);
  });

  it('keeps its queue when the provider is unreachable', async () => {
    // An outage says nothing about any particular channel. Recording attempts
    // through one would sideline a batch of them for the retry window on the
    // strength of the provider being down.
    stubEPG(() => {
      throw Object.assign(new Error('Request to Xtream server timed out'), { statusCode: 408 });
    });

    const result = await xtreamService.refreshEPGBatch(TEST_USER, 'pw', undefined, options);

    expect(result.failed).toBe(1);
    expect(xtreamService.selectChannelsNeedingEPG(TEST_USER, 10, 6, 12)).toHaveLength(3);
  });

  it('stops the pass instead of spending it on an unreachable provider', async () => {
    const spy = stubEPG(() => {
      throw Object.assign(new Error('No response received'), { statusCode: 502 });
    });

    await xtreamService.refreshEPGBatch(TEST_USER, 'pw', undefined, options);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no channel needs topping up', async () => {
    const spy = stubEPG(() => ({ epg_listings: [] }));
    seedEPGAttempt('chan.one', 0);
    seedEPGAttempt('chan.two', 0);
    seedEPGAttempt('chan.three', 0);

    const result = await xtreamService.refreshEPGBatch(TEST_USER, 'pw', undefined, options);

    expect(result).toEqual({ attempted: 0, withData: 0, empty: 0, failed: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('stays within the batch size', async () => {
    const spy = stubEPG(() => ({ epg_listings: [] }));

    await xtreamService.refreshEPGBatch(TEST_USER, 'pw', undefined, { ...options, batchSize: 2 });

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('getEPGCoverage', () => {
  it('reports nothing for an empty cache', () => {
    expect(xtreamService.getEPGCoverage(TEST_USER)).toEqual({ eligible: 0, covered: 0 });
  });

  it('counts channels that could carry a guide against those that do', () => {
    seedStreams([
      { stream_id: 1, name: 'One', epg_channel_id: 'chan.one' },
      { stream_id: 2, name: 'Two', epg_channel_id: 'chan.two' },
      { stream_id: 3, name: 'Untagged', epg_channel_id: '' }
    ]);
    seedEPG('chan.one', { startsInHours: -1, endsInHours: 1 });

    expect(xtreamService.getEPGCoverage(TEST_USER)).toEqual({ eligible: 2, covered: 1 });
  });
});

describe('getDistinctUsernames', () => {
  it('finds every account with cached data', () => {
    seedStreams([{ stream_id: 1, name: 'One' }]);
    seedStreams([{ stream_id: 2, name: 'Two' }], 'other-user');

    expect(xtreamService.getDistinctUsernames().sort()).toEqual(['other-user', TEST_USER]);
  });

  it('finds an account known only from its guide', () => {
    seedEPG('chan.x', { startsInHours: 0, endsInHours: 1 }, 'epg-only-user');
    expect(xtreamService.getDistinctUsernames()).toContain('epg-only-user');
  });
});
