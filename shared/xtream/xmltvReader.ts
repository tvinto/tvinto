import { XmltvChannel, XmltvProgramme, parseXmltv } from './xmltv';

/**
 * Reading a guide without holding it all at once.
 *
 * `parseXmltv` takes a whole document and builds a whole tree, which is fine
 * on a server and not fine on a phone: a forty megabyte guide becomes several
 * hundred megabytes of objects, on a device that may have a gigabyte in total.
 *
 * This reads the same documents a piece at a time. Text arrives in chunks --
 * from a stream on the desktop, in one go on Android, where the request has to
 * be made by the platform underneath and comes back whole -- and complete
 * `<channel>` and `<programme>` elements are handed on in batches as they are
 * found. What is held is one batch and whatever partial element is in flight,
 * not the guide.
 *
 * The elements themselves are parsed by `parseXmltv`, one small document at a
 * time, so a programme read this way and a programme read from a whole file
 * cannot disagree about what it says.
 */

export interface GuideSink {
  channels(batch: XmltvChannel[]): void | Promise<void>;
  programmes(batch: XmltvProgramme[]): void | Promise<void>;
}

export interface ReadXmltvOptions {
  /**
   * How many elements to parse at once.
   *
   * One at a time would mean a parser invocation per programme, which for a
   * hundred thousand of them is the dominant cost. A batch amortises that
   * while keeping what is held bounded.
   */
  batchSize?: number;

  /**
   * The most unparsed text to hold before giving up, in characters.
   *
   * A guard against a document that is not XMLTV at all, or one truncated
   * mid-element: without it, a response that never closes an element would be
   * accumulated until the device ran out of memory. Twenty megabytes is far
   * more than any single element can legitimately need.
   */
  maxPendingChars?: number;
}

export interface GuideTotals {
  channels: number;
  programmes: number;
}

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_PENDING = 20 * 1024 * 1024;

/** The elements worth extracting, and nothing else. */
const ELEMENTS = ['channel', 'programme'] as const;
type ElementName = (typeof ELEMENTS)[number];

interface FoundElement {
  name: ElementName;
  text: string;
  end: number;
}

/**
 * Finds the end of a start tag, respecting quoted attribute values.
 *
 * `>` is legal inside an attribute value in XML, so scanning for the first one
 * would cut a tag in half. Rare in practice and silent when it happens, which
 * is the worst combination.
 *
 * Returns -1 when the tag is not yet complete.
 */
const endOfStartTag = (text: string, from: number): number => {
  let quote: string | null = null;

  for (let index = from; index < text.length; index += 1) {
    const character = text[index];

    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '>') {
      return index;
    }
  }

  return -1;
};

/**
 * Finds a closing tag, stepping over any CDATA on the way.
 *
 * A CDATA section may contain anything at all, `</programme>` included, and
 * descriptions arrive wrapped in CDATA often enough that ignoring this would
 * truncate real guides. Returns -1 when the close has not arrived yet.
 */
const findClose = (text: string, from: number, name: string): number => {
  const close = `</${name}`;
  let index = from;

  while (index < text.length) {
    const cdata = text.indexOf('<![CDATA[', index);
    const candidate = text.indexOf(close, index);

    if (candidate === -1) {
      return -1;
    }

    if (cdata !== -1 && cdata < candidate) {
      const cdataEnd = text.indexOf(']]>', cdata);
      if (cdataEnd === -1) {
        // The section is still arriving; nothing after it can be trusted yet.
        return -1;
      }
      index = cdataEnd + 3;
      continue;
    }

    const tagEnd = text.indexOf('>', candidate);
    return tagEnd === -1 ? -1 : tagEnd + 1;
  }

  return -1;
};

/** Whether what follows the element name actually ends it. */
const isNameBoundary = (character: string | undefined): boolean =>
  character === undefined || character === ' ' || character === '\t' ||
  character === '\n' || character === '\r' || character === '>' || character === '/';

