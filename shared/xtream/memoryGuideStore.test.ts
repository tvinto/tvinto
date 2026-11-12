import { GuideProgramme } from './guide';
import { MemoryGuideStore } from './memoryGuideStore';

const at = (iso: string) => Date.parse(iso);

/** A channel in a source, which is what the store is asked for. */
const ref = (channelId: string, sourceId = 'a') => ({ sourceId, channelId });

const programme = (channel: string, start: string, stop: string, title = 'P'): GuideProgramme => ({
  channel,
  start: at(start),
  stop: at(stop),
  title,
  description: '',
  category: ''
});

/** Writes a finished load, which is the only state anything reads back. */
const load = async (
  store: MemoryGuideStore,
  sourceId: string,
  programmes: GuideProgramme[]
): Promise<void> => {
  await store.beginLoad(sourceId);
  await store.writeProgrammes(sourceId, programmes);
  await store.finishLoad(sourceId, '2026-08-27T12:00:00.000Z');
};

describe('MemoryGuideStore', () => {
  it('keeps what it was given and says when it was loaded', async () => {
    const store = new MemoryGuideStore();
    await store.beginLoad('a');
    await store.writeChannels('a', [{ id: 'hrt1', name: 'HRT 1' }]);
    await store.finishLoad('a', '2026-08-27T12:00:00.000Z');

    expect(await store.channels('a')).toEqual([{ id: 'hrt1', name: 'HRT 1' }]);
    expect(await store.lastLoadedAt('a')).toBe('2026-08-27T12:00:00.000Z');
  });

  it('reports a source it has never loaded as never loaded', async () => {
    expect(await new MemoryGuideStore().lastLoadedAt('missing')).toBeNull();
  });

  // A load replaces rather than adds to what was there, so a programme
  // withdrawn upstream disappears instead of lingering.
  it('replaces the source when a new load finishes', async () => {
    const store = new MemoryGuideStore();
    await load(store, 'a', [programme('c', '2026-08-27T18:00:00Z', '2026-08-27T19:00:00Z', 'Old')]);
    await load(store, 'a', [programme('c', '2026-08-27T18:00:00Z', '2026-08-27T19:00:00Z', 'New')]);

    const found = await store.programmesFor([ref('c')], at('2026-08-27T00:00:00Z'), at('2026-08-28T00:00:00Z'));
    expect(found.map(p => p.title)).toEqual(['New']);
  });

  // The failure this store was changed for: a reload of a working guide was
  // cut off by a timeout, and the guide it was replacing was simply gone.
  it('keeps the previous guide when a reload never finishes', async () => {
    const store = new MemoryGuideStore();
    await load(store, 'a', [programme('c', '2026-08-27T18:00:00Z', '2026-08-27T19:00:00Z', 'Working')]);

    await store.beginLoad('a');
    await store.writeProgrammes('a', [
      programme('c', '2026-08-27T20:00:00Z', '2026-08-27T21:00:00Z', 'Half arrived')
    ]);

    const found = await store.programmesFor([ref('c')], at('2026-08-27T00:00:00Z'), at('2026-08-28T00:00:00Z'));
    expect(found.map(p => p.title)).toEqual(['Working']);
    expect(await store.lastLoadedAt('a')).not.toBeNull();
  });

  // A source that has never finished a load is still invisible: there is no
  // previous guide to keep, and half a first one is not a guide.
  it('shows nothing from a first load that has not finished', async () => {
    const store = new MemoryGuideStore();
    await store.beginLoad('a');
    await store.writeProgrammes('a', [
      programme('c', '2026-08-27T18:00:00Z', '2026-08-27T19:00:00Z')
    ]);

    expect(
      await store.programmesFor([ref('c')], at('2026-08-27T00:00:00Z'), at('2026-08-28T00:00:00Z'))
    ).toEqual([]);
  });

  describe('programmesFor', () => {
    const store = new MemoryGuideStore();

    beforeEach(async () => {
      await load(store, 'a', [
        programme('c', '2026-08-27T17:00:00Z', '2026-08-27T18:00:00Z', 'Before'),
        programme('c', '2026-08-27T18:00:00Z', '2026-08-27T19:00:00Z', 'During'),
        programme('c', '2026-08-27T19:00:00Z', '2026-08-27T20:00:00Z', 'After'),
        programme('other', '2026-08-27T18:00:00Z', '2026-08-27T19:00:00Z', 'Elsewhere')
      ]);
    });

    // The mistake this query exists not to make: the programme on now started
    // before the window did, so asking what is on at this moment with a
    // containment test returns nothing at all.
    it('returns a programme that started before the window and is still running', async () => {
      const now = at('2026-08-27T18:30:00Z');
      const found = await store.programmesFor([ref('c')], now, now + 1);

      expect(found.map(p => p.title)).toEqual(['During']);
    });

    it('includes anything overlapping the window at either end', async () => {
      const found = await store.programmesFor(
        [ref('c')],
        at('2026-08-27T17:30:00Z'),
        at('2026-08-27T19:30:00Z')
      );

      expect(found.map(p => p.title)).toEqual(['Before', 'During', 'After']);
    });

    it('excludes a programme that only touches the window edge', async () => {
      const found = await store.programmesFor(
        [ref('c')],
        at('2026-08-27T18:00:00Z'),
        at('2026-08-27T19:00:00Z')
      );

      expect(found.map(p => p.title)).toEqual(['During']);
    });

    it('returns only the channels asked for', async () => {
      const found = await store.programmesFor(
        [ref('other')],
        at('2026-08-27T00:00:00Z'),
        at('2026-08-28T00:00:00Z')
      );

      expect(found.map(p => p.title)).toEqual(['Elsewhere']);
    });

    it('returns them in the order they are on', async () => {
      const found = await store.programmesFor(
        [ref('c')],
        at('2026-08-27T00:00:00Z'),
        at('2026-08-28T00:00:00Z')
      );

      expect(found.map(p => p.start)).toEqual([...found.map(p => p.start)].sort((a, b) => a - b));
    });

    it('returns nothing for a channel it has never heard of', async () => {
      expect(
        await store.programmesFor([ref('nope')], at('2026-08-27T00:00:00Z'), at('2026-08-28T00:00:00Z'))
      ).toEqual([]);
    });
  });

  describe('with the same channel in two guides', () => {
    const twoGuides = async () => {
      const store = new MemoryGuideStore();
      await load(store, 'provider', [
        programme('c', '2026-08-27T18:00:00Z', '2026-08-27T19:00:00Z', 'From provider')
      ]);
      await load(store, 'xmltv', [
        programme('c', '2026-08-27T18:00:00Z', '2026-08-27T19:00:00Z', 'From XMLTV')
      ]);
      return store;
    };

    /**
     * The bug this signature exists to prevent.
     *
     * Two guides describing one channel use the same id for it. Asked by id
     * alone, the store answered with both schedules, and the listing drew them
     * on top of each other -- one row wearing two guides.
     */
    it('answers with one guide, not both', async () => {
      const store = await twoGuides();

      const found = await store.programmesFor(
        [ref('c', 'provider')],
        at('2026-08-27T00:00:00Z'),
        at('2026-08-28T00:00:00Z')
      );

      expect(found.map(p => p.title)).toEqual(['From provider']);
    });

    it('answers with the other one when that is what was asked for', async () => {
      const store = await twoGuides();

      const found = await store.programmesFor(
        [ref('c', 'xmltv')],
        at('2026-08-27T00:00:00Z'),
        at('2026-08-28T00:00:00Z')
      );

      expect(found.map(p => p.title)).toEqual(['From XMLTV']);
    });

    // Still possible on purpose: different channels from different guides in
    // one read is how a listing of mixed rows is drawn.
    it('reads from several guides when several are asked for', async () => {
      const store = await twoGuides();

      const found = await store.programmesFor(
        [ref('c', 'provider'), ref('c', 'xmltv')],
        at('2026-08-27T00:00:00Z'),
        at('2026-08-28T00:00:00Z')
      );

      expect(found).toHaveLength(2);
    });

    // A reload is not a first load: the guide already answered, and hiding it
    // for the length of a download is how a slow feed empties the listing.
    it('keeps a guide readable while it is being reloaded', async () => {
      const store = await twoGuides();
      await store.beginLoad('xmltv');

      const found = await store.programmesFor(
        [ref('c', 'provider'), ref('c', 'xmltv')],
        at('2026-08-27T00:00:00Z'),
        at('2026-08-28T00:00:00Z')
      );

      expect(found).toHaveLength(2);
    });
  });

  it('remembers how much a load brought in', async () => {
    const store = new MemoryGuideStore();
    await store.beginLoad('a');
    await store.writeChannels('a', [{ id: 'c', name: 'C' }]);
    await store.finishLoad('a', '2026-08-27T12:00:00.000Z', { channels: 213, programmes: 24536 });

    expect(await store.loadSummary('a')).toEqual({
      loadedAt: '2026-08-27T12:00:00.000Z',
      channels: 213,
      programmes: 24536
    });
  });

  it('has no summary for a guide it has never loaded', async () => {
    expect(await new MemoryGuideStore().loadSummary('missing')).toBeNull();
  });

  it('prunes what has finished and keeps what has not', async () => {
    const store = new MemoryGuideStore();
    await load(store, 'a', [
      programme('c', '2026-08-27T10:00:00Z', '2026-08-27T11:00:00Z', 'Over'),
      programme('c', '2026-08-27T18:00:00Z', '2026-08-27T19:00:00Z', 'Later')
    ]);

    await store.prune(at('2026-08-27T12:00:00Z'));

    const found = await store.programmesFor(
      [ref('c')],
      at('2026-08-27T00:00:00Z'),
      at('2026-08-28T00:00:00Z')
    );
    expect(found.map(p => p.title)).toEqual(['Later']);
  });

  it('forgets everything, for a sign-out', async () => {
    const store = new MemoryGuideStore();
    await load(store, 'a', [programme('c', '2026-08-27T18:00:00Z', '2026-08-27T19:00:00Z')]);

    await store.forget();

    expect(await store.lastLoadedAt('a')).toBeNull();
    expect(await store.channels('a')).toEqual([]);
  });
});
