import { Catalogue } from '../../../shared/xtream/catalogue';
import { XtreamClient } from '../../../shared/xtream/client';
import { XtreamResponse, XtreamTransport } from '../../../shared/xtream/transport';
import { SqliteCatalogueStore } from './sqliteCatalogueStore';
import { TEST_USER, resetDatabase, seedCategories, seedStreams } from '../test-utils/seed';
import { db } from '../utils/database';

/**
 * The shared policy driving the real database.
 *
 * The store tests above it use a Map; this is what proves the interface fits a
 * genuine SQLite driver, which is the only reason to believe a phone's will
 * fit too.
 */
class ScriptedTransport implements XtreamTransport {
  requests = 0;
  private answers = new Map<string, unknown>();

  answer(action: string, categoryId: string | undefined, data: unknown): this {
    this.answers.set(`${action}:${categoryId ?? ''}`, data);
    return this;
  }

  async get(_url: string, params: Record<string, unknown>): Promise<XtreamResponse> {
    this.requests++;
    return {
      status: 200,
      data: this.answers.get(`${params['action']}:${params['category_id'] ?? ''}`) ?? []
    };
  }
}

const build = (now?: () => Date) => {
  const transport = new ScriptedTransport();
  const client = new XtreamClient(transport, {
    serverUrl: 'http://provider.example',
    username: TEST_USER,
    password: 'hunter2'
  });
  const store = new SqliteCatalogueStore(TEST_USER);
  return { transport, store, catalogue: new Catalogue(client, store, now ? { now } : {}) };
};

beforeEach(() => resetDatabase());

describe('reading what is already cached', () => {
  it('serves categories a sync stored, without asking the provider', async () => {
    seedCategories([{ category_id: '1', category_name: 'News' }]);
    const { transport, catalogue } = build();

    const categories = await catalogue.categories('live');

    expect(categories.map(c => c.category_name)).toEqual(['News']);
    expect(transport.requests).toBe(0);
  });

  it('serves streams a sync stored, without asking the provider', async () => {
    seedStreams([{ stream_id: 1, name: 'BBC One', category_id: '1' }]);
    const { transport, catalogue } = build();

    const streams = await catalogue.streams('live', '1');

    expect(streams.map(s => s.name)).toEqual(['BBC One']);
    expect(transport.requests).toBe(0);
  });
});

describe('filling a gap', () => {
  it('fetches a category that is missing and keeps it', async () => {
    const { transport, catalogue } = build();
    transport.answer('get_live_streams', '7', [
      { stream_id: 42, name: 'Channel 42', stream_icon: 'http://art', num: 3 }
    ]);

    const first = await catalogue.streams('live', '7');
    const second = await catalogue.streams('live', '7');

    expect(first.map(s => s.name)).toEqual(['Channel 42']);
    expect(second.map(s => s.name)).toEqual(['Channel 42']);
    expect(transport.requests).toBe(1);

    const stored = db
      .prepare('SELECT name, num FROM streams WHERE username = ? AND category_id = ?')
      .get(TEST_USER, '7') as { name: string; num: number };
    expect(stored).toEqual({ name: 'Channel 42', num: 3 });
  });

  it('adds to the cache without disturbing what is already there', async () => {
    seedStreams([{ stream_id: 1, name: 'Already here', category_id: '1' }]);
    const { transport, catalogue } = build();
    transport.answer('get_live_streams', '2', [{ stream_id: 2, name: 'Newly fetched' }]);

    await catalogue.streams('live', '2');

    expect((await catalogue.streams('live', '1')).map(s => s.name)).toEqual(['Already here']);
    expect((await catalogue.streams('live', '2')).map(s => s.name)).toEqual(['Newly fetched']);
  });

  it('fetches categories that were never synced', async () => {
    const { transport, catalogue } = build();
    transport.answer('get_vod_categories', undefined, [
      { category_id: '9', category_name: 'Films' }
    ]);

    expect((await catalogue.categories('vod')).map(c => c.category_name)).toEqual(['Films']);
    // Kept, so the next visit costs nothing.
    expect((await catalogue.categories('vod')).map(c => c.category_name)).toEqual(['Films']);
    expect(transport.requests).toBe(1);
  });
});

describe('a category the provider has nothing in', () => {
  it('is asked about once rather than on every visit', async () => {
    const { transport, catalogue } = build();

    await catalogue.streams('live', 'empty');
    await catalogue.streams('live', 'empty');
    await catalogue.streams('live', 'empty');

    expect(transport.requests).toBe(1);
  });

  it('records the attempt where it can be seen', async () => {
    const { catalogue, store } = build();

    await catalogue.streams('live', 'empty');

    expect(await store.lastFetchedAt('live', 'empty')).toMatch(/^\d{4}-/);
    const row = db
      .prepare('SELECT COUNT(*) c FROM category_fetch_attempts WHERE username = ?')
      .get(TEST_USER) as { c: number };
    expect(row.c).toBe(1);
  });

  it('is asked again after long enough, since providers do fill them in', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const { transport, catalogue } = build(() => now);

    await catalogue.streams('live', 'empty');
    now = new Date('2026-01-02T00:00:00.000Z');
    transport.answer('get_live_streams', 'empty', [{ stream_id: 5, name: 'Filled in' }]);

    expect((await catalogue.streams('live', 'empty')).map(s => s.name)).toEqual(['Filled in']);
    expect(transport.requests).toBe(2);
  });

  it('re-recording an attempt updates the row rather than adding one', async () => {
    const { store } = build();

    await store.markFetched('live', 'empty', '2026-01-01T00:00:00.000Z');
    await store.markFetched('live', 'empty', '2026-01-02T00:00:00.000Z');

    const row = db
      .prepare('SELECT COUNT(*) c FROM category_fetch_attempts WHERE username = ?')
      .get(TEST_USER) as { c: number };
    expect(row.c).toBe(1);
    expect(await store.lastFetchedAt('live', 'empty')).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('one subscription cannot see another', () => {
  it('keeps catalogues apart, since a different line has a different line-up', async () => {
    seedStreams([{ stream_id: 1, name: 'Theirs', category_id: '1' }], 'someone-else');
    const { transport, catalogue } = build();

    const streams = await catalogue.streams('live', '1');

    // Not found in the cache, so it went and asked -- rather than handing back
    // another subscription's channels.
    expect(streams).toEqual([]);
    expect(transport.requests).toBe(1);
  });
});
