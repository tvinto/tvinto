import { Catalogue, CatalogueStore } from '../xtream/catalogue';
import { CatalogueSource } from '../xtream/source';
import { Category, Stream, StreamType } from '../types';
import { searchable } from '../xtream/channelNames';
import { subscriptionId } from '../xtream/guideSourceId';
import { newTag, readProviderRecord, recordId, shortProviderName, tagged, untagged } from './providerRecord';
import { MergedCatalogue } from './mergedCatalogue';
import { bringProviders } from './bringProviders';

describe('provider records', () => {
  it('reads the subscription stored before there could be several as the first Xtream slot', () => {
    const record = readProviderRecord(
      JSON.stringify({ serverUrl: 'http://line.example:8080', username: 'u', password: 'p' })
    );
    expect(record).toEqual({
      kind: 'xtream',
      tag: '',
      label: 'line.example',
      enabled: true,
      serverUrl: 'http://line.example:8080',
      username: 'u',
      password: 'p'
    });
    // The same row the account already has.
    expect(recordId(record!)).toBe(subscriptionId('http://line.example:8080', 'u'));
  });

  it('reads a playlist, its label and whether it is switched off', () => {
    expect(
      readProviderRecord(JSON.stringify({ kind: 'm3u', tag: 'p1x', label: 'Home', enabled: false, url: 'http://x/list.m3u' }))
    ).toEqual({ kind: 'm3u', tag: 'p1x', label: 'Home', enabled: false, url: 'http://x/list.m3u' });
  });

  it('reads nothing from a record missing what it needs, or not JSON', () => {
    expect(readProviderRecord(JSON.stringify({ serverUrl: 'http://x', username: 'u' }))).toBeNull();
    expect(readProviderRecord(JSON.stringify({ kind: 'm3u' }))).toBeNull();
    expect(readProviderRecord('nope')).toBeNull();
    expect(readProviderRecord(null)).toBeNull();
  });

  it('takes an unusable tag as the first slot rather than inventing ids', () => {
    expect(readProviderRecord(JSON.stringify({ kind: 'm3u', tag: 'Bad Tag!', url: 'http://x' }))?.tag).toBe('');
  });
});

describe('tagged ids', () => {
  it('leaves the first slot alone and prefixes the rest, both ways', () => {
    expect(tagged('', 123)).toBe('123');
    expect(tagged('p1x', 123)).toBe('p1x~123');
    expect(untagged('p1x~123')).toEqual({ tag: 'p1x', id: '123' });
    expect(untagged('123')).toEqual({ tag: '', id: '123' });
    expect(untagged('p1x~m9~z')).toEqual({ tag: 'p1x', id: 'm9~z' });
  });

  it('does not take an id that merely contains the separator for a tagged one', () => {
    expect(untagged('Some Name~1')).toEqual({ tag: '', id: 'Some Name~1' });
  });

  it('makes a tag no other slot has', () => {
    let calls = 0;
    const sequence = () => (calls++ === 0 ? 0 : 0.5);
    expect(newTag(['p000'], sequence)).not.toBe('p000');
  });
});

/** A source that answers from fixed lists, and can be made to fail. */
const source = (categories: Category[], streams: Record<string, Stream[]>, fail = false): CatalogueSource => ({
  getCategories: async () => {
    if (fail) {
      throw new Error('down');
    }
    return categories;
  },
  getStreams: async (_type: StreamType, categoryId?: string) =>
    categoryId ? (streams[categoryId] ?? []) : Object.values(streams).flat()
});

const memoryStore = (): CatalogueStore => {
  const kept = new Map<string, unknown>();
  return {
    readCategories: async type => (kept.get(`c:${type}`) as Category[]) ?? [],
    writeCategories: async (type, list) => void kept.set(`c:${type}`, list),
    readStreams: async (type, id) => (kept.get(`s:${type}:${id}`) as Stream[]) ?? [],
    writeStreams: async (type, id, list) => void kept.set(`s:${type}:${id}`, list),
    lastFetchedAt: async (type, id) => (kept.get(`m:${type}:${id}`) as string) ?? null,
    markFetched: async (type, id, at) => void kept.set(`m:${type}:${id}`, at),
    findStreams: async (type, words, _limit, joined) =>
      [...kept.entries()]
        .filter(([key]) => key.startsWith(`s:${type}:`))
        .flatMap(([, list]) => list as Stream[])
        .filter(stream => words.every(word => (joined ? searchable(stream.name) : stream.name.toLowerCase()).includes(word))),
    recentlyAdded: async () => []
  };
};

const category = (id: string, name: string): Category => ({ category_id: id, category_name: name, parent_id: '0' });
const stream = (id: string, name: string, categoryId: string): Stream =>
  ({ stream_id: id, name, icon: '', category_id: categoryId }) as Stream;

