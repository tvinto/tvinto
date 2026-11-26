import { XmltvChannel, XmltvProgramme } from './xmltv';
import { guideTextFromBytes } from './guideBytes';
import { readXmltv } from './xmltvReader';
import { parseXmltvTime } from './xmltvTime';

/**
 * Loading a guide into wherever this device keeps one.
 *
 * The counterpart to `Catalogue`: shared policy over a store each platform
 * implements for itself. What differs is the driver underneath -- SQLite on
 * the phone, memory on the desktop -- and how the bytes were obtained, which
 * the caller has already dealt with by the time it gets here.
 *
 * Times are turned into epoch milliseconds on the way in rather than on the
 * way out. The alternative is parsing `20260827180000 +0200` every time the
 * guide is drawn, for every programme on screen.
 */

/** A channel as the guide knows it, before any matching to a stream. */
export interface GuideChannel {
  id: string;
  name: string;
}

/**
 * A channel together with which source it came from.
 *
 * Only what reads across every source needs this. Once there is more than one
 * guide loaded, "Doma TV" is a name several of them have, and both choosing
 * between them and filtering by source need to know which is which.
 */
export interface KnownChannel extends GuideChannel {
  sourceId: string;
}

/**
 * One channel in one guide.
 *
 * The pair is the point. Two guides describing the same channel use the same
 * id for it, so asking for programmes by id alone returns both schedules and
 * draws them on top of each other. A stream is described by one guide, and
 * this is how that is said.
 */
export interface ChannelRef {
  sourceId: string;
  channelId: string;
}

/** A programme, with its times resolved. */
export interface GuideProgramme {
  channel: string;
  start: number;
  stop: number;
  title: string;
  description: string;
  category: string;
}

/** A programme found by its title, with the guide it came from. */
export interface GuideHit extends GuideProgramme {
  sourceId: string;
}

export interface GuideStore {
  /**
   * Starts a load of this source, **without** removing what it wrote last time.
   *
   * A guide is still replaced rather than merged -- the feed is the truth about
   * its own channels, and a withdrawn programme should disappear rather than
   * linger. But the replacing happens in `finishLoad`, once the new guide has
   * arrived whole, not here before a byte of it has.
   *
   * It used to clear the source here. Then a reload of the provider's guide was
   * cut off two minutes in, and a guide of six thousand channels that had been
   * working was simply gone: every id match and name match that leaned on it
   * went with it, and nothing had arrived to take its place. That was a manual
   * Reload's behaviour all along, and it would have become an unattended one
   * the moment guides started reloading themselves.
   *
   * A source that has never finished a load is still invisible until it does;
   * one being reloaded stays readable throughout.
   */
  beginLoad(sourceId: string): Promise<void>;

  writeChannels(sourceId: string, channels: GuideChannel[]): Promise<void>;
  writeProgrammes(sourceId: string, programmes: GuideProgramme[]): Promise<void>;

  /**
   * Records that the load finished, which is what makes it visible, and
   * removes whatever this source held from before the load began.
   */
  finishLoad(sourceId: string, at: string, totals?: GuideTotals): Promise<void>;

  /** When this source last loaded, or null if it never has on this device. */
  lastLoadedAt(sourceId: string): Promise<string | null>;

  /**
   * What the last load of this source brought in, or null.
   *
   * Kept so a screen can say what a guide holds without loading it again --
   * "213 channels, 24,536 programmes" is the difference between a source that
   * is working and one that is merely listed.
   */
  loadSummary(sourceId: string): Promise<GuideLoadSummary | null>;

  /**
   * When this source counts as running out -- a tenth of its channels with
   * nothing left (`whenRunningOut` in guideReload.ts) -- in epoch
   * milliseconds, or null if it holds no programmes or cannot say.
   *
   * What decides whether a guide needs reloading. The load time does not: a
   * feed covering a week loaded yesterday is fine, and one covering a day is
   * nearly empty. Nor does its last programme of all: one channel described
   * for a week kept a guide "fresh" while a tenth of its channels had run out.
   */
  runsOutAt(sourceId: string): Promise<number | null>;

  channels(sourceId: string): Promise<GuideChannel[]>;

  /**
   * Every channel this device has a guide for, across all loaded sources.
   *
   * What the matching needs. A stream carries the id its provider chose, and
   * finding which guide channel that refers to means having the guide's own
   * ids to compare against -- all of them, because a line-up is not divided
   * into sources the way the guide is.
   */
  allChannels(): Promise<KnownChannel[]>;

  /**
   * Programmes overlapping a window, for the channels asked about.
   *
   * Takes source and channel together, not channel alone. Two guides use the
   * same id for the same channel, so an id on its own asks both of them and
   * gets two schedules for one row.
   */
  programmesFor(refs: ChannelRef[], from: number, to: number): Promise<GuideProgramme[]>;

  /**
   * Programmes whose title holds the words, overlapping the window, in every
   * loaded source (guideSearch.ts says how titles match). Soonest first, at
   * most `limit`. For searching the guide by programme rather than channel.
   */
  searchProgrammes(query: string, from: number, to: number, limit: number): Promise<GuideHit[]>;

  /** Drops programmes that finished before the given moment. */
  prune(before: number): Promise<void>;
}

/** How much a source holds, kept so it can be shown without reloading. */
export interface GuideTotals {
  channels: number;
  programmes: number;
}

export interface GuideLoadSummary extends GuideTotals {
  loadedAt: string;
}

