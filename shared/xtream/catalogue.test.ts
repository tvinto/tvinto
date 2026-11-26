import { Category, Stream, StreamType } from '../types';
import { Catalogue, CatalogueStore } from './catalogue';
import { searchable } from './channelNames';
import { XtreamClient } from './client';
import { XtreamResponse, XtreamTransport } from './transport';
import { readLibraryHere } from './libraryWorker';

/** Counts what the provider was asked, which is what most of this is about. */
class CountingTransport implements XtreamTransport {
  requests = 0;
  private answers = new Map<string, unknown>();

  answer(action: string, categoryId: string | undefined, data: unknown): this {
    this.answers.set(`${action}:${categoryId ?? ''}`, data);
    return this;
  }

  async get(_url: string, params: Record<string, unknown>): Promise<XtreamResponse> {
    this.requests++;
    const key = `${params['action']}:${params['category_id'] ?? ''}`;
    return { status: 200, data: this.answers.get(key) ?? [] };
  }
}

/** A store in memory, standing in for whatever SQLite a device happens to have. */
class MemoryStore implements CatalogueStore {
  categories = new Map<string, Category[]>();
  streams = new Map<string, Stream[]>();
  fetched = new Map<string, string>();
  writes = 0;

  async readCategories(type: StreamType) {
    return this.categories.get(type) ?? [];
  }
  async writeCategories(type: StreamType, categories: Category[]) {
    this.writes++;
    this.categories.set(type, categories);
  }
  async readStreams(type: StreamType, categoryId: string) {
    return this.streams.get(`${type}:${categoryId}`) ?? [];
  }
  async writeStreams(type: StreamType, categoryId: string, streams: Stream[]) {
    this.writes++;
    this.streams.set(`${type}:${categoryId}`, streams);
  }
  async lastFetchedAt(type: StreamType, categoryId: string) {
    return this.fetched.get(`${type}:${categoryId}`) ?? null;
  }
  async markFetched(type: StreamType, categoryId: string, at: string) {
    this.fetched.set(`${type}:${categoryId}`, at);
  }
  async recentlyAdded(type: StreamType, limit: number) {
    const all: Stream[] = [];
    for (const [key, streams] of this.streams) {
      if (key.startsWith(`${type}:`)) {
        all.push(...streams);
      }
    }
    return all
      .filter(stream => Number(stream.added) > 0)
      .sort((a, b) => Number(b.added) - Number(a.added))
      .slice(0, limit);
  }
  async findStreams(type: StreamType, words: string[], limit: number, joined = false) {
    const found: Stream[] = [];
    for (const [key, streams] of this.streams) {
      if (!key.startsWith(`${type}:`)) {
        continue;
      }
      for (const stream of streams) {
        const name = joined ? searchable(stream.name ?? '') : (stream.name ?? '').toLowerCase();
        if (words.every(word => name.includes(word))) {
          found.push(stream);
        }
      }
    }
    return found.slice(0, limit);
  }
  async findStreamsWithAny(type: StreamType, words: string[], limit: number) {
    const found: Stream[] = [];
    for (const [key, streams] of this.streams) {
      if (key.startsWith(`${type}:`)) {
        found.push(...streams.filter(stream => words.some(word => (stream.name ?? '').toLowerCase().includes(word))));
      }
    }
    return found.slice(0, limit);
  }
}

const build = (options: { now?: () => Date; emptyCategoryRetryHours?: number; indexMaxAgeHours?: number } = {}) => {
  const transport = new CountingTransport();
  const client = new XtreamClient(transport, {
    serverUrl: 'http://provider.example',
    username: 'joe',
    password: 'hunter2'
  });
  const store = new MemoryStore();
  return { transport, store, catalogue: new Catalogue(client, store, options) };
};

const CHANNEL = { stream_id: 1, name: 'BBC One' };

