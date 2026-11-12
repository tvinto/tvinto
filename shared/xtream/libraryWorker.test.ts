import { Stream } from '../types';
import {
  FromLibraryWorker,
  LibraryWorkerHandle,
  LibraryWorkerScope,
  LibraryFileUnreadable,
  LibraryWorkerUnavailable,
  ToLibraryWorker,
  readLibrary,
  readLibraryHere,
  serveLibraryRead,
  workerLibraryFileReader,
  workerLibraryReader
} from './libraryWorker';

/**
 * The page and the library worker, joined in one process: messages arrive a
 * turn later and as copies, as they do between threads.
 */

/** A film listing: `perCategory` titles in each of `categories`, and one with no category. */
const listing = (categories: number, perCategory: number): string => {
  const rows: Record<string, unknown>[] = [];
  for (let c = 1; c <= categories; c++) {
    for (let i = 0; i < perCategory; i++) {
      rows.push({ stream_id: c * 1000 + i, name: `Film ${c}-${i}`, category_id: String(c), plot: 'A synopsis nobody keeps', cast: 'Many' });
    }
  }
  rows.push({ stream_id: 1, name: 'Filed nowhere' });
  return JSON.stringify(rows);
};

/** The text as bytes, in pieces of a given size. */
async function* bytesOf(text: string, piece = 97): AsyncGenerator<Uint8Array> {
  const all = new TextEncoder().encode(text);
  for (let at = 0; at < all.length; at += piece) {
    yield all.slice(at, at + piece);
  }
}

/** A worker and its page, joined: each side's messages reach the other a turn later, cloned. */
const joined = (fetchFile?: (url: string) => Promise<Response>) => {
  const terminated = { value: false };
  const scope: LibraryWorkerScope = {
    onmessage: null,
    postMessage: (message: FromLibraryWorker) =>
      setImmediate(() => !terminated.value && handle.onmessage?.({ data: structuredClone(message) }))
  };
  const handle: LibraryWorkerHandle = {
    onmessage: null,
    onerror: null,
    postMessage: (message: ToLibraryWorker, transfer?: ArrayBuffer[]) => {
      const sent = structuredClone(message, { transfer });
      setImmediate(() => !terminated.value && scope.onmessage?.({ data: sent }));
    },
    terminate: () => (terminated.value = true)
  };
  serveLibraryRead(scope, fetchFile);
  return { handle, terminated };
};

/** Records what is filed, and how many writes were ever running at once. */
const recordingFile = () => {
  const filed = new Map<string, Stream[]>();
  let running = 0;
  let mostAtOnce = 0;
  const file = async (categoryId: string, streams: Stream[]) => {
    running++;
    mostAtOnce = Math.max(mostAtOnce, running);
    await new Promise(resolve => setTimeout(resolve, 2));
    filed.set(categoryId, streams);
    running--;
  };
  return { file, filed, mostAtOnce: () => mostAtOnce };
};

describe('reading a library listing', () => {
  it('files titles by category, counts them all, and keeps only what the store needs', async () => {
    const { byCategory, count } = await readLibrary(bytesOf(listing(3, 4)), 'vod', 5);

    expect(count).toBe(13);
    expect([...byCategory.keys()]).toEqual(['1', '2', '3']);
    expect(byCategory.get('2')).toHaveLength(4);
    const first = byCategory.get('1')![0] as unknown as Record<string, unknown>;
    expect(first['name']).toBe('Film 1-0');
    expect(first['plot']).toBeUndefined();
    expect(first['cast']).toBeUndefined();
  });
});

describe('the library worker', () => {
  it('reads in the worker and hands the library back a category at a time, each written before the next', async () => {
    const { handle, terminated } = joined();
    const { file, filed, mostAtOnce } = recordingFile();

    const count = await workerLibraryReader(() => handle)(bytesOf(listing(5, 30)), 'vod', file);

    expect(count).toBe(151);
    expect([...filed.keys()]).toEqual(['1', '2', '3', '4', '5']);
    expect(filed.get('5')).toHaveLength(30);
    expect(mostAtOnce()).toBe(1);
    expect(terminated.value).toBe(true);
  });

  it('files the same as reading on the page', async () => {
    const { handle } = joined();
    const inWorker = recordingFile();
    const onPage = recordingFile();

    await workerLibraryReader(() => handle)(bytesOf(listing(3, 7)), 'vod', inWorker.file);
    await readLibraryHere(bytesOf(listing(3, 7)), 'vod', onPage.file);

    expect([...inWorker.filed.entries()]).toEqual([...onPage.filed.entries()]);
  });

  it('says it is unavailable when the worker cannot be made, before reading a byte', async () => {
    let read = 0;
    const bytes = (async function* () {
      read++;
      yield new Uint8Array([0x5b, 0x5d]);
    })();

    const reading = workerLibraryReader(() => {
      throw new Error('no workers here');
    })(bytes, 'vod', async () => undefined);

    await expect(reading).rejects.toBeInstanceOf(LibraryWorkerUnavailable);
    expect(read).toBe(0);
  });

  it('passes on a listing that is not readable as the failure it is', async () => {
    const { handle } = joined();
    const reading = workerLibraryReader(() => handle)(bytesOf('[{"stream_id": 1, "name": '), 'vod', async () => undefined);

    // A truncated listing yields nothing rather than throwing; one that is
    // broken in the middle is the reader's error to pass on.
    await expect(reading).resolves.toBe(0);
    const { handle: second } = joined();
    await expect(
      workerLibraryReader(() => second)(bytesOf('[{"stream_id": 1, "name": }]'), 'vod', async () => undefined)
    ).rejects.toThrow();
  });
});

describe('the library worker reading the downloaded file itself', () => {
  it('fetches the file and files it as from bytes, with nothing passed over by the page', async () => {
    const asked: string[] = [];
    const { handle } = joined(async url => {
      asked.push(url);
      return new Response(listing(4, 6));
    });
    const { file, filed, mostAtOnce } = recordingFile();

    const count = await workerLibraryFileReader(() => handle)('http://localhost/_capacitor_file_/cache/x', 'vod', file);

    expect(asked).toEqual(['http://localhost/_capacitor_file_/cache/x']);
    expect(count).toBe(25);
    expect([...filed.keys()]).toEqual(['1', '2', '3', '4']);
    expect(mostAtOnce()).toBe(1);
  });

  it('says the file is unreadable, before filing anything, when it cannot be fetched', async () => {
    const { handle } = joined(async () => new Response('missing', { status: 404 }));
    const { file, filed } = recordingFile();

    await expect(workerLibraryFileReader(() => handle)('http://localhost/x', 'vod', file)).rejects.toBeInstanceOf(LibraryFileUnreadable);
    expect(filed.size).toBe(0);

    const { handle: second } = joined(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(workerLibraryFileReader(() => second)('http://localhost/x', 'vod', file)).rejects.toBeInstanceOf(LibraryFileUnreadable);
  });
});
