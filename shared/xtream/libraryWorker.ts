import { Stream, StreamType } from '../types';
import { jsonArrayObjects } from './jsonArrayStream';
import { slimStreams } from './catalogue';
import { fetchedBytes } from './fetchedBytes';

/**
 * Reading a whole-library listing on a thread of its own.
 *
 * A library is one JSON array of every title a provider has: 196,451 films
 * on a user's, 99.5 MB. Read on the page, it took the remote from a 54 ms
 * median to 108 ms on the TV emulator at 4x, with a press over a second, and
 * held the whole library on the page until it was written. So the reading
 * moves to a worker, as the guide's did; the page keeps what only it can do:
 * getting the bytes (through the native bridge on Android) and writing to the
 * device's store.
 *
 * The worker reads the whole listing, then hands it back one category at a
 * time, the next only once the last is written -- so the page never holds
 * more than a category, and the store sees the same writes as before.
 *
 * Two ways in. On an APK that says where its download is, the worker fetches
 * the file itself through the WebView's local file address, and nothing of it
 * crosses the bridge -- which, measured, was most of what was left on the
 * page: the Base64 of a hundred megabytes, decoded there, and the garbage it
 * left. Otherwise the page reads the file over the bridge and hands the
 * worker the bytes as it asks for them.
 *
 * Plain functions over a port, so the conversation can be tested in Node.
 */

/** A library read: its titles by category, and how many titles there were. */
export interface ReadLibrary {
  byCategory: Map<string, Stream[]>;
  count: number;
}

/**
 * A listing's titles, normalised, cut down to what the store keeps, and filed
 * by category. A title with no category is counted but has nowhere to go.
 */
export async function readLibrary(bytes: AsyncIterable<Uint8Array>, type: StreamType, batchSize = 500): Promise<ReadLibrary> {
  const byCategory = new Map<string, Stream[]>();
  let count = 0;
  let batch: Record<string, unknown>[] = [];
  const file = () => {
    for (const stream of slimStreams(batch, type)) {
      count++;
      const categoryId = (stream as unknown as Record<string, unknown>)['category_id'];
      if (categoryId === null || categoryId === undefined || categoryId === '') {
        continue;
      }
      const key = String(categoryId);
      const list = byCategory.get(key);
      if (list) {
        list.push(stream);
      } else {
        byCategory.set(key, [stream]);
      }
    }
    batch = [];
  };
  for await (const item of jsonArrayObjects(bytes)) {
    batch.push(item);
    if (batch.length >= batchSize) {
      file();
    }
  }
  file();
  return { byCategory, count };
}

/** Writes one category of a library to the store; the next is not handed over until it is done. */
export type FileCategory = (categoryId: string, streams: Stream[]) => Promise<void>;

/** Reads a listing and files it category by category. Returns how many titles it held. */
export type LibraryReader = (bytes: AsyncIterable<Uint8Array>, type: StreamType, file: FileCategory) => Promise<number>;

/** The same, on whatever thread calls it: where a worker cannot be started. */
export const readLibraryHere: LibraryReader = async (bytes, type, file) => {
  const { byCategory, count } = await readLibrary(bytes, type);
  for (const [categoryId, streams] of byCategory) {
    await file(categoryId, streams);
  }
  return count;
};

/** From the page to the worker. */
export type ToLibraryWorker =
  /** With `url`, the worker fetches the listing itself; without, it asks for chunks. */
  | { type: 'start'; streamType: StreamType; url?: string }
  | { type: 'chunk'; bytes: Uint8Array }
  | { type: 'end' }
  | { type: 'written' };

/** From the worker to the page. */
export type FromLibraryWorker =
  | { type: 'pull' }
  | { type: 'category'; categoryId: string; streams: Stream[] }
  | { type: 'done'; count: number }
  | { type: 'failed'; message: string }
  /** The file at `url` could not be fetched: nothing was read or filed. */
  | { type: 'unreadable'; message: string };

/** What a worker's global scope offers, as far as this needs. */
export interface LibraryWorkerScope {
  postMessage(message: FromLibraryWorker): void;
  onmessage: ((event: { data: ToLibraryWorker }) => void) | null;
}

