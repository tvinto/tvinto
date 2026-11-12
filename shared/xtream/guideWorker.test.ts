import { GuideBatchSink, GuideChannel, GuideProgramme, parseGuide } from './guide';
import {
  FromGuideWorker,
  GuideFileUnreadable,
  GuideWorkerHandle,
  GuideWorkerScope,
  GuideWorkerUnavailable,
  ToGuideWorker,
  serveGuideParse,
  workerGuideParser
} from './guideWorker';

/**
 * The page and the guide worker, joined in one process: messages arrive a
 * turn later and as copies, as they do between threads.
 */

const xml = (channels: number, perChannel: number): string => {
  let text = '<?xml version="1.0"?><tv>';
  for (let c = 1; c <= channels; c++) {
    text += `<channel id="c${c}.test"><display-name>Channel ${c}</display-name></channel>`;
  }
  // One with no id, and one programme whose times do not read: both dropped.
  text += '<channel><display-name>Nameless</display-name></channel>';
  for (let c = 1; c <= channels; c++) {
    for (let p = 0; p < perChannel; p++) {
      const hour = String(p).padStart(2, '0');
      text += `<programme start="20261010${hour}0000 +0000" stop="20261010${hour}3000 +0000" channel="c${c}.test"><title>Show ${p}</title></programme>`;
    }
  }
  text += '<programme start="soon" stop="later" channel="c1.test"><title>Broken</title></programme>';
  return `${text}</tv>`;
};

/** The text as bytes, in pieces of a given size. */
async function* bytesOf(text: string, piece = 97): AsyncGenerator<Uint8Array> {
  const all = new TextEncoder().encode(text);
  for (let at = 0; at < all.length; at += piece) {
    yield all.slice(at, at + piece);
  }
}

/** Records what arrives, and how many writes were ever running at once. */
const recordingSink = (writeMs = 0) => {
  const channels: GuideChannel[] = [];
  const programmes: GuideProgramme[] = [];
  let running = 0;
  let mostAtOnce = 0;
  const write = async <T>(into: T[], batch: T[]) => {
    running++;
    mostAtOnce = Math.max(mostAtOnce, running);
    await new Promise(resolve => setTimeout(resolve, writeMs));
    into.push(...batch);
    running--;
  };
  const sink: GuideBatchSink = {
    channels: batch => write(channels, batch),
    programmes: batch => write(programmes, batch)
  };
  return { sink, channels, programmes, mostAtOnce: () => mostAtOnce };
};

/** A worker and its page, joined: each side's messages reach the other a turn later, cloned. */
const joined = (parse = parseGuide, fetchFile?: (url: string) => Promise<Response>) => {
  const terminated = { value: false };
  const scope: GuideWorkerScope = {
    onmessage: null,
    postMessage: (message: FromGuideWorker) =>
      setImmediate(() => !terminated.value && handle.onmessage?.({ data: structuredClone(message) }))
  };
  const handle: GuideWorkerHandle = {
    onmessage: null,
    onerror: null,
    // Moved as a real worker moves it: what is transferred is emptied here.
    postMessage: (message: ToGuideWorker, transfer?: ArrayBuffer[]) => {
      const sent = structuredClone(message, { transfer });
      setImmediate(() => !terminated.value && scope.onmessage?.({ data: sent }));
    },
    terminate: () => (terminated.value = true)
  };
  serveGuideParse(scope, parse, fetchFile);
  return { handle, terminated };
};

