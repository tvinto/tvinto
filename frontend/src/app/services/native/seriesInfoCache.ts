import { SeriesInfo } from '@shared/types';

const DATABASE = 'xtream-series-info';
const SHOWS = 'shows';

/** Shows kept: the ones somebody is watching, not the library. */
const KEEP = 40;

interface Kept {
  key: string;
  info: SeriesInfo;
  at: number;
}

/**
 * The last answer the provider gave for each show opened here, so its page
 * opens with its seasons at once and asks the provider behind them.
 *
 * The Xtream protocol has one request for a show and it returns every season:
 * Supernatural's took more than 30 s on a user's TV, on every visit (21
 * October), and there is no asking for one season instead. A cache, so losing
 * it costs one slow visit; IndexedDB rather than the catalogue's SQLite so the
 * desktop has it too.
 */
export class SeriesInfoCache {
  private opening: Promise<IDBDatabase | null> | null = null;

  async get(key: string): Promise<SeriesInfo | null> {
    const kept = await this.request<Kept | undefined>('readonly', store => store.get(key));
    return kept?.info ?? null;
  }

  async put(key: string, info: SeriesInfo): Promise<void> {
    await this.request('readwrite', store => store.put({ key, info, at: Date.now() } satisfies Kept));
    await this.prune();
  }

  /** The oldest let go past KEEP. */
  private async prune(): Promise<void> {
    const all = (await this.request<Kept[]>('readonly', store => store.getAll())) ?? [];
    const old = all.sort((a, b) => b.at - a.at).slice(KEEP);
    for (const one of old) {
      await this.request('readwrite', store => store.delete(one.key));
    }
  }

  private async request<T>(mode: IDBTransactionMode, ask: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
    const database = await this.open();
    if (!database) {
      return null;
    }
    return new Promise(resolve => {
      try {
        const asked = ask(database.transaction(SHOWS, mode).objectStore(SHOWS));
        asked.onsuccess = () => resolve(asked.result as T);
        asked.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private open(): Promise<IDBDatabase | null> {
    this.opening ??= new Promise(resolve => {
      try {
        const opened = indexedDB.open(DATABASE, 1);
        opened.onupgradeneeded = () => opened.result.createObjectStore(SHOWS, { keyPath: 'key' });
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.opening;
  }
}