/**
 * Pulls the next complete element out of the buffer, or null if none is ready.
 */
const nextElement = (buffer: string, from: number): FoundElement | null => {
  let search = from;

  while (search < buffer.length) {
    const open = buffer.indexOf('<', search);
    if (open === -1) {
      return null;
    }

    const name = ELEMENTS.find(
      candidate =>
        buffer.startsWith(candidate, open + 1) &&
        isNameBoundary(buffer[open + 1 + candidate.length])
    );

    if (!name) {
      search = open + 1;
      continue;
    }

    const tagEnd = endOfStartTag(buffer, open);
    if (tagEnd === -1) {
      return null;
    }

    // `<programme ... />` carries everything in its attributes and has no close.
    if (buffer[tagEnd - 1] === '/') {
      return { name, text: buffer.slice(open, tagEnd + 1), end: tagEnd + 1 };
    }

    const closeEnd = findClose(buffer, tagEnd + 1, name);
    if (closeEnd === -1) {
      return null;
    }

    return { name, text: buffer.slice(open, closeEnd), end: closeEnd };
  }

  return null;
};

/**
 * Reads a guide from chunks of text, handing complete elements to the sink.
 *
 * Returns how many of each were found, which is the only thing worth keeping
 * once the sink has taken the rest.
 */
export const readXmltv = async (
  chunks: AsyncIterable<string>,
  sink: GuideSink,
  options: ReadXmltvOptions = {}
): Promise<GuideTotals> => {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxPending = options.maxPendingChars ?? DEFAULT_MAX_PENDING;

  let buffer = '';
  let channelBatch: string[] = [];
  let programmeBatch: string[] = [];
  const totals: GuideTotals = { channels: 0, programmes: 0 };

  /** Parses a batch of elements as one small document and hands it on. */
  const flush = async (name: ElementName) => {
    const batch = name === 'channel' ? channelBatch : programmeBatch;
    if (!batch.length) {
      return;
    }

    const guide = parseXmltv(`<tv>${batch.join('')}</tv>`);

    if (name === 'channel') {
      channelBatch = [];
      totals.channels += guide.channels.length;
      await sink.channels(guide.channels);
    } else {
      programmeBatch = [];
      totals.programmes += guide.programmes.length;
      await sink.programmes(guide.programmes);
    }
  };

  for await (const chunk of chunks) {
    buffer += chunk;

    let consumed = 0;
    for (;;) {
      const found = nextElement(buffer, consumed);
      if (!found) {
        break;
      }

      if (found.name === 'channel') {
        channelBatch.push(found.text);
        if (channelBatch.length >= batchSize) {
          await flush('channel');
        }
      } else {
        programmeBatch.push(found.text);
        if (programmeBatch.length >= batchSize) {
          await flush('programme');
        }
      }

      consumed = found.end;
    }

    // Keep only what is still unread. Without this the buffer is the document.
    buffer = consumed ? buffer.slice(consumed) : buffer;

    if (buffer.length > maxPending) {
      throw new Error(
        `Guide is not readable: ${buffer.length} characters without a complete element. ` +
          'The response is probably not XMLTV.'
      );
    }
  }

  await flush('channel');
  await flush('programme');

  return totals;
};

/**
 * Collects a whole guide, for callers small enough not to care.
 *
 * The reason to use the reader rather than `parseXmltv` even here is that the
 * document itself is never held as one string.
 */
export const collectXmltv = async (
  chunks: AsyncIterable<string>,
  options?: ReadXmltvOptions
): Promise<{ channels: XmltvChannel[]; programmes: XmltvProgramme[] }> => {
  const channels: XmltvChannel[] = [];
  const programmes: XmltvProgramme[] = [];

  await readXmltv(
    chunks,
    {
      channels: batch => {
        channels.push(...batch);
      },
      programmes: batch => {
        programmes.push(...batch);
      }
    },
    options
  );

  return { channels, programmes };
};
