/**
 * Getting a guide from bytes to text, safely, a piece at a time.
 *
 * The half of fetching a guide that is the same everywhere and is where the
 * quiet bugs live. What differs by platform -- whether the request can be made
 * with `fetch` at all, or has to be handed to the platform underneath -- stays
 * with the caller, which supplies the bytes however it got them.
 *
 * Two things here are easy to get wrong and silent when wrong:
 *
 * A guide arrives gzipped as often as not, and `.gz` in the URL is only a
 * hint; some servers compress without saying so in the name and some say so
 * without doing it. Sniffing the first two bytes is the only reliable answer.
 *
 * And a UTF-8 character can be split across two byte chunks. Decoding each
 * chunk on its own turns that character into two wrong ones -- the same
 * failure as decoding Base64 without a TextDecoder, arriving by a different
 * route. `stream: true` is what carries the partial character across.
 */

export interface GuideBytesOptions {
  /**
   * The most decompressed text to accept, in characters. A guide that will not
   * fit should fail rather than take the device down with it.
   */
  maxChars?: number;

  /** Called with the running character count, for a progress indicator. */
  onProgress?: (chars: number) => void;
}

const DEFAULT_MAX_CHARS = 120 * 1024 * 1024;

/** gzip's magic number is two bytes, and is the only dependable signal. */
const GZIP_MAGIC_BYTES = 2;

const isGzip = (signature: Uint8Array): boolean =>
  signature.length >= GZIP_MAGIC_BYTES && signature[0] === 0x1f && signature[1] === 0x8b;

/**
 * Re-presents an async iterable of bytes as a ReadableStream.
 *
 * DecompressionStream only speaks streams, and the callers only have
 * iterables, so this is the adapter between them.
 */
const asStream = (chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> => {
  const iterator = chunks[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    }
  });
};

/** Reads a ReadableStream as an async iterable, which not every runtime does. */
const asIterable = async function* (
  stream: ReadableStream<Uint8Array>
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
};

/**
 * Turns guide bytes into text, decompressing when they are compressed.
 *
 * The result is meant to be handed straight to `readXmltv`, so that at no
 * point does the whole guide exist as a single string.
 */
export const guideTextFromBytes = async function* (
  byteChunks: AsyncIterable<Uint8Array>,
  options: GuideBytesOptions = {}
): AsyncIterable<string> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const iterator = byteChunks[Symbol.asyncIterator]();

  // Enough of the front to sniff, however small the pieces arrive in. A stream
  // is entitled to hand over one byte at a time, and deciding on the strength
  // of a first chunk that short would read every gzipped guide as text.
  const head: Uint8Array[] = [];
  let headBytes = 0;
  while (headBytes < GZIP_MAGIC_BYTES) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    head.push(next.value);
    headBytes += next.value.length;
  }

  if (!headBytes) {
    return;
  }

  const signature = new Uint8Array(GZIP_MAGIC_BYTES);
  let filled = 0;
  for (const chunk of head) {
    for (let index = 0; index < chunk.length && filled < GZIP_MAGIC_BYTES; index += 1) {
      signature[filled] = chunk[index];
      filled += 1;
    }
  }

  // Puts the chunks that were sniffed back in front of the rest.
  const rejoined = async function* (): AsyncIterable<Uint8Array> {
    yield* head;
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  };

  // The DOM types declare the compression streams as accepting BufferSource on
  // the writable side, which does not line up with a ReadableStream<Uint8Array>
  // even though a Uint8Array is one. Nothing but Uint8Array is ever written.
  const gunzip = new DecompressionStream('gzip') as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };

  const source = isGzip(signature.subarray(0, filled))
    ? asIterable(asStream(rejoined()).pipeThrough(gunzip))
    : rejoined();

  // One decoder across every chunk, so a character split between two of them
  // is reassembled rather than mangled.
  const decoder = new TextDecoder('utf-8');
  let total = 0;

  for await (const chunk of source) {
    const text = decoder.decode(chunk, { stream: true });
    if (!text) {
      continue;
    }

    total += text.length;
    if (total > maxChars) {
      throw new Error(`Guide is larger than ${maxChars} characters; refusing to load it`);
    }

    options.onProgress?.(total);
    yield text;
  }

  // Flushes anything the decoder was holding back.
  const tail = decoder.decode();
  if (tail) {
    yield tail;
  }
};