describe('MergedCatalogue', () => {
  const first = () =>
    new Catalogue(source([category('1', 'News')], { '1': [stream('10', 'HRT 1', '1')] }), memoryStore());
  const second = (fail = false) =>
    new Catalogue(
      source([category('1', 'Sport')], { '1': [stream('10', 'Arena 1', '1')] }, fail),
      memoryStore()
    );

  it('is the one provider unchanged when there is only one', async () => {
    const merged = new MergedCatalogue([{ tag: '', catalogue: first() }]);
    expect(await merged.categories('live')).toEqual([{ ...category('1', 'News'), provider: '' }]);
    expect((await merged.streams('live', '1'))[0]).toEqual(
      expect.objectContaining({ stream_id: '10', category_id: '1', provider: '' })
    );
  });

  it('puts every provider side by side, the same ids kept apart by tag', async () => {
    const merged = new MergedCatalogue([
      { tag: '', catalogue: first() },
      { tag: 'p2a', catalogue: second() }
    ]);

    const categories = await merged.categories('live');
    expect(categories.map(c => [c.category_id, c.category_name, c.provider])).toEqual([
      ['1', 'News', ''],
      ['p2a~1', 'Sport', 'p2a']
    ]);

    const [arena] = await merged.streams('live', 'p2a~1');
    expect(arena).toEqual(expect.objectContaining({ stream_id: 'p2a~10', category_id: 'p2a~1', name: 'Arena 1' }));
    expect((await merged.streams('live', '1'))[0].name).toBe('HRT 1');
  });

  it('searches every provider', async () => {
    const merged = new MergedCatalogue([
      { tag: '', catalogue: first() },
      { tag: 'p2a', catalogue: second() }
    ]);
    await merged.streams('live', '1');
    await merged.streams('live', 'p2a~1');
    expect((await merged.search('live', '1')).map(s => s.stream_id)).toEqual(['10', 'p2a~10']);
  });

  it('shows the rest when one provider cannot be reached', async () => {
    const merged = new MergedCatalogue([
      { tag: '', catalogue: first() },
      { tag: 'p2a', catalogue: second(true) }
    ]);
    expect((await merged.categories('live')).map(c => c.category_name)).toEqual(['News']);
  });

  it('goes on without a slow provider, and says when it has answered', async () => {
    let answer: (list: Category[]) => void = () => undefined;
    const slow = new Catalogue(
      {
        getCategories: () => new Promise<Category[]>(resolve => (answer = resolve)),
        getStreams: async () => []
      },
      memoryStore()
    );
    let told = 0;
    const merged = new MergedCatalogue(
      [
        { tag: '', catalogue: first() },
        { tag: 'p2a', catalogue: slow }
      ],
      { waitMs: 10, onLate: () => told++ }
    );

    expect((await merged.categories('live')).map(c => c.category_name)).toEqual(['News']);
    answer([category('5', 'Late')]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(told).toBe(1);
    expect((await merged.categories('live')).map(c => c.category_name)).toEqual(['News', 'Late']);
  });

  it('answers nothing for a slot that is not there', async () => {
    const merged = new MergedCatalogue([{ tag: '', catalogue: first() }]);
    expect(await merged.streams('live', 'zz9~1')).toEqual([]);
  });
});

describe('shortProviderName', () => {
  it("takes the part of an address that names it, and caps a name at twelve characters", () => {
    expect(shortProviderName('bestplaylist.example')).toBe('bestplaylist');
    expect(shortProviderName('Free-to-air')).toBe('Free-to-air');
    expect(shortProviderName('A very long provider name')).toBe('A very long…');
    expect(shortProviderName('line.provider.co.uk')).toBe('provider');
    expect(shortProviderName('mag.someprovider.tv')).toBe('someprovider');
  });
});

describe('a portal on an account', () => {
  const portal = (tag: string, portalUrl: string, mac: string) =>
    ({ kind: 'stalker', tag, enabled: true, label: portalUrl, portalUrl, mac }) as const;

  it('reads a sealed portal back, and keeps the MAC a password would be kept', () => {
    const record = readProviderRecord(JSON.stringify(portal('pq1', 'http://p.example/c', '00:1A:79:00:00:01')));

    expect(record).toEqual(expect.objectContaining({ kind: 'stalker', portalUrl: 'http://p.example/c', mac: '00:1A:79:00:00:01' }));
    expect(readProviderRecord(JSON.stringify({ kind: 'stalker', portalUrl: 'http://p.example/c' }))).toBeNull();
  });

  it('does not double a portal the account already has, however its address is written', () => {
    const account = [portal('pq1', 'http://p.example/c', '00:1A:79:00:00:01')];
    const brought = bringProviders(account, [portal('', 'http://p.example/stalker_portal/server/load.php', '00:1a:79:00:00:01')], () => 0.5);

    expect(brought.added).toEqual([]);
    expect(brought.moves.get('')).toBe('pq1');
  });
});