describe('categories', () => {
  it('fetches once and keeps them', async () => {
    const { transport, catalogue } = build();
    transport.answer('get_live_categories', undefined, [
      { category_id: '1', category_name: 'News' }
    ]);

    const first = await catalogue.categories('live');
    const second = await catalogue.categories('live');

    expect(first.map(c => c.category_name)).toEqual(['News']);
    expect(second).toEqual(first);
    expect(transport.requests).toBe(1);
  });

  it('does not store an empty answer as though it were the catalogue', async () => {
    const { transport, store, catalogue } = build();

    await catalogue.categories('live');

    expect(store.writes).toBe(0);
    expect(transport.requests).toBe(1);
  });

  it('keeps each type apart', async () => {
    const { transport, catalogue } = build();
    transport
      .answer('get_live_categories', undefined, [{ category_id: '1', category_name: 'News' }])
      .answer('get_vod_categories', undefined, [{ category_id: '2', category_name: 'Films' }]);

    expect((await catalogue.categories('live'))[0].category_name).toBe('News');
    expect((await catalogue.categories('vod'))[0].category_name).toBe('Films');
  });
});

describe('streams', () => {
  it('fetches a category once and serves it from store afterwards', async () => {
    const { transport, catalogue } = build();
    transport.answer('get_live_streams', '1', [CHANNEL]);

    const first = await catalogue.streams('live', '1');
    const second = await catalogue.streams('live', '1');

    expect(first.map(s => s.name)).toEqual(['BBC One']);
    expect(second).toEqual(first);
    expect(transport.requests).toBe(1);
  });

  it('fetches only the category asked for, never the rest', async () => {
    // The habit that got an address blocked: a sweep is a thousand requests,
    // and several devices each doing their own is several thousand.
    const { transport, catalogue } = build();
    transport.answer('get_live_streams', '1', [CHANNEL]);

    await catalogue.streams('live', '1');

    expect(transport.requests).toBe(1);
  });

  it('browsing twenty categories costs twenty requests, not the catalogue', async () => {
    const { transport, catalogue } = build();
    for (let i = 0; i < 20; i++) {
      transport.answer('get_live_streams', String(i), [{ stream_id: i, name: `Channel ${i}` }]);
    }

    for (let i = 0; i < 20; i++) {
      await catalogue.streams('live', String(i));
    }
    // And again, now that they are all stored.
    for (let i = 0; i < 20; i++) {
      await catalogue.streams('live', String(i));
    }

    expect(transport.requests).toBe(20);
  });

  it('keeps categories apart from each other', async () => {
    const { transport, catalogue } = build();
    transport
      .answer('get_live_streams', '1', [{ stream_id: 1, name: 'In one' }])
      .answer('get_live_streams', '2', [{ stream_id: 2, name: 'In two' }]);

    expect((await catalogue.streams('live', '1')).map(s => s.name)).toEqual(['In one']);
    expect((await catalogue.streams('live', '2')).map(s => s.name)).toEqual(['In two']);
  });
});

describe('channels stored before catch-up was kept', () => {
  it('asks for the category once more, then serves it from the store', async () => {
    const { transport, store, catalogue } = build();
    store.streams.set('live:1', [{ stream_id: '1', name: 'HRT 1 HD', icon: '' }]);
    transport.answer('get_live_streams', '1', [{ stream_id: 1, name: 'HRT 1 HD', tv_archive: 1, tv_archive_duration: 3 }]);

    const first = await catalogue.streams('live', '1');
    const second = await catalogue.streams('live', '1');

    expect(first[0].tv_archive).toBe(1);
    expect(first[0].tv_archive_duration).toBe(3);
    expect(second[0].tv_archive).toBe(1);
    expect(transport.requests).toBe(1);
  });

  it('is not asked about again when the provider says nothing about catch-up', async () => {
    const { transport, catalogue } = build();
    transport.answer('get_live_streams', '1', [CHANNEL]);

    const [fetched] = await catalogue.streams('live', '1');
    await catalogue.streams('live', '1');

    expect(fetched.tv_archive).toBe(0);
    expect(transport.requests).toBe(1);
  });

  it('keeps what it had when the provider cannot be reached', async () => {
    const store = new MemoryStore();
    const held: Stream = { stream_id: '1', name: 'HRT 1 HD', icon: '' };
    store.streams.set('live:1', [held]);
    const unreachable = new XtreamClient(
      { get: async () => ({ status: 503, data: null }) },
      { serverUrl: 'http://provider.example', username: 'joe', password: 'hunter2' }
    );

    expect(await new Catalogue(unreachable, store).streams('live', '1')).toEqual([held]);
  });

  it('asks once more for shows stored before they carried a date', async () => {
    const { transport, store, catalogue } = build();
    store.streams.set('series:1', [{ stream_id: '7', name: 'Bodkin', icon: '' }]);
    transport.answer('get_series', '1', [{ series_id: 7, name: 'Bodkin', last_modified: '1790542044', category_id: '1' }]);

    const first = await catalogue.streams('series', '1');
    await catalogue.streams('series', '1');

    expect(first[0].added).toBe('1790542044');
    expect(transport.requests).toBe(1);
  });

  it('leaves films alone, which have no catch-up', async () => {
    const { transport, store, catalogue } = build();
    store.streams.set('vod:1', [{ stream_id: '1', name: 'Dune', icon: '' }]);

    await catalogue.streams('vod', '1');

    expect(transport.requests).toBe(0);
  });
});