describe('reading a guide in a worker', () => {
  it('hands the page the same channels and programmes as reading it here', async () => {
    const text = xml(7, 9);
    const here = recordingSink();
    const there = recordingSink();
    const { handle } = joined();

    const local = await parseGuide(bytesOf(text), here.sink, { batchSize: 10 });
    const remote = await workerGuideParser(() => handle)(bytesOf(text), there.sink, { batchSize: 10 });

    expect(remote).toEqual(local);
    expect(remote.dropped).toBe(2);
    expect(there.channels).toEqual(here.channels);
    expect(there.programmes).toEqual(here.programmes);
    expect(there.programmes).toHaveLength(63);
  });

  it('leaves the pieces it is given whole, for a source that looks at them after', async () => {
    // Android's reader decided a piece was the last by its length after
    // handing it over; moved to the worker, it read zero and stopped a 68 MB
    // guide after its first half megabyte (10 October).
    async function* lookingAfter(text: string): AsyncGenerator<Uint8Array> {
      const all = new TextEncoder().encode(text);
      for (let at = 0; ; at += 97) {
        const piece = all.slice(at, at + 97);
        if (piece.length) {
          yield piece;
        }
        if (!piece.length) {
          return;
        }
      }
    }
    const there = recordingSink();
    const { handle } = joined();

    await workerGuideParser(() => handle)(lookingAfter(xml(6, 6)), there.sink);

    expect(there.programmes).toHaveLength(36);
  });

  it('never has more than one batch being written at a time', async () => {
    const there = recordingSink(5);
    const { handle } = joined();

    await workerGuideParser(() => handle)(bytesOf(xml(5, 8)), there.sink, { batchSize: 4 });

    expect(there.programmes).toHaveLength(40);
    expect(there.mostAtOnce()).toBe(1);
  });

  it('says how far it has read', async () => {
    const seen: number[] = [];
    const { handle } = joined();

    await workerGuideParser(() => handle)(bytesOf(xml(3, 3)), recordingSink().sink, {
      onChars: chars => seen.push(chars)
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(xml(3, 3).length);
  });

  it('fails the read when the worker cannot read the guide, and stops the worker', async () => {
    const { handle, terminated } = joined();

    const read = workerGuideParser(() => handle)(bytesOf(xml(5, 5)), recordingSink().sink, { maxChars: 100 });

    await expect(read).rejects.toThrow();
    await expect(read).rejects.not.toBeInstanceOf(GuideWorkerUnavailable);
    expect(terminated.value).toBe(true);
  });

  describe('a worker that cannot start', () => {
    it('says so when it cannot be made, without touching the bytes', async () => {
      let touched = false;
      const bytes = (async function* () {
        touched = true;
        yield new Uint8Array([60]);
      })();

      const read = workerGuideParser(() => {
        throw new Error('no workers here');
      })(bytes, recordingSink().sink);

      await expect(read).rejects.toBeInstanceOf(GuideWorkerUnavailable);
      expect(touched).toBe(false);
    });

    it('says so when its script will not load, before it reads a byte', async () => {
      let touched = false;
      const bytes = (async function* () {
        touched = true;
        yield new Uint8Array([60]);
      })();
      const handle: GuideWorkerHandle = {
        onmessage: null,
        onerror: null,
        postMessage: () => setImmediate(() => handle.onerror?.({ message: 'script failed to load' })),
        terminate: () => undefined
      };

      await expect(workerGuideParser(() => handle)(bytes, recordingSink().sink)).rejects.toBeInstanceOf(GuideWorkerUnavailable);
      expect(touched).toBe(false);
    });
  });
});

describe('the guide worker reading the downloaded file itself', () => {
  it('reads the file at the address it is given, the same as from bytes, without asking for any', async () => {
    const text = xml(5, 8);
    const asked: string[] = [];
    const { handle } = joined(parseGuide, async url => {
      asked.push(url);
      return new Response(text);
    });
    let pulled = 0;
    const untouched = (async function* () {
      pulled++;
      yield new Uint8Array();
    })();
    const here = recordingSink();
    const there = recordingSink();

    const local = await parseGuide(bytesOf(text), here.sink, { batchSize: 10 });
    const remote = await workerGuideParser(() => handle, 'http://localhost/_capacitor_file_/cache/g')(untouched, there.sink, { batchSize: 10 });

    expect(asked).toEqual(['http://localhost/_capacitor_file_/cache/g']);
    expect(pulled).toBe(0);
    expect(remote).toEqual(local);
    expect(there.programmes).toEqual(here.programmes);
  });

  it('says the file is unreadable, having written nothing, when it cannot be fetched', async () => {
    const { handle } = joined(parseGuide, async () => new Response('', { status: 404 }));
    const there = recordingSink();

    await expect(workerGuideParser(() => handle, 'http://localhost/g')(bytesOf(xml(2, 2)), there.sink)).rejects.toBeInstanceOf(GuideFileUnreadable);
    expect(there.channels).toHaveLength(0);
    expect(there.programmes).toHaveLength(0);
  });
});