export interface GuideLoadReport {
  channels: number;
  programmes: number;
  /**
   * Programmes discarded because their times could not be read.
   *
   * Worth returning rather than swallowing. A feed that drops a handful is
   * normal; one that drops everything is broken in a way the person who added
   * it can actually act on, and without this it looks like an empty guide.
   */
  dropped: number;
  loadedAt: string;
}

export interface LoadGuideOptions {
  now?: () => Date;
  /** How many elements to parse and write at a time. */
  batchSize?: number;
  /** The most decompressed text to accept, in characters. */
  maxChars?: number;
  /** Progress as it arrives, for a device that wants to show something. */
  onProgress?: (progress: { channels: number; programmes: number; chars: number }) => void;
  /**
   * What turns the bytes into batches: `parseGuide` here, by default, or the
   * same work on a thread of its own (the app's guide worker), so a page
   * answering a remote is not also reading a guide.
   */
  parse?: GuideParser;
  /**
   * Programmes starting at or after this time (ms) are left out: a first
   * load keeps the next two days and the rest follows (card 42 -- writing a
   * whole guide took the owner's TV minutes).
   */
  until?: number;
}

/** A load that brought in no channels and no programmes: not a guide. */
export class EmptyGuide extends Error {
  constructor() {
    super('The address answered, but with no guide in it');
    this.name = 'EmptyGuide';
  }
}

/** Where parsed batches go: the store's writes, or back across to the page. */
export interface GuideBatchSink {
  channels(batch: GuideChannel[]): Promise<void>;
  programmes(batch: GuideProgramme[]): Promise<void>;
}

export interface ParseGuideOptions {
  /** How many elements to parse at a time. */
  batchSize?: number;
  /** The most decompressed text to accept, in characters. */
  maxChars?: number;
  /** The decompressed characters read so far, as they grow. */
  onChars?: (chars: number) => void;
}

/** Reads a guide's bytes into batches; says how many elements could not be used. */
export type GuideParser = (
  bytes: AsyncIterable<Uint8Array>,
  sink: GuideBatchSink,
  options?: ParseGuideOptions
) => Promise<{ dropped: number }>;

/**
 * Converts a parsed programme, or returns null when its times will not read.
 *
 * A programme that stops before it starts is as unusable as one with no times
 * at all, and appears in real feeds often enough to be worth naming.
 */
const withTimes = (programme: XmltvProgramme): GuideProgramme | null => {
  const start = parseXmltvTime(programme.start);
  const stop = parseXmltvTime(programme.stop);

  if (start === null || stop === null || stop <= start) {
    return null;
  }

  return {
    channel: programme.channel,
    start,
    stop,
    title: programme.title,
    description: programme.description,
    category: programme.category
  };
};

/**
 * Reads a guide's bytes into batches of channels and programmes, times
 * resolved, unusable ones counted and left out.
 *
 * Nothing here holds the whole guide: the bytes become text in pieces, the
 * text becomes elements in batches, and each batch is handed on -- and
 * waited for -- before the next is read. No store: parsing only, so that it
 * can run on a thread of its own, away from a page answering a remote.
 */
export const parseGuide: GuideParser = async (bytes, sink, options = {}) => {
  let dropped = 0;

  const text = guideTextFromBytes(bytes, { maxChars: options.maxChars, onProgress: options.onChars });

  await readXmltv(
    text,
    {
      channels: async (batch: XmltvChannel[]) => {
        const usable = batch.filter(channel => channel.id);
        dropped += batch.length - usable.length;
        await sink.channels(usable);
      },
      programmes: async (batch: XmltvProgramme[]) => {
        const usable: GuideProgramme[] = [];

        for (const programme of batch) {
          const resolved = programme.channel ? withTimes(programme) : null;
          if (resolved) {
            usable.push(resolved);
          } else {
            dropped += 1;
          }
        }

        await sink.programmes(usable);
      }
    },
    { batchSize: options.batchSize }
  );

  return { dropped };
};

/**
 * Reads a guide from bytes into the store: parsed (`parseGuide`, or the
 * parser given), each batch written before the next is read.
 */
export const loadGuide = async (
  sourceId: string,
  bytes: AsyncIterable<Uint8Array>,
  store: GuideStore,
  options: LoadGuideOptions = {}
): Promise<GuideLoadReport> => {
  const now = options.now ?? (() => new Date());
  const parse = options.parse ?? parseGuide;

  let channels = 0;
  let programmes = 0;
  let chars = 0;

  await store.beginLoad(sourceId);

  const { dropped } = await parse(
    bytes,
    {
      channels: async batch => {
        if (batch.length) {
          await store.writeChannels(sourceId, batch);
          channels += batch.length;
        }
        options.onProgress?.({ channels, programmes, chars });
      },
      programmes: async parsed => {
        const until = options.until;
        const batch = until === undefined ? parsed : parsed.filter(programme => programme.start < until);
        if (batch.length) {
          await store.writeProgrammes(sourceId, batch);
          programmes += batch.length;
        }
        options.onProgress?.({ channels, programmes, chars });
      }
    },
    {
      batchSize: options.batchSize,
      maxChars: options.maxChars,
      onChars: total => {
        chars = total;
      }
    }
  );

  // Nothing usable at all is not a guide: an address that answered with a
  // web page or an error, read as XML with nothing in it. Finishing would
  // replace the guide this source held with that nothing -- unattended, on
  // a reload of a feed whose server had a bad hour -- so it fails instead,
  // and the previous load stays.
  if (!channels && !programmes) {
    throw new EmptyGuide();
  }

  const loadedAt = now().toISOString();
  await store.finishLoad(sourceId, loadedAt, { channels, programmes });

  return { channels, programmes, dropped, loadedAt };
};
