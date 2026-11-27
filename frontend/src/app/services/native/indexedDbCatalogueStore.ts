import { Category, Stream, StreamType } from '@shared/types';
import { CatalogueStore } from '@shared/xtream/catalogue';
import { searchable } from '@shared/xtream/channelNames';
import { foldText } from '@shared/xtream/guideSearch';

/**
 * The desktop's catalogue, kept in IndexedDB.
 *
 * What MemoryCatalogueStore should have been. A catalogue that lasts only as
 * long as the window sounded like a shrug -- "one request per category per
 * launch" -- and was not, because of the one thing that is not per category:
 * the whole-library index behind search. Its freshness mark went with the
 * window, so every launch the first search rebuilt the index, and a user
 * watched "Getting every film for search -- once a day…" once a day became
 * once a session. Nothing was wrong with the rule; there was nowhere to
 * remember that it had been kept.
 *
 * IndexedDB wants nothing installed -- unlike SQLite on Electron, which needs a
 * native module rebuilt against its ABI -- and the quota runs to hundreds of
 * megabytes, where a slimmed library is a few.
 *
 * Rows are kept per category, so indexing writes a few hundred small records
 * rather than one enormous one. A mirror of them is held in memory and read
 * from for searching, which keeps search exactly as quick as it was and is no
 * more memory than the memory store used after an index anyway.
 */

const DATABASE = 'iptv-catalogue';
const VERSION = 1;

const CATEGORIES = 'categories';
const STREAMS = 'streams';
const MARKS = 'marks';

interface CategoriesRow {
  provider: string;
  type: StreamType;
  categories: Category[];
}

interface StreamsRow {
  provider: string;
  type: StreamType;
  categoryId: string;
  streams: Stream[];
}

interface MarkRow {
  provider: string;
  type: StreamType;
  categoryId: string;
  at: string;
}

const done = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * A transaction as a promise, resolved when it commits.
 *
 * A request can succeed and the transaction abort afterwards; reporting an
 * index as filed when nothing reached the disk is exactly the failure this
 * store exists to prevent.
 */
const committed = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('The catalogue transaction was abandoned'));
  });

/**
 * Every key belonging to one subscription.
 *
 * IndexedDB sorts arrays after every other kind of key, so `[provider, []]`
 * sits above `[provider, anything, anything]` and the range covers the
 * subscription exactly -- which is what lets a change of line be forgotten in
 * one delete rather than a cursor walking the library.
 */
const wholeProvider = (provider: string): IDBKeyRange =>
  IDBKeyRange.bound([provider], [provider, []]);

