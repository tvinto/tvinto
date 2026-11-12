import 'fake-indexeddb/auto';

import { GuideProgramme } from '@shared/xtream/guide';
import { IndexedDbGuideStore } from './indexedDbGuideStore';

/**
 * The desktop's guide store.
 *
 * Worth testing rather than merely writing, because almost everything here is
 * a claim about key order: that a source can be cleared in one delete, that a
 * programme already running is still found, that two guides using the same
 * channel id stay apart. Every one of those is silent when wrong -- the guide
 * simply looks empty, or doubled.
 */

let databases = 0;

/** A store on a database of its own, so tests cannot see each other's rows. */
const freshStore = async (): Promise<IndexedDbGuideStore> => {
  const store = new IndexedDbGuideStore(`guide-test-${++databases}`);
  await store.initialise();
  return store;
};

const at = (hour: number): number => Date.UTC(2026, 7, 30, hour, 0, 0);

const programme = (
  channel: string,
  from: number,
  to: number,
  title = 'Something'
): GuideProgramme => ({
  channel,
  start: at(from),
  stop: at(to),
  title,
  description: '',
  category: ''
});

/** A source written and marked finished, which is what makes it readable. */
const load = async (
  store: IndexedDbGuideStore,
  sourceId: string,
  channels: { id: string; name: string }[],
  programmes: GuideProgramme[]
): Promise<void> => {
  await store.beginLoad(sourceId);
  await store.writeChannels(sourceId, channels);
  await store.writeProgrammes(sourceId, programmes);
  await store.finishLoad(sourceId, '2026-08-30T10:00:00.000Z', {
    channels: channels.length,
    programmes: programmes.length
  });
};

