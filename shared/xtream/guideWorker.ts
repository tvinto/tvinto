import { GuideChannel, GuideParser, GuideProgramme, parseGuide } from './guide';
import { fetchedBytes } from './fetchedBytes';

/**
 * Reading a guide on a thread of its own.
 *
 * A guide is tens of megabytes of XML, and reading it on the page's own
 * thread had a television answering its remote late for as long as a reload
 * took -- once a day per guide, from shortly after the app opened. So the
 * reading moves to a worker; the page keeps what only it can do: getting the
 * bytes (on Android through the native bridge, which only the page has) and
 * writing the batches to the device's store.
 *
 * Backpressure both ways, as when it all ran in one place: the worker asks
 * for each chunk of bytes when it wants one, and waits for each batch to be
 * written before reading on. Neither side ever holds more than a piece.
 *
 * On an APK that says where its download is, the worker fetches the file
 * itself through the WebView's local file address, and nothing of the guide
 * crosses the bridge (as libraryWorker.ts does for a library). Otherwise, or
 * where that fetch fails, the page hands the bytes over as above.
 *
 * Plain functions over a port, so the conversation can be tested in Node.
 */

/** From the page to the worker. */
export type ToGuideWorker =
  /** With `url`, the worker fetches the guide itself; without, it asks for chunks. */
  | { type: 'start'; batchSize?: number; maxChars?: number; url?: string }
  | { type: 'chunk'; bytes: Uint8Array }
  | { type: 'end' }
  | { type: 'written' };

/** From the worker to the page. */
export type FromGuideWorker =
  | { type: 'pull' }
  | { type: 'channels'; batch: GuideChannel[]; chars: number }
  | { type: 'programmes'; batch: GuideProgramme[]; chars: number }
  | { type: 'done'; dropped: number; chars: number }
  | { type: 'failed'; message: string }
  /** The file at `url` could not be fetched: nothing was read or written. */
  | { type: 'unreadable'; message: string };

/** What a worker's global scope offers, as far as this needs. */
export interface GuideWorkerScope {
  postMessage(message: FromGuideWorker): void;
  onmessage: ((event: { data: ToGuideWorker }) => void) | null;
}

/** What the page holds of a worker, as far as this needs. */
export interface GuideWorkerHandle {
  postMessage(message: ToGuideWorker, transfer?: ArrayBuffer[]): void;
  onmessage: ((event: { data: FromGuideWorker }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

/** The worker could not fetch the file it was pointed at; the page reads it over the bridge instead. */
export class GuideFileUnreadable extends Error {
  constructor(reason: string) {
    super(`The guide file could not be fetched: ${reason}`);
    this.name = 'GuideFileUnreadable';
  }
}

/**
 * The worker could not be started at all -- a WebView without workers, a
 * script that would not load -- before it read a byte. The caller reads the
 * guide itself instead, from the same untouched bytes.
 */
export class GuideWorkerUnavailable extends Error {
  constructor(reason: string) {
    super(`The guide reader could not start: ${reason}`);
    this.name = 'GuideWorkerUnavailable';
  }
}

/** The worker's side: answers one `start` with one guide read. */
export function serveGuideParse(
  scope: GuideWorkerScope,
  parse: GuideParser = parseGuide,
  fetchFile: (url: string) => Promise<Response> = url => fetch(url)
): void {
  const inbox: ToGuideWorker[] = [];
  const waiting: ((message: ToGuideWorker) => void)[] = [];
  const next = (): Promise<ToGuideWorker> =>
    inbox.length ? Promise.resolve(inbox.shift()!) : new Promise(resolve => waiting.push(resolve));

  scope.onmessage = event => {
    const waiter = waiting.shift();
    if (waiter) {
      waiter(event.data);
    } else {
      inbox.push(event.data);
    }
  };

  const expect = async <T extends ToGuideWorker['type']>(...types: T[]): Promise<Extract<ToGuideWorker, { type: T }>> => {
    const message = await next();
    if (!types.includes(message.type as T)) {
      throw new Error(`The guide reader was sent ${message.type} where it expected ${types.join(' or ')}`);
    }
    return message as Extract<ToGuideWorker, { type: T }>;
  };

  void (async () => {
    const start = await expect('start');
    let chars = 0;
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
    try {
      const { dropped } = await parse(
        bytes,
        {
          channels: async batch => {
            scope.postMessage({ type: 'channels', batch, chars });
            await expect('written');
          },
          programmes: async batch => {
            scope.postMessage({ type: 'programmes', batch, chars });
            await expect('written');
          }
        },
        { batchSize: start.batchSize, maxChars: start.maxChars, onChars: total => (chars = total) }
      );
      scope.postMessage({ type: 'done', dropped, chars });
    } catch (error) {
      scope.postMessage({ type: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  })();
}

/**
 * The page's side: a `GuideParser` that has a worker do the reading. The
 * bytes are handed over as the worker asks, each one moved rather than
 * copied where it owns its whole buffer; the batches come back to the sink
 * one at a time, the next not asked for until the last is written.
 */
export function workerGuideParser(create: () => GuideWorkerHandle, url?: string): GuideParser {
  return async (bytes, sink, options = {}) => {
    let worker: GuideWorkerHandle;
    try {
      worker = create();
    } catch (error) {
      throw new GuideWorkerUnavailable(error instanceof Error ? error.message : String(error));
    }
    // Not asked for at all when the worker fetches the file itself: the
    // download stays where it is, for a fallback to read.
    let iterator: AsyncIterator<Uint8Array> | null = null;

    try {
      return await new Promise<{ dropped: number }>((resolve, reject) => {
        let started = false;
        let settled = false;
        const fail = (error: unknown) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        };

        const handle = async (message: FromGuideWorker): Promise<void> => {
          started = true;
          switch (message.type) {
            case 'pull': {
              iterator ??= bytes[Symbol.asyncIterator]();
              const next = await iterator.next();
              if (next.done) {
                worker.postMessage({ type: 'end' });
              } else {
                // A copy, moved rather than copied again: moving the piece
                // itself empties it under whoever made it, and Android's
                // reader looked at the length of what it had just handed
                // over to decide whether that was the last -- found zero, and
                // ended a 68 MB guide after its first half megabyte, as a
                // guide that had loaded (10 October).
                const sent = next.value.slice();
                worker.postMessage({ type: 'chunk', bytes: sent }, [sent.buffer as ArrayBuffer]);
              }
              return;
            }
            case 'channels':
              options.onChars?.(message.chars);
              await sink.channels(message.batch);
              worker.postMessage({ type: 'written' });
              return;
            case 'programmes':
              options.onChars?.(message.chars);
              await sink.programmes(message.batch);
              worker.postMessage({ type: 'written' });
              return;
            case 'done':
              options.onChars?.(message.chars);
              settled = true;
              resolve({ dropped: message.dropped });
              return;
            case 'failed':
              fail(new Error(message.message));
              return;
            case 'unreadable':
              fail(new GuideFileUnreadable(message.message));
              return;
          }
        };

        // One message at a time, in order: a batch is written before the
        // next pull is answered, as when it all ran in one place.
        let chain = Promise.resolve();
        worker.onmessage = event => {
          chain = chain.then(() => handle(event.data)).catch(fail);
        };
        worker.onerror = event => {
          const reason = event.message || 'the worker stopped';
          fail(started ? new Error(`The guide reader stopped: ${reason}`) : new GuideWorkerUnavailable(reason));
        };

        worker.postMessage({ type: 'start', batchSize: options.batchSize, maxChars: options.maxChars, url });
      });
    } finally {
      worker.terminate();
    }
  };
}
