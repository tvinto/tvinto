import 'fake-indexeddb/auto';

import { Stream, StreamType } from '@shared/types';
import { IndexedDbCatalogueStore } from './indexedDbCatalogueStore';

/**
 * The desktop's catalogue store.
 *
 * The test that matters is the last one: what a second launch finds. The
 * memory store this replaces passed everything else and still made the app
 * re-index the whole library at every launch, because nothing it wrote
 * survived the window closing.
 */

let databases = 0;

const freshName = (): string => `catalogue-test-${++databases}`;

const open = async (provider: string, name: string): Promise<IndexedDbCatalogueStore> => {
  const store = new IndexedDbCatalogueStore(provider, name);
  await store.initialise();
  return store;
};

const film = (id: string, name: string, added = 0): Stream =>
  ({ stream_id: id, name, added: String(added) }) as unknown as Stream;

const VOD: StreamType = 'vod';

describe('IndexedDbCatalogueStore', () => {
  it('keeps categories and streams, and reads them back', async () => {
    const store = await open('line-a', freshName());

    await store.writeCategories(VOD, [{ category_id: '1', category_name: 'HR' }] as never);
    await store.writeStreams(VOD, '1', [film('10', 'Ne diraj mi mamu')]);

    expect(await store.readCategories(VOD)).toHaveLength(1);
    expect(await store.readStreams(VOD, '1')).toHaveLength(1);
    expect(await store.readStreams(VOD, '2')).toEqual([]);
  });

  it('remembers when a category was asked about, empty or not', async () => {
    const store = await open('line-a', freshName());

    expect(await store.lastFetchedAt(VOD, '7')).toBeNull();
    await store.markFetched(VOD, '7', '2026-09-16T10:00:00.000Z');

    expect(await store.lastFetchedAt(VOD, '7')).toBe('2026-09-16T10:00:00.000Z');
  });

  it('finds streams by every word, across categories, up to the limit', async () => {
    const store = await open('line-a', freshName());
    await store.writeStreams(VOD, '1', [film('10', 'EN - X-Men Apocalypse'), film('11', 'EN - Logan')]);
    await store.writeStreams(VOD, '2', [film('12', 'EN - X-Men First Class')]);

    expect(await store.findStreams(VOD, ['x-men'], 10)).toHaveLength(2);
    expect(await store.findStreams(VOD, ['x-men', 'logan'], 10)).toEqual([]);
    expect(await store.findStreams(VOD, ['en'], 1)).toHaveLength(1);
  });

  it('lists what was added most recently, with the category it is in', async () => {
    const store = await open('line-a', freshName());
    await store.writeStreams(VOD, '1', [film('10', 'Older', 1000), film('11', 'No date')]);
    await store.writeStreams(VOD, '2', [film('12', 'Newer', 2000)]);

    const recent = await store.recentlyAdded(VOD, 5);

    expect(recent.map(stream => stream.name)).toEqual(['Newer', 'Older']);
    expect((recent[0] as unknown as { category_id: string }).category_id).toBe('2');
  });

  it('is still there on the next launch, which is the whole point', async () => {
    const name = freshName();
    const first = await open('line-a', name);
    await first.writeStreams(VOD, '1', [film('10', 'X-Men')]);
    await first.markFetched(VOD, '__whole_library__', '2026-09-16T10:00:00.000Z');
    first.close();

    const second = await open('line-a', name);

    expect(await second.readStreams(VOD, '1')).toHaveLength(1);
    expect(await second.lastFetchedAt(VOD, '__whole_library__')).toBe('2026-09-16T10:00:00.000Z');
    expect(await second.findStreams(VOD, ['x-men'], 5)).toHaveLength(1);
  });

  it('keeps two subscriptions apart', async () => {
    const name = freshName();
    const mine = await open('line-a', name);
    await mine.writeStreams(VOD, '1', [film('10', 'Mine')]);
    mine.close();

    const other = await open('line-b', name);

    expect(await other.readStreams(VOD, '1')).toEqual([]);
    expect(await other.lastFetchedAt(VOD, '1')).toBeNull();
  });

  it('forgets one subscription without touching the other', async () => {
    const name = freshName();
    const mine = await open('line-a', name);
    const other = await open('line-b', name);
    await mine.writeStreams(VOD, '1', [film('10', 'Mine')]);
    await other.writeStreams(VOD, '1', [film('20', 'Theirs')]);

    await mine.clear();
    mine.close();
    other.close();

    const reopenedMine = await open('line-a', name);
    const reopenedOther = await open('line-b', name);

    expect(await reopenedMine.readStreams(VOD, '1')).toEqual([]);
    expect(await reopenedOther.readStreams(VOD, '1')).toHaveLength(1);
  });
});