describe('a category that is genuinely empty', () => {
  it('is asked about once, not on every visit', async () => {
    const { transport, catalogue } = build();

    await catalogue.streams('live', 'empty');
    await catalogue.streams('live', 'empty');
    await catalogue.streams('live', 'empty');

    expect(transport.requests).toBe(1);
  });

  it('still reports as empty rather than as an error', async () => {
    const { catalogue } = build();

    await catalogue.streams('live', 'empty');

    expect(await catalogue.streams('live', 'empty')).toEqual([]);
  });

  it('is asked again once enough time has passed, since providers fill them', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const { transport, catalogue } = build({
      now: () => now,
      emptyCategoryRetryHours: 12
    });

    await catalogue.streams('live', 'empty');
    expect(transport.requests).toBe(1);

    now = new Date('2026-01-01T11:00:00.000Z');
    await catalogue.streams('live', 'empty');
    expect(transport.requests).toBe(1);

    now = new Date('2026-01-01T13:00:00.000Z');
    transport.answer('get_live_streams', 'empty', [{ stream_id: 9, name: 'Filled in' }]);
    await catalogue.streams('live', 'empty');

    expect(transport.requests).toBe(2);
    expect((await catalogue.streams('live', 'empty')).map(s => s.name)).toEqual(['Filled in']);
  });

  it('asks again when the record of asking is unreadable', async () => {
    // "I cannot tell when this was tried" should mean try, not never try.
    const { transport, store, catalogue } = build();
    await store.markFetched('live', 'empty', 'not-a-timestamp');

    await catalogue.streams('live', 'empty');

    expect(transport.requests).toBe(1);
  });
});

describe('what gets written', () => {
  it('records the attempt even when nothing came back', async () => {
    const { store, catalogue } = build();

    await catalogue.streams('live', 'empty');

    expect(await store.lastFetchedAt('live', 'empty')).not.toBeNull();
    expect(await store.readStreams('live', 'empty')).toEqual([]);
  });

  it('writes nothing at all when serving from store', async () => {
    const { store, catalogue } = build();
    await store.writeStreams('live', '1', [CHANNEL as unknown as Stream]);
    const writesBefore = store.writes;

    await catalogue.streams('live', '1');

    expect(store.writes).toBe(writesBefore);
  });
});

describe('prefetch', () => {
  it('fills a category and says how much it found', async () => {
    const { transport, store, catalogue } = build();
    transport.answer('get_live_streams', '1', [CHANNEL, { stream_id: 2, name: 'ITV' }]);

    expect(await catalogue.prefetch('live', '1')).toBe(2);
    expect(await store.readStreams('live', '1')).toHaveLength(2);
  });

  it('costs nothing for something already held', async () => {
    const { transport, catalogue } = build();
    transport.answer('get_live_streams', '1', [CHANNEL]);

    await catalogue.prefetch('live', '1');
    await catalogue.prefetch('live', '1');

    expect(transport.requests).toBe(1);
  });
});