const openCatalogueDatabase = (name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name, VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(CATEGORIES)) {
        database.createObjectStore(CATEGORIES, { keyPath: ['provider', 'type'] });
      }
      if (!database.objectStoreNames.contains(STREAMS)) {
        database.createObjectStore(STREAMS, { keyPath: ['provider', 'type', 'categoryId'] });
      }
      if (!database.objectStoreNames.contains(MARKS)) {
        // Apart from the rows they describe, so an index cut short leaves rows
        // behind without a mark saying the library was filed.
        database.createObjectStore(MARKS, { keyPath: ['provider', 'type', 'categoryId'] });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export class IndexedDbCatalogueStore implements CatalogueStore {
  private database: IDBDatabase | null = null;

  /** The mirror searched and read from; the database is what makes it survive. */
  private readonly categories = new Map<StreamType, Category[]>();
  private readonly streams = new Map<string, Stream[]>();
  private readonly marks = new Map<string, string>();

  constructor(
    /** Which subscription these rows belong to: two lines number films differently. */
    private readonly provider: string,
    private readonly databaseName = DATABASE
  ) {}

  /** Opens the database and reads this subscription's rows into memory. */
  async initialise(): Promise<void> {
    this.database = await openCatalogueDatabase(this.databaseName);

    const transaction = this.database.transaction([CATEGORIES, STREAMS, MARKS], 'readonly');
    const [categories, streams, marks] = await Promise.all([
      done(transaction.objectStore(CATEGORIES).getAll(wholeProvider(this.provider))),
      done(transaction.objectStore(STREAMS).getAll(wholeProvider(this.provider))),
      done(transaction.objectStore(MARKS).getAll(wholeProvider(this.provider)))
    ]);

    for (const row of categories as CategoriesRow[]) {
      this.categories.set(row.type, row.categories ?? []);
    }
    for (const row of streams as StreamsRow[]) {
      this.streams.set(this.key(row.type, row.categoryId), row.streams ?? []);
    }
    for (const row of marks as MarkRow[]) {
      this.marks.set(this.key(row.type, row.categoryId), row.at);
    }
  }

  async readCategories(type: StreamType): Promise<Category[]> {
    return this.categories.get(type) ?? [];
  }

  async writeCategories(type: StreamType, categories: Category[]): Promise<void> {
    this.categories.set(type, categories);
    await this.put<CategoriesRow>(CATEGORIES, { provider: this.provider, type, categories });
  }

  async readStreams(type: StreamType, categoryId: string): Promise<Stream[]> {
    return this.streams.get(this.key(type, categoryId)) ?? [];
  }

  async writeStreams(type: StreamType, categoryId: string, streams: Stream[]): Promise<void> {
    this.streams.set(this.key(type, categoryId), streams);
    await this.put<StreamsRow>(STREAMS, { provider: this.provider, type, categoryId, streams });
  }

  async lastFetchedAt(type: StreamType, categoryId: string): Promise<string | null> {
    return this.marks.get(this.key(type, categoryId)) ?? null;
  }

  async markFetched(type: StreamType, categoryId: string, at: string): Promise<void> {
    this.marks.set(this.key(type, categoryId), at);
    await this.put<MarkRow>(MARKS, { provider: this.provider, type, categoryId, at });
  }

  /** Any of the words (Catalogue.findTitles). */
  async findStreamsWithAny(type: StreamType, words: string[], limit: number): Promise<Stream[]> {
    const found: Stream[] = [];
    for (const [key, streams] of this.streams) {
      if (!key.startsWith(`${type}:`)) {
        continue;
      }
      for (const stream of streams) {
        const name = (stream.name ?? '').toLowerCase();
        if (words.some(word => name.includes(word))) {
          found.push(stream);
          if (found.length >= limit) {
            return found;
          }
        }
      }
    }
    return found;
  }

  /** The coarse filter the interface asks for, over the mirror. */
  async findStreams(type: StreamType, words: string[], limit: number, joined = false): Promise<Stream[]> {
    const found: Stream[] = [];

    for (const [key, streams] of this.streams) {
      if (!key.startsWith(`${type}:`)) {
        continue;
      }
      for (const stream of streams) {
        const name = joined ? searchable(foldText(stream.name ?? '')) : foldText(stream.name ?? '');
        if (words.every(word => name.includes(word))) {
          found.push(stream);
          if (found.length >= limit) {
            return found;
          }
        }
      }
    }

    return found;
  }

  async allStreams(type: StreamType): Promise<Stream[]> {
    const all: Stream[] = [];
    for (const [key, streams] of this.streams) {
      if (key.startsWith(`${type}:`)) {
        const categoryId = key.slice(type.length + 1);
        all.push(...streams.map(stream => ({ ...stream, category_id: stream.category_id ?? categoryId })));
      }
    }
    return all;
  }

  async recentlyAdded(type: StreamType, limit: number): Promise<Stream[]> {
    const all: Stream[] = [];

    for (const [key, streams] of this.streams) {
      if (!key.startsWith(`${type}:`)) {
        continue;
      }
      const categoryId = key.slice(type.length + 1);
      for (const stream of streams) {
        all.push({ ...stream, category_id: categoryId } as Stream);
      }
    }

    return all
      .filter(stream => Number(stream.added) > 0)
      .sort((a, b) => Number(b.added) - Number(a.added))
      .slice(0, limit);
  }

  /** Forgets this subscription entirely, for a sign-out or a changed line. */
  async clear(): Promise<void> {
    this.categories.clear();
    this.streams.clear();
    this.marks.clear();

    const database = this.database;
    if (!database) {
      return;
    }

    const transaction = database.transaction([CATEGORIES, STREAMS, MARKS], 'readwrite');
    for (const name of [CATEGORIES, STREAMS, MARKS]) {
      transaction.objectStore(name).delete(wholeProvider(this.provider));
    }
    await committed(transaction);
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  /**
   * One row written, with the mirror already updated.
   *
   * A write that fails is left in memory rather than undone: the catalogue is
   * a cache, and a session that works but forgets on exit is what this store
   * replaced -- not a reason to fail the browsing that is happening now.
   */
  private async put<T>(store: string, row: T): Promise<void> {
    const database = this.database;
    if (!database) {
      return;
    }

    try {
      const transaction = database.transaction(store, 'readwrite');
      transaction.objectStore(store).put(row);
      await committed(transaction);
    } catch {
      // Kept in memory for this session; the next write may well succeed.
    }
  }

  private key(type: StreamType, categoryId: string): string {
    return `${type}:${categoryId}`;
  }
}
