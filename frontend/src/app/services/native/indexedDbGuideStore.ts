import {
  ChannelRef,
  GuideChannel,
  GuideHit,
  GuideLoadSummary,
  GuideProgramme,
  GuideStore,
  GuideTotals,
  KnownChannel
} from '@shared/xtream/guide';
import { titleMatches } from '@shared/xtream/guideSearch';
import { whenRunningOut } from '@shared/xtream/guideReload';

/**
 * The device's own guide, in IndexedDB on the desktop.
 *
 * What MemoryGuideStore should have been, and was not because SQLite on
 * Electron wants a native module rebuilt against Electron's own ABI. This
 * wants nothing: IndexedDB is already in the renderer, the quota runs to
 * hundreds of megabytes, and a guide of twenty-four thousand programmes is a
 * few of them.
 *
 * The cost of not having it was paid at every launch. A catalogue refills one
 * category at a time as you browse, so losing it on exit is a shrug; a guide
 * is one large download, so losing it means paying for the whole thing again
 * before the listing can say what is on.
 *
 * Same interface and same policy as the phone's SQLite store. What differs is
 * only how a window query is expressed.
 */

const DATABASE = 'iptv-guide';
const VERSION = 1;

const CHANNELS = 'channels';
const PROGRAMMES = 'programmes';
const LOADS = 'loads';

/** Programmes by when they end, which is all pruning ever asks about. */
const BY_STOP = 'stop';

/** Rows read at a time when searching titles. */
const SEARCH_BATCH = 2000;

const DAY = 24 * 60 * 60 * 1000;

/**
 * Which load wrote a row. Absent on rows written before reloads kept the
 * previous guide, which the next finished load of that source sweeps away.
 */
interface Generational {
  generation?: string;
}

interface ChannelRow extends GuideChannel, Generational {
  sourceId: string;
}

interface ProgrammeRow extends GuideProgramme, Generational {
  sourceId: string;
}

interface LoadRow extends GuideTotals {
  sourceId: string;
  loadedAt: string;
  /** When the last programme ends, epoch ms. Absent on loads from before it was kept. */
  lastStop?: number | null;
  /**
   * When a tenth of its channels have nothing left (whenRunningOut), worked
   * out as the load finished. Absent on a load from before it was kept.
   */
  runsOutAt?: number | null;
}

/** A request as a promise. */
const done = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * A transaction as a promise, resolved when it commits rather than when its
 * last request succeeds.
 *
 * The difference matters for writes. A request can succeed and the transaction
 * still abort afterwards, and reporting a load as finished when nothing
 * reached the disk is the one failure a store like this must not have.
 */
const committed = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('The guide transaction was abandoned'));
  });

/**
 * Every key belonging to one source.
 *
 * The empty array is a sentinel rather than a trick: IndexedDB sorts arrays
 * after every other kind of key, so `[sourceId, []]` sits above `[sourceId,
 * anything, anything]` and the range covers the source exactly. It is what
 * lets a source be cleared with one delete instead of a cursor walking
 * twenty-four thousand rows.
 */
const wholeSource = (sourceId: string): IDBKeyRange =>
  IDBKeyRange.bound([sourceId], [sourceId, []]);

/** One channel's programmes that could possibly overlap a window. */
const channelUpTo = (sourceId: string, channelId: string, to: number): IDBKeyRange =>
  // Everything this channel has, up to but not including what starts when the
  // window ends. The lower end is left open rather than bounded by `from`: the
  // programme on now started before the window did, and no index over starts
  // can find it. Pruning is what keeps that cheap, by not letting finished
  // programmes pile up behind it.
  IDBKeyRange.bound([sourceId, channelId], [sourceId, channelId, to], false, true);