/** What the page holds of a worker, as far as this needs. */
export interface LibraryWorkerHandle {
  postMessage(message: ToLibraryWorker, transfer?: ArrayBuffer[]): void;
  onmessage: ((event: { data: FromLibraryWorker }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

/** The worker could not fetch the file it was pointed at; the page reads it over the bridge instead. */
export class LibraryFileUnreadable extends Error {
  constructor(reason: string) {
    super(`The library file could not be fetched: ${reason}`);
    this.name = 'LibraryFileUnreadable';
  }
}

/** The worker could not be started at all, before it read a byte; the page reads the listing instead. */
export class LibraryWorkerUnavailable extends Error {
  constructor(reason: string) {
    super(`The library reader could not start: ${reason}`);
    this.name = 'LibraryWorkerUnavailable';
  }
}

/** The worker's side: answers one `start` with one library read. */
export function serveLibraryRead(
  scope: LibraryWorkerScope,
  fetchFile: (url: string) => Promise<Response> = url => fetch(url)
): void {
  const inbox: ToLibraryWorker[] = [];
  const waiting: ((message: ToLibraryWorker) => void)[] = [];
  const next = (): Promise<ToLibraryWorker> =>
    inbox.length ? Promise.resolve(inbox.shift()!) : new Promise(resolve => waiting.push(resolve));

  scope.onmessage = event => {
    const waiter = waiting.shift();
    if (waiter) {
      waiter(event.data);
    } else {
      inbox.push(event.data);
    }
  };

  const expect = async <T extends ToLibraryWorker['type']>(...types: T[]): Promise<Extract<ToLibraryWorker, { type: T }>> => {
    const message = await next();
    if (!types.includes(message.type as T)) {
      throw new Error(`The library reader was sent ${message.type} where it expected ${types.join(' or ')}`);
    }
    return message as Extract<ToLibraryWorker, { type: T }>;
  };

  void (async () => {
    try {
      const start = await expect('start');
      let fetched: Response | null = null;
      if (start.url) {
        try {
          fetched = await fetchFile(start.url);
          if (!fetched.ok) {
            throw new Error(`answered ${fetched.status}`);
          }
        } catch (error) {
          scope.postMessage({ type: 'unreadable', message: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
      const bytes = fetched ? fetchedBytes(fetched) : (async function* () {
        for (;;) {
          scope.postMessage({ type: 'pull' });
          const message = await expect('chunk', 'end');
          if (message.type === 'end') {
            return;
          }
          yield message.bytes;
        }
      })();
      const { byCategory, count } = await readLibrary(bytes, start.streamType);
      for (const [categoryId, streams] of byCategory) {
        // Let go of each as it is handed over: the worker need not hold the
        // library after the page has it.
        byCategory.delete(categoryId);
        scope.postMessage({ type: 'category', categoryId, streams });
        await expect('written');
      }
      scope.postMessage({ type: 'done', count });
    } catch (error) {
      scope.postMessage({ type: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  })();
}

/**
 * The page's side: a `LibraryReader` that has a worker do the reading. Bytes
 * go over as the worker asks for them, moved rather than copied again; the
 * categories come back one at a time, each written before the next.
 */
export function workerLibraryReader(create: () => LibraryWorkerHandle): LibraryReader {
  return (bytes, type, file) => converse(create, { type: 'start', streamType: type }, bytes, file);
}

/**
 * The same, with the worker fetching the downloaded file at `url` itself.
 * Throws `LibraryFileUnreadable` when it cannot, before anything is filed.
 */
export function workerLibraryFileReader(
  create: () => LibraryWorkerHandle
): (url: string, type: StreamType, file: FileCategory) => Promise<number> {
  return (url, type, file) => converse(create, { type: 'start', streamType: type, url }, null, file);
}

async function converse(
  create: () => LibraryWorkerHandle,
  start: Extract<ToLibraryWorker, { type: 'start' }>,
  bytes: AsyncIterable<Uint8Array> | null,
  file: FileCategory
): Promise<number> {
  let worker: LibraryWorkerHandle;
  try {
    worker = create();
  } catch (error) {
    throw new LibraryWorkerUnavailable(error instanceof Error ? error.message : String(error));
  }
  const iterator = bytes?.[Symbol.asyncIterator]();

  try {
    return await new Promise<number>((resolve, reject) => {
      let started = false;
      let settled = false;
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      const handle = async (message: FromLibraryWorker): Promise<void> => {
        started = true;
        switch (message.type) {
          case 'pull': {
            if (!iterator) {
              fail(new Error('The library reader asked for bytes it was to fetch itself'));
              return;
            }
            const next = await iterator.next();
            if (next.done) {
              worker.postMessage({ type: 'end' });
            } else {
              // A copy, moved: moving the piece itself empties it under the
              // reader that made it, which then judges the end by its length
              // (the guide worker, 10 October).
              const sent = next.value.slice();
              worker.postMessage({ type: 'chunk', bytes: sent }, [sent.buffer as ArrayBuffer]);
            }
            return;
          }
          case 'category':
            await file(message.categoryId, message.streams);
            worker.postMessage({ type: 'written' });
            return;
          case 'done':
            settled = true;
            resolve(message.count);
            return;
          case 'failed':
            fail(new Error(message.message));
            return;
          case 'unreadable':
            fail(new LibraryFileUnreadable(message.message));
            return;
        }
      };

      // One message at a time, in order: a category is written before the
      // next is answered.
      let chain = Promise.resolve();
      worker.onmessage = event => {
        chain = chain.then(() => handle(event.data)).catch(fail);
      };
      worker.onerror = event => {
        const reason = event.message || 'the worker stopped';
        fail(started ? new Error(`The library reader stopped: ${reason}`) : new LibraryWorkerUnavailable(reason));
      };

      worker.postMessage(start);
    });
  } finally {
    worker.terminate();
  }
}