describe('search', () => {
  const stock = async (catalogue: Catalogue, store: MemoryStore) => {
    await store.writeStreams('live', '1', [
      { stream_id: '10', name: 'HR| HRT 1 ⱽᴵᴾ ᴿᴬᵂ', icon: '' },
      { stream_id: '11', name: 'HR| HRT 2 ⱽᴵᴾ ᴿᴬᵂ', icon: '' },
      { stream_id: '12', name: 'HR| RTL 2 ⱽᴵᴾ', icon: '' },
      { stream_id: '13', name: 'Abbey Road Documentaries', icon: '' }
    ] as Stream[]);
    return catalogue;
  };

  // The whole point: the name on screen carries a country tag and superscript
  // packaging, and the thing a person types carries neither.
  it('finds a channel from the plain words of its name', async () => {
    const { catalogue, store } = build();
    await stock(catalogue, store);

    const found = await catalogue.search('live', 'hrt 2');

    expect(found.map(s => s.stream_id)).toEqual(['11']);
  });

  it('finds it when the search carries the provider marks too', async () => {
    const { catalogue, store } = build();
    await stock(catalogue, store);

    const found = await catalogue.search('live', 'HRT 2 ⱽᴵᴾ ᴿᴬᵂ');

    expect(found.map(s => s.stream_id)).toEqual(['11']);
  });

  it('does not care what order the words were typed in', async () => {
    const { catalogue, store } = build();
    await stock(catalogue, store);

    const found = await catalogue.search('live', '2 hrt');

    expect(found.map(s => s.stream_id)).toEqual(['11']);
  });

  // A substring test says "bbc" is in "Abbey"; a word test does not.
  it('matches whole words rather than substrings', async () => {
    const { catalogue, store } = build();
    await store.writeStreams('live', '1', [
      { stream_id: '20', name: 'Abbey Road Documentaries', icon: '' }
    ] as Stream[]);

    expect(await catalogue.search('live', 'bbc')).toEqual([]);
  });

  // Somebody typing is not finished typing, and the film is the answer.
  it('finds a film from the start of a word', async () => {
    const { catalogue, store } = build();
    await store.writeStreams('vod', '1', [
      { stream_id: '30', name: 'EN - X-Men: Apocalypse (2016)', icon: '' },
      { stream_id: '31', name: 'EN - Deadpool 2 4K', icon: '' }
    ] as Stream[]);

    expect((await catalogue.search('vod', 'x-men apoca')).map(s => s.stream_id)).toEqual(['30']);
    expect((await catalogue.search('vod', 'x-men apocalypse')).map(s => s.stream_id)).toEqual(['30']);
  });

  // A user typed "xmen" and found nothing, where "x-men" found the films.
  // Popular this week: sixty titles a day, one search each was over a minute on a user's TV.
  it('looks many titles up in a few reads, each with its own copies', async () => {
    const { catalogue, store } = build();
    await store.writeStreams('vod', '1', [
      { stream_id: '30', name: 'EN - Spiderman: No Way Home (2021)', icon: '' },
      { stream_id: '31', name: 'EN - Hope (2026) 4K', icon: '' },
      { stream_id: '32', name: 'EN - Hopeless Romantic', icon: '' },
      { stream_id: '33', name: 'HR - Sinners', icon: '' }
    ] as Stream[]);
    const asked: string[][] = [];
    const any = store.findStreamsWithAny.bind(store);
    store.findStreamsWithAny = async (type, words, limit) => {
      asked.push(words);
      return any(type, words, limit);
    };

    const found = await catalogue.findTitles('vod', ['Spider-Man: No Way Home', 'Hope', 'Sinners', 'Weapons']);

    expect(found.get('Spider-Man: No Way Home')?.map(s => s.stream_id)).toEqual(['30']);
    // Word starts, as search matches: the film itself is told apart by name and year later (versionsOf).
    expect(found.get('Hope')?.map(s => s.stream_id)).toEqual(['31', '32']);
    expect(found.get('Sinners')?.map(s => s.stream_id)).toEqual(['33']);
    expect(found.get('Weapons')).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  // Five film pages on a user's TV queued minutes of these reads after they were left (26 November).
  it("makes no more of a lookup's reads once the page that asked is left", async () => {
    const { catalogue, store } = build();
    const left = new AbortController();
    const asked: string[][] = [];
    store.findStreamsWithAny = async (_type, words) => {
      asked.push(words);
      left.abort();
      return [];
    };

    await catalogue.findTitles('vod', Array.from({ length: 30 }, (_, i) => `Title${i}`), left.signal);

    expect(asked).toHaveLength(1);
  });

  it('finds a name written with a hyphen from the words typed together, and the other way round', async () => {
    const { catalogue, store } = build();
    await store.writeStreams('vod', '1', [
      { stream_id: '30', name: 'EN - X-Men: First Class 4K', icon: '' },
      { stream_id: '32', name: 'EN - Spiderman: Homecoming', icon: '' },
      { stream_id: '31', name: 'EN - Deadpool 2 4K', icon: '' }
    ] as Stream[]);

    expect((await catalogue.search('vod', 'xmen')).map(s => s.stream_id)).toEqual(['30']);
    expect((await catalogue.search('vod', 'xmen first')).map(s => s.stream_id)).toEqual(['30']);
    expect((await catalogue.search('vod', 'x men')).map(s => s.stream_id)).toEqual(['30']);
    expect((await catalogue.search('vod', 'spider man')).map(s => s.stream_id)).toEqual(['32']);
  });

  it('still refuses a prefix that is not the start of a word', async () => {
    const { catalogue, store } = build();
    await store.writeStreams('live', '1', [
      { stream_id: '20', name: 'Abbey Road Documentaries', icon: '' }
    ] as Stream[]);

    // "bbc" sits inside "Abbey" and starts nothing.
    expect(await catalogue.search('live', 'bbc')).toEqual([]);
  });

  it('forgives a slip in a long word by trying its stem', async () => {
    const { catalogue, store } = build();
    await store.writeStreams('vod', '1', [
      { stream_id: '30', name: 'EN - X-Men: Apocalypse (2016)', icon: '' }
    ] as Stream[]);

    expect((await catalogue.search('vod', 'x-men apocalipse')).map(s => s.stream_id)).toEqual(['30']);
  });

  it('does not forgive a word that was never close', async () => {
    const { catalogue, store } = build();
    await store.writeStreams('vod', '1', [
      { stream_id: '30', name: 'EN - X-Men: Apocalypse (2016)', icon: '' }
    ] as Stream[]);

    expect(await catalogue.search('vod', 'x-men wolverine')).toEqual([]);
  });

  it('gives nothing back for a search that is only packaging', async () => {
    const { catalogue, store } = build();
    await stock(catalogue, store);

    expect(await catalogue.search('live', 'HD ⱽᴵᴾ')).toEqual([]);
  });

  // The safety property, and the reason this method exists at all.
  it('never asks the provider for anything', async () => {
    const { catalogue, store, transport } = build();
    await stock(catalogue, store);

    await catalogue.search('live', 'hrt');
    await catalogue.search('live', 'something the cache has never heard of');

    expect(transport.requests).toBe(0);
  });

  it('honours the limit', async () => {
    const { catalogue, store } = build();
    await stock(catalogue, store);

    const found = await catalogue.search('live', 'hr', 1);

    expect(found.length).toBeLessThanOrEqual(1);
  });
});

describe('recentlyAdded', () => {
  it('lists what is held, newest first, without asking the provider', async () => {
    const { transport, store, catalogue } = build();
    await store.writeStreams('vod', '10', [
      { stream_id: '1', name: 'Old', added: '1700000000' } as Stream,
      { stream_id: '2', name: 'Newest', added: '1790000000' } as Stream
    ]);
    await store.writeStreams('vod', '20', [
      { stream_id: '3', name: 'Middle', added: '1750000000' } as Stream,
      { stream_id: '4', name: 'Undated' } as Stream
    ]);

    expect((await catalogue.recentlyAdded('vod', 2)).map(s => s.name)).toEqual(['Newest', 'Middle']);
    expect(transport.requests).toBe(0);
  });
});

describe('index', () => {
  const LIBRARY = [
    { stream_id: 1, name: 'Sjeverni pol', category_id: '10' },
    { stream_id: 2, name: 'Tri zime', category_id: '10' },
    { stream_id: 3, name: 'Dune: Part Two', category_id: '20' },
    { stream_id: 4, name: 'Nowhere', category_id: '' }
  ];

  it('asks for the whole library once, and files it under its categories', async () => {
    const { transport, store, catalogue } = build();
    transport.answer('get_vod_streams', undefined, LIBRARY);

    expect(await catalogue.index('vod')).toBe(4);

    expect(transport.requests).toBe(1);
    expect((await store.readStreams('vod', '10')).map(s => s.name)).toEqual(['Sjeverni pol', 'Tri zime']);
    expect((await store.readStreams('vod', '20')).map(s => s.name)).toEqual(['Dune: Part Two']);
  });

  it('says how many categories are filed, of how many, once the library is in', async () => {
    const { transport, catalogue } = build();
    transport.answer('get_vod_streams', undefined, LIBRARY);
    const heard: [number, number | null][] = [];

    await catalogue.index('vod', undefined, (filed, total) => heard.push([filed, total]));

    expect(heard).toEqual([
      [0, 2],
      [1, 2],
      [2, 2]
    ]);
  });

  it('makes search find what was never browsed', async () => {
    const { transport, catalogue } = build();
    transport.answer('get_vod_streams', undefined, LIBRARY);

    expect(await catalogue.search('vod', 'sjeverni')).toEqual([]);
    await catalogue.index('vod');
    expect((await catalogue.search('vod', 'sjeverni')).map(s => s.name)).toEqual(['Sjeverni pol']);
  });

  it('leaves the categories it filled costing nothing to open', async () => {
    const { transport, catalogue } = build();
    transport.answer('get_vod_streams', undefined, LIBRARY);
    await catalogue.index('vod');

    await catalogue.streams('vod', '20');
    expect(transport.requests).toBe(1);
  });

  it('is fresh for a day, and not after', async () => {
    let now = new Date('2026-09-14T08:00:00Z');
    const { transport, catalogue } = build({ now: () => now });
    transport.answer('get_vod_streams', undefined, LIBRARY);

    expect(await catalogue.indexIsFresh('vod')).toBe(false);
    await catalogue.index('vod');
    now = new Date('2026-09-15T07:59:00Z');
    expect(await catalogue.indexIsFresh('vod')).toBe(true);
    now = new Date('2026-09-15T08:01:00Z');
    expect(await catalogue.indexIsFresh('vod')).toBe(false);
  });

  it('shares one request between searches typed while it runs', async () => {
    const { transport, catalogue } = build();
    transport.answer('get_vod_streams', undefined, LIBRARY);

    await Promise.all([catalogue.index('vod'), catalogue.index('vod'), catalogue.index('vod')]);
    expect(transport.requests).toBe(1);
  });

  it('files a listing read a title at a time, keeping only what the store needs', async () => {
    const { transport, store, catalogue } = build();
    async function* rows() {
      yield { series_id: 7, title: 'Taskmaster', cover: 'http://img/t.jpg', category_id: '30', plot: 'A long synopsis', last_modified: '1790542044' };
      yield { series_id: 8, title: 'Novine', category_id: '30', cast: 'Many people' };
    }

    expect(await catalogue.indexFrom('series', rows())).toBe(2);

    expect(transport.requests).toBe(0);
    const filed = await store.readStreams('series', '30');
    expect(filed).toEqual([
      { stream_id: 7, name: 'Taskmaster', stream_icon: 'http://img/t.jpg', category_id: '30', added: '1790542044' },
      { stream_id: 8, name: 'Novine', stream_icon: '', category_id: '30', added: '0' }
    ]);
    expect(await catalogue.indexIsFresh('series')).toBe(true);
    expect((await catalogue.search('series', 'taskmaster')).map(s => s.name)).toEqual(['Taskmaster']);
  });

  it('files a library a reader hands over a category at a time, and marks it done last', async () => {
    const { store, catalogue } = build();
    const listing = JSON.stringify([
      { series_id: 7, title: 'Taskmaster', category_id: '30', plot: 'A long synopsis' },
      { series_id: 8, title: 'Novine', category_id: '31' },
      { series_id: 9, title: 'Nowhere' }
    ]);
    const bytes = (async function* () {
      yield new TextEncoder().encode(listing);
    })();
    const order: string[] = [];
    const filed: (number | null)[][] = [];

    const count = await catalogue.indexWith(
      'series',
      async file =>
        readLibraryHere(bytes, 'series', async (categoryId, streams) => {
          // Not done until every category is written.
          expect(await catalogue.indexIsFresh('series')).toBe(false);
          order.push(categoryId);
          await file(categoryId, streams);
        }),
      (done, total, titles) => filed.push([done, total, titles])
    );

    expect(count).toBe(3);
    // Counted as it goes, categories and titles; how many categories there are is not known while reading.
    expect(filed).toEqual([
      [1, null, 1],
      [2, null, 2]
    ]);
    expect(order).toEqual(['30', '31']);
    expect((await store.readStreams('series', '30')).map(s => s.name)).toEqual(['Taskmaster']);
    expect(await catalogue.indexIsFresh('series')).toBe(true);
  });

  it('writes nothing while paused, and goes on where it stopped (card 38)', async () => {
    const { store, catalogue } = build();
    let release: () => void = () => undefined;
    let paused = 0;
    const pause = () => {
      paused++;
      return paused === 2 ? new Promise<void>(resolve => (release = resolve)) : Promise.resolve();
    };
    const indexing = catalogue.indexWith(
      'series',
      async file => {
        await file('30', [{ stream_id: 7, name: 'Taskmaster', category_id: '30' } as never]);
        await file('31', [{ stream_id: 8, name: 'Novine', category_id: '31' } as never]);
        return 2;
      },
      undefined,
      pause
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await store.readStreams('series', '30')).map(s => s.name)).toEqual(['Taskmaster']);
    expect(await store.readStreams('series', '31')).toEqual([]);
    release();
    expect(await indexing).toBe(2);
    expect((await store.readStreams('series', '31')).map(s => s.name)).toEqual(['Novine']);
    expect(await catalogue.indexIsFresh('series')).toBe(true);
  });

  it('writes a library never held through the store\'s bulk, and a refresh not (card 42)', async () => {
    const { store, catalogue } = build();
    const bulks: number[] = [];
    (store as unknown as { bulk: CatalogueStore['bulk'] }).bulk = async work => {
      bulks.push(1);
      return work();
    };
    const listing = (async function* () {
      yield new TextEncoder().encode(JSON.stringify([{ series_id: 7, title: 'Taskmaster', category_id: '30' }]));
    });

    await catalogue.indexWith('series', file => readLibraryHere(listing(), 'series', file));
    expect(bulks).toHaveLength(1);
    await catalogue.indexWith('series', file => readLibraryHere(listing(), 'series', file));
    expect(bulks).toHaveLength(1);
  });

  it('keeps the library held whole when a refresh is cut short (card 42)', async () => {
    const { store, catalogue } = build();
    await store.writeStreams('series', '30', [{ stream_id: '1', name: 'Old one' } as never]);
    await store.writeStreams('series', '31', [{ stream_id: '2', name: 'Old two' } as never]);
    await store.markFetched('series', '__whole_library__', '2026-11-01T00:00:00.000Z');
    const before = await catalogue.indexedAt('series');

    await expect(
      catalogue.indexWith('series', async file => {
        await file('30', [{ stream_id: '1', name: 'New one' } as never]);
        throw new Error('connection dropped');
      })
    ).rejects.toThrow('connection dropped');

    // Every title held before is still there, and the library is not taken for a new whole one.
    expect((await store.readStreams('series', '30')).map(s => s.name)).toEqual(['New one']);
    expect((await store.readStreams('series', '31')).map(s => s.name)).toEqual(['Old two']);
    expect(await catalogue.indexedAt('series')).toBe(before);
  });

  it('does not count an index that failed as done', async () => {
    const failing = new Catalogue(
      new XtreamClient(
        { get: async () => ({ status: 503, data: null }) },
        { serverUrl: 'http://provider.example', username: 'joe', password: 'hunter2' }
      ),
      new MemoryStore()
    );

    await expect(failing.index('vod')).rejects.toThrow();
    expect(await failing.indexIsFresh('vod')).toBe(false);
  });
});