describe('IndexedDbGuideStore', () => {
  it('still has the guide after the window closes', async () => {
    const store = await freshStore();
    const name = `guide-test-${databases}`;

    await load(store, 'hr', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 20, 21)]);
    store.close();

    const reopened = new IndexedDbGuideStore(name);
    await reopened.initialise();

    expect(await reopened.allChannels()).toEqual([
      { id: 'HTV1.hr', name: 'HTV 1', sourceId: 'hr' }
    ]);
    expect(
      await reopened.programmesFor([{ sourceId: 'hr', channelId: 'HTV1.hr' }], at(19), at(22))
    ).toHaveLength(1);
    expect(await reopened.lastLoadedAt('hr')).toBe('2026-08-30T10:00:00.000Z');
  });

  // The reload that lost a working guide of six thousand channels: cut off by a
  // timeout two minutes in, after the old rows had already been deleted.
  it('keeps the previous guide readable when a reload never finishes', async () => {
    const store = await freshStore();
    await load(store, 'hr', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 20, 21, 'Working')]);

    await store.beginLoad('hr');
    await store.writeProgrammes('hr', [programme('HTV1.hr', 22, 23, 'Half arrived')]);

    expect(await store.allChannels()).toEqual([{ id: 'HTV1.hr', name: 'HTV 1', sourceId: 'hr' }]);
    const found = await store.programmesFor([{ sourceId: 'hr', channelId: 'HTV1.hr' }], at(19), at(21));
    expect(found.map(entry => entry.title)).toEqual(['Working']);
    expect(await store.lastLoadedAt('hr')).toBe('2026-08-30T10:00:00.000Z');
  });

  it('sweeps away rows from before the reload once it finishes', async () => {
    const store = await freshStore();
    await load(store, 'hr', [{ id: 'Gone.hr', name: 'Withdrawn' }], [programme('Gone.hr', 20, 21)]);

    // A failed attempt first, which must not survive the next good load either.
    await store.beginLoad('hr');
    await store.writeProgrammes('hr', [programme('Gone.hr', 21, 22, 'Stray')]);

    await load(store, 'hr', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 20, 21)]);

    expect((await store.allChannels()).map(channel => channel.id)).toEqual(['HTV1.hr']);
    expect(
      await store.programmesFor([{ sourceId: 'hr', channelId: 'Gone.hr' }], at(19), at(23))
    ).toEqual([]);
  });

  it('records when the guide runs out, and keeps it through a failed reload', async () => {
    const store = await freshStore();
    await load(
      store,
      'hr',
      [{ id: 'HTV1.hr', name: 'HTV 1' }],
      [programme('HTV1.hr', 20, 21), programme('HTV1.hr', 21, 23)]
    );
    expect(await store.runsOutAt('hr')).toBe(at(23));

    await store.beginLoad('hr');
    await store.writeProgrammes('hr', [programme('HTV1.hr', 23, 24)]);
    expect(await store.runsOutAt('hr')).toBe(at(23));
  });

  it('shows nothing from a first load that never finished', async () => {
    const store = await freshStore();

    await store.beginLoad('hr');
    await store.writeChannels('hr', [{ id: 'HTV1.hr', name: 'HTV 1' }]);
    await store.writeProgrammes('hr', [programme('HTV1.hr', 20, 21)]);

    // The rows are there. What is missing is the mark that says they are a
    // whole guide, and everything that reads goes through it.
    expect(await store.allChannels()).toEqual([]);
    expect(
      await store.programmesFor([{ sourceId: 'hr', channelId: 'HTV1.hr' }], at(19), at(22))
    ).toEqual([]);
    expect(await store.lastLoadedAt('hr')).toBeNull();
  });

  it('replaces a source rather than merging into it', async () => {
    const store = await freshStore();

    await load(
      store,
      'hr',
      [
        { id: 'HTV1.hr', name: 'HTV 1' },
        { id: 'Gone.hr', name: 'Withdrawn' }
      ],
      [programme('HTV1.hr', 20, 21, 'Old news'), programme('Gone.hr', 20, 21)]
    );

    await load(store, 'hr', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 20, 21, 'New news')]);

    expect((await store.allChannels()).map(channel => channel.id)).toEqual(['HTV1.hr']);

    const found = await store.programmesFor(
      [
        { sourceId: 'hr', channelId: 'HTV1.hr' },
        { sourceId: 'hr', channelId: 'Gone.hr' }
      ],
      at(19),
      at(22)
    );

    expect(found.map(entry => entry.title)).toEqual(['New news']);
  });

  it('leaves other sources alone when one is replaced', async () => {
    const store = await freshStore();

    await load(store, 'hr', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 20, 21)]);
    await load(store, 'uk', [{ id: 'BBC1.uk', name: 'BBC One' }], [programme('BBC1.uk', 20, 21)]);
    await load(store, 'hr', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 21, 22)]);

    expect((await store.allChannels()).map(channel => channel.sourceId).sort()).toEqual([
      'hr',
      'uk'
    ]);
    expect(
      await store.programmesFor([{ sourceId: 'uk', channelId: 'BBC1.uk' }], at(19), at(22))
    ).toHaveLength(1);
  });

  describe('the window query', () => {
    it('finds the programme already running', async () => {
      const store = await freshStore();
      await load(store, 'hr', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 19, 21)]);

      // Asking what is on at eight when the film started at seven. A
      // containment test would say nothing is on.
      const found = await store.programmesFor(
        [{ sourceId: 'hr', channelId: 'HTV1.hr' }],
        at(20),
        at(22)
      );

      expect(found).toHaveLength(1);
    });

    it('leaves out what finished before the window and what starts after it', async () => {
      const store = await freshStore();
      await load(
        store,
        'hr',
        [{ id: 'HTV1.hr', name: 'HTV 1' }],
        [
          programme('HTV1.hr', 17, 18, 'Over'),
          programme('HTV1.hr', 20, 21, 'On'),
          programme('HTV1.hr', 23, 24, 'Later')
        ]
      );

      const found = await store.programmesFor(
        [{ sourceId: 'hr', channelId: 'HTV1.hr' }],
        at(19),
        at(22)
      );

      expect(found.map(entry => entry.title)).toEqual(['On']);
    });

    it('keeps two guides apart when they use the same channel id', async () => {
      const store = await freshStore();

      await load(store, 'one', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 20, 21, 'From one')]);
      await load(store, 'two', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 20, 21, 'From two')]);

      const found = await store.programmesFor(
        [{ sourceId: 'two', channelId: 'HTV1.hr' }],
        at(19),
        at(22)
      );

      // One row, from the guide that was asked. Matching on the id alone gives
      // both, and draws two schedules on top of each other.
      expect(found.map(entry => entry.title)).toEqual(['From two']);
    });

    it('answers a channel asked for twice only once', async () => {
      const store = await freshStore();
      await load(store, 'hr', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 20, 21)]);

      const found = await store.programmesFor(
        [
          { sourceId: 'hr', channelId: 'HTV1.hr' },
          { sourceId: 'hr', channelId: 'HTV1.hr' }
        ],
        at(19),
        at(22)
      );

      expect(found).toHaveLength(1);
    });

    it('returns programmes in order across channels', async () => {
      const store = await freshStore();
      await load(
        store,
        'hr',
        [
          { id: 'HTV1.hr', name: 'HTV 1' },
          { id: 'HTV2.hr', name: 'HTV 2' }
        ],
        [programme('HTV1.hr', 21, 22, 'Second'), programme('HTV2.hr', 19, 20, 'First')]
      );

      const found = await store.programmesFor(
        [
          { sourceId: 'hr', channelId: 'HTV1.hr' },
          { sourceId: 'hr', channelId: 'HTV2.hr' }
        ],
        at(18),
        at(23)
      );

      expect(found.map(entry => entry.title)).toEqual(['First', 'Second']);
    });

    it('asks for nothing when given nothing', async () => {
      const store = await freshStore();
      expect(await store.programmesFor([], at(19), at(22))).toEqual([]);
    });
  });

  it('offers the same channel from every guide that has it', async () => {
    const store = await freshStore();

    await load(store, 'one', [{ id: 'DomaTv.hr', name: 'Doma TV' }], []);
    await load(store, 'two', [{ id: 'Doma.TV.HD.hr', name: 'Doma TV' }], []);

    const channels = await store.allChannels();

    // Collapsing these would take away the choice the picker exists to offer.
    expect(channels).toHaveLength(2);
    expect(channels.map(channel => channel.sourceId).sort()).toEqual(['one', 'two']);
  });

  it('lists one source by name', async () => {
    const store = await freshStore();

    await load(
      store,
      'hr',
      [
        { id: 'b', name: 'Nova TV' },
        { id: 'a', name: 'Doma TV' }
      ],
      []
    );
    await load(store, 'uk', [{ id: 'c', name: 'BBC One' }], []);

    expect((await store.channels('hr')).map(channel => channel.name)).toEqual([
      'Doma TV',
      'Nova TV'
    ]);
  });

  it('says what a source holds without loading it again', async () => {
    const store = await freshStore();
    await load(
      store,
      'hr',
      [{ id: 'HTV1.hr', name: 'HTV 1' }],
      [programme('HTV1.hr', 20, 21), programme('HTV1.hr', 21, 22)]
    );

    expect(await store.loadSummary('hr')).toEqual({
      loadedAt: '2026-08-30T10:00:00.000Z',
      channels: 1,
      programmes: 2
    });
    expect(await store.loadSummary('never-loaded')).toBeNull();
  });

  it('counts the rows itself when the load does not say', async () => {
    const store = await freshStore();

    await store.beginLoad('hr');
    await store.writeChannels('hr', [{ id: 'HTV1.hr', name: 'HTV 1' }]);
    await store.writeProgrammes('hr', [programme('HTV1.hr', 20, 21)]);
    await store.finishLoad('hr', '2026-08-30T10:00:00.000Z');

    // Zero would read as "this guide is empty", which is a wronger thing to
    // say than counting.
    expect(await store.loadSummary('hr')).toEqual({
      loadedAt: '2026-08-30T10:00:00.000Z',
      channels: 1,
      programmes: 1
    });
  });

  it('prunes what has finished and keeps what has not', async () => {
    const store = await freshStore();
    await load(
      store,
      'hr',
      [{ id: 'HTV1.hr', name: 'HTV 1' }],
      [
        programme('HTV1.hr', 12, 13, 'This morning'),
        programme('HTV1.hr', 19, 21, 'Running now'),
        programme('HTV1.hr', 21, 22, 'Tonight')
      ]
    );

    await store.prune(at(20));

    const found = await store.programmesFor(
      [{ sourceId: 'hr', channelId: 'HTV1.hr' }],
      at(0),
      at(23)
    );

    // The one still running survives: it has not finished, whatever the clock
    // says about when it started.
    expect(found.map(entry => entry.title)).toEqual(['Running now', 'Tonight']);
  });

  it('throws the lot away on a sign-out', async () => {
    const store = await freshStore();
    await load(store, 'hr', [{ id: 'HTV1.hr', name: 'HTV 1' }], [programme('HTV1.hr', 20, 21)]);

    await store.forget();

    expect(await store.allChannels()).toEqual([]);
    expect(await store.lastLoadedAt('hr')).toBeNull();
    expect(
      await store.programmesFor([{ sourceId: 'hr', channelId: 'HTV1.hr' }], at(19), at(22))
    ).toEqual([]);
  });

  it('writes nothing when given nothing, rather than opening a transaction', async () => {
    const store = await freshStore();

    await store.beginLoad('hr');
    await expect(store.writeChannels('hr', [])).resolves.toBeUndefined();
    await expect(store.writeProgrammes('hr', [])).resolves.toBeUndefined();
  });

  it('refuses to work before it has been opened', async () => {
    const store = new IndexedDbGuideStore('guide-test-unopened');
    await expect(store.beginLoad('hr')).rejects.toThrow('has not been opened');
  });

  describe('searching titles', () => {
    it('finds them in loaded guides, accents folded, soonest first, within the window', async () => {
      const store = await freshStore();
      await load(store, 'hr', [{ id: 'hrt1.hr', name: 'HRT 1' }], [
        programme('hrt1.hr', 9, 10, 'Šport'),
        programme('hrt1.hr', 19, 20, 'Dnevnik'),
        programme('hrt1.hr', 22, 23, 'Sportske vijesti')
      ]);

      const found = await store.searchProgrammes('sport', at(8), at(21), 10);
      expect(found.map(hit => [hit.sourceId, hit.title])).toEqual([['hr', 'Šport']]);
    });

    it('reads past a batch, and stops at the limit', async () => {
      // Batches of ten, so twenty-five rows cross two of them.
      const store = new IndexedDbGuideStore(`guide-test-${++databases}`, 10);
      await store.initialise();
      const many = Array.from({ length: 25 }, (_, i) => ({
        ...programme('hrt1.hr', 0, 1, i % 2 ? 'Dnevnik' : 'Vijesti'),
        start: at(0) + i * 60_000,
        stop: at(0) + (i + 1) * 60_000
      }));
      await load(store, 'hr', [{ id: 'hrt1.hr', name: 'HRT 1' }], many);

      const found = await store.searchProgrammes('dnevnik', at(0), at(0) + 30 * 60_000, 100);
      expect(found).toHaveLength(12);
      expect(found.map(hit => hit.start)).toEqual([...found.map(hit => hit.start)].sort((a, b) => a - b));
      expect(await store.searchProgrammes('dnevnik', at(0), at(0) + 30 * 60_000, 3)).toHaveLength(3);
    });

    it('leaves out a guide that has not finished loading', async () => {
      const store = await freshStore();
      await store.beginLoad('half');
      await store.writeProgrammes('half', [programme('n1.hr', 9, 10, 'Dnevnik')]);

      expect(await store.searchProgrammes('dnevnik', at(0), at(23), 10)).toEqual([]);
    });
  });
});