const openGuideDatabase = (name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name, VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(CHANNELS)) {
        database.createObjectStore(CHANNELS, { keyPath: ['sourceId', 'id'] });
      }

      if (!database.objectStoreNames.contains(PROGRAMMES)) {
        // Source, channel and start together, so the key order is already the
        // order every read wants: one channel's evening, in sequence.
        const programmes = database.createObjectStore(PROGRAMMES, {
          keyPath: ['sourceId', 'channel', 'start']
        });
        programmes.createIndex(BY_STOP, 'stop');
      }

      if (!database.objectStoreNames.contains(LOADS)) {
        // Separate from the rows, so a load interrupted half way leaves no
        // readable guide behind: the rows are there and this is not.
        database.createObjectStore(LOADS, { keyPath: 'sourceId' });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      // A second window upgrading should not be held up by this one keeping
      // the old version open.
      database.onversionchange = () => database.close();
      resolve(database);
    };

    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Another window is holding an older guide database open'));
  });

export class IndexedDbGuideStore implements GuideStore {
  private database: IDBDatabase | null = null;

  constructor(
    private readonly name: string = DATABASE,
    /** Rows read at a time when searching titles; smaller in the tests, which write rows slowly. */
    private readonly searchBatch: number = SEARCH_BATCH
  ) {}

  async initialise(): Promise<void> {
    this.database ??= await openGuideDatabase(this.name);
  }

  /** The load each source is in the middle of, if any. */
  private readonly generations = new Map<string, string>();

  /**
   * Starts a load, leaving the previous guide exactly where it is.
   *
   * Nothing is deleted here any more. Rows are tagged with this load as they
   * are written, and `finishLoad` removes the ones that were not -- so a load
   * that is cut off, crashes or is closed half way leaves the guide it was
   * replacing readable, instead of the empty source it used to leave. See the
   * comment on `GuideStore.beginLoad` for the reload that lost a working guide.
   *
   * While a reload runs, a reader can see old rows and newly written ones side
   * by side. For a reload of the same feed that is nearly always the same
   * programme under the same key, overwritten in place; where a schedule moved,
   * a slot can show both until the load finishes. Briefly doubled is a far
   * smaller thing to be wrong about than gone.
   */
  async beginLoad(sourceId: string): Promise<void> {
    if (!this.database) {
      throw new Error('The guide database has not been opened');
    }
    this.generations.set(sourceId, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  }

  async writeChannels(sourceId: string, channels: GuideChannel[]): Promise<void> {
    if (!channels.length) {
      return;
    }

    const transaction = this.open(CHANNELS, 'readwrite');
    const store = transaction.objectStore(CHANNELS);

    for (const channel of channels) {
      const row: ChannelRow = {
        sourceId,
        id: channel.id,
        name: channel.name,
        generation: this.generations.get(sourceId)
      };
      store.put(row);
    }

    await committed(transaction);
  }

  async writeProgrammes(sourceId: string, programmes: GuideProgramme[]): Promise<void> {
    if (!programmes.length) {
      return;
    }

    const transaction = this.open(PROGRAMMES, 'readwrite');
    const store = transaction.objectStore(PROGRAMMES);

    for (const programme of programmes) {
      const row: ProgrammeRow = { ...programme, sourceId, generation: this.generations.get(sourceId) };
      store.put(row);
    }

    await committed(transaction);
  }

  async finishLoad(sourceId: string, at: string, totals?: GuideTotals): Promise<void> {
    const generation = this.generations.get(sourceId);
    this.generations.delete(sourceId);

    // One transaction for the sweep and the mark, so there is no moment where
    // the guide is marked as the new load while rows from the old one remain.
    const transaction = this.open([LOADS, CHANNELS, PROGRAMMES], 'readwrite');
    let channels = 0;
    let programmes = 0;
    let lastStop: number | null = null;
    const channelStops = new Map<string, number>();

    const sweep = (storeName: string, keep: (row: ProgrammeRow & ChannelRow) => void) =>
      new Promise<void>((resolve, reject) => {
        const request = transaction.objectStore(storeName).openCursor(wholeSource(sourceId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const row = cursor.value as ProgrammeRow & ChannelRow;
          if (row.generation === generation) {
            keep(row);
          } else {
            cursor.delete();
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });

    await Promise.all([
      sweep(CHANNELS, () => {
        channels += 1;
      }),
      sweep(PROGRAMMES, row => {
        programmes += 1;
        if (lastStop === null || row.stop > lastStop) {
          lastStop = row.stop;
        }
        channelStops.set(row.channel, Math.max(channelStops.get(row.channel) ?? -Infinity, row.stop));
      })
    ]);

    // Counted by the sweep when the caller does not say. Zero would read as
    // "this guide is empty", which is a different and wronger claim than
    // "nobody told me".
    const row: LoadRow = {
      sourceId,
      loadedAt: at,
      channels: totals?.channels ?? channels,
      programmes: totals?.programmes ?? programmes,
      lastStop,
      runsOutAt: whenRunningOut([...channelStops.values()], Date.parse(at))
    };
    transaction.objectStore(LOADS).put(row);

    await committed(transaction);
  }

  async lastLoadedAt(sourceId: string): Promise<string | null> {
    return (await this.loadRow(sourceId))?.loadedAt ?? null;
  }

  async loadSummary(sourceId: string): Promise<GuideLoadSummary | null> {
    const row = await this.loadRow(sourceId);
    if (!row) {
      return null;
    }

    return { loadedAt: row.loadedAt, channels: row.channels, programmes: row.programmes };
  }

  async channels(sourceId: string): Promise<GuideChannel[]> {
    const transaction = this.open(CHANNELS, 'readonly');
    const rows = await done<ChannelRow[]>(
      transaction.objectStore(CHANNELS).getAll(wholeSource(sourceId))
    );

    return rows
      .map(row => ({ id: row.id, name: row.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Every channel from every finished load.
   *
   * Filtered by the loads for the same reason the programmes are: a source
   * part way through loading should not offer channels that turn out to have
   * no schedule behind them.
   *
   * The same channel in two sources is returned twice, deliberately. Choosing
   * between them is the whole point of having more than one guide.
   */
  async allChannels(): Promise<KnownChannel[]> {
    const transaction = this.open([LOADS, CHANNELS], 'readonly');

    // Both asked for before either is awaited, so the transaction cannot
    // commit in between.
    const keys = done(transaction.objectStore(LOADS).getAllKeys());
    const channels = done<ChannelRow[]>(transaction.objectStore(CHANNELS).getAll());
    const [loaded, rows] = await Promise.all([keys, channels]);

    const finished = new Set(loaded.map(String));

    return rows
      .filter(row => finished.has(row.sourceId))
      .map(row => ({ id: row.id, name: row.name, sourceId: row.sourceId }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Programmes overlapping the window, for the channels asked about.
   *
   * One range read per channel, and the overlap decided here. `start < to` the
   * key order can answer; `stop > from` it cannot, because where a programme
   * ends has nothing to do with where its start sorts.
   */
  async programmesFor(refs: ChannelRef[], from: number, to: number): Promise<GuideProgramme[]> {
    if (!refs.length) {
      return [];
    }

    // The same channel asked for twice would otherwise be answered twice, and
    // drawn twice on top of itself.
    const wanted = new Map(refs.map(ref => [`${ref.sourceId} ${ref.channelId}`, ref]));

    const transaction = this.open([LOADS, PROGRAMMES], 'readonly');
    const store = transaction.objectStore(PROGRAMMES);

    const keys = done(transaction.objectStore(LOADS).getAllKeys());
    const reads = [...wanted.values()].map(ref =>
      done<ProgrammeRow[]>(store.getAll(channelUpTo(ref.sourceId, ref.channelId, to)))
    );

    const [loaded, ...results] = await Promise.all([keys, ...reads]);
    const finished = new Set(loaded.map(String));

    return results
      .flat()
      .filter(row => row.stop > from && finished.has(row.sourceId))
      .map(({ channel, start, stop, title, description, category }) => ({
        channel,
        start,
        stop,
        title,
        description,
        category
      }))
      .sort((left, right) => left.start - right.start);
  }

  /**
   * Titles found by walking the programmes in the window by when they end,
   * a batch at a time: IndexedDB has no way to look inside a title, and one
   * read of a guide's quarter of a million rows would hold them all in memory
   * at once. Ending order is close enough to starting order to stop early
   * once enough are found; the result is sorted by start before it is given.
   */
  async searchProgrammes(query: string, from: number, to: number, limit: number): Promise<GuideHit[]> {
    const loaded = new Set(
      (await done(this.open([LOADS], 'readonly').objectStore(LOADS).getAllKeys())).map(String)
    );
    const found = new Map<string, GuideHit>();
    let after = from;
    let afterInclusive = false;

    while (found.size < limit * 2) {
      const index = this.open([PROGRAMMES], 'readonly').objectStore(PROGRAMMES).index(BY_STOP);
      const batch = await done<ProgrammeRow[]>(index.getAll(IDBKeyRange.lowerBound(after, !afterInclusive), this.searchBatch));
      if (!batch.length) {
        break;
      }
      for (const row of batch) {
        if (row.start < to && loaded.has(row.sourceId) && titleMatches(row.title, query)) {
          const { sourceId, channel, start, stop, title, description, category } = row;
          found.set(`${sourceId} ${channel} ${start}`, { sourceId, channel, start, stop, title, description, category });
        }
      }
      const last = batch[batch.length - 1].stop;
      // Past the window by its end: nothing after this starts inside it, as no
      // programme is longer than a day.
      if (batch.length < this.searchBatch || last > to + DAY) {
        break;
      }
      // Rows sharing the last batch's final stop are read again rather than
      // skipped; the map keeps each once.
      after = last;
      afterInclusive = true;
      if (batch.every(row => row.stop === last)) {
        afterInclusive = false;
      }
    }

    return [...found.values()].sort((left, right) => left.start - right.start).slice(0, limit);
  }

  /**
   * When the last programme ends, as recorded when the load finished.
   *
   * Recorded rather than found. The first version walked the stop index
   * backwards to this source's latest row, and on a device carrying two large
   * guides that walk took the better part of a minute and a half.
   *
   * Null for a load from before this was kept, which reads as "no programmes"
   * -- and so earns that guide one reload, after which it is recorded. That is
   * the guide worth reloading anyway: it predates keeping itself fresh. So is
   * one recorded by its last programme of all, before it was the first tenth
   * of its channels to run out (6 October): the same one reload.
   */
  async runsOutAt(sourceId: string): Promise<number | null> {
    return (await this.loadRow(sourceId))?.runsOutAt ?? null;
  }

  async prune(before: number): Promise<void> {
    const transaction = this.open(PROGRAMMES, 'readwrite');
    const index = transaction.objectStore(PROGRAMMES).index(BY_STOP);
    const request = index.openCursor(IDBKeyRange.upperBound(before, true));

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      cursor.delete();
      cursor.continue();
    };

    await committed(transaction);
  }

  /** Throws the lot away, for a sign-out. */
  async forget(): Promise<void> {
    const transaction = this.open([LOADS, CHANNELS, PROGRAMMES], 'readwrite');

    transaction.objectStore(LOADS).clear();
    transaction.objectStore(CHANNELS).clear();
    transaction.objectStore(PROGRAMMES).clear();

    await committed(transaction);
  }

  /** Lets go of the database, for a window shutting down or a test. */
  close(): void {
    this.database?.close();
    this.database = null;
  }

  private async loadRow(sourceId: string): Promise<LoadRow | null> {
    const transaction = this.open(LOADS, 'readonly');
    const row = await done<LoadRow | undefined>(transaction.objectStore(LOADS).get(sourceId));
    return row ?? null;
  }

  private open(stores: string | string[], mode: IDBTransactionMode): IDBTransaction {
    if (!this.database) {
      throw new Error('The guide database has not been opened');
    }
    return this.database.transaction(stores, mode);
  }
}
