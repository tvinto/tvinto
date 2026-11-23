import { Injectable, computed, inject, signal } from '@angular/core';
import {
  ChannelRef,
  GuideChannel,
  GuideHit,
  GuideLoadReport,
  GuideLoadSummary,
  GuideProgramme,
  GuideStore,
  GuideParser,
  KnownChannel,
  loadGuide,
  parseGuide
} from '@shared/xtream/guide';
import { GuideFileUnreadable, GuideWorkerUnavailable, workerGuideParser } from '@shared/xtream/guideWorker';
import { MemoryGuideStore } from '@shared/xtream/memoryGuideStore';
import { DeviceDatabaseService } from './device-database.service';
import { PlatformService } from './platform.service';
import { CapacitorGuideStore } from './native/capacitorGuideStore';
import { IndexedDbGuideStore } from './native/indexedDbGuideStore';
import { capacitorGuideBytes, fetchGuideBytes } from './native/guideBytesSource';
import { downloadedFileAddress, downloadedFileBytes, guideDownloadPlugin } from './native/guideDownload';
import { noteHeldTitles } from '../utils/held-titles';
import { reportFailure } from '../utils/failure-reports';
import { rememberLoadedHere } from './guide-loaded-here';

/**
 * A guide's bytes on this device, where its download is when a worker can
 * fetch it itself, and what to do once the load is over.
 */
interface GuideBytes {
  bytes: AsyncIterable<Uint8Array>;
  address: string | null;
  done(): Promise<void>;
}

/**
 * How far back to keep programmes that have finished.
 *
 * Three days, for catch-up: a finished programme is only playable while the
 * guide still says what was on. A user's provider keeps two or three days;
 * a provider keeping a week gets the last three of it, from the guide.
 */
const KEEP_FINISHED_HOURS = 72;

/** How often a load's progress is shown: enough to see it move. */
const PROGRESS_EVERY_MS = 500;

/** What a load is doing, for anything that wants to show it. */
export interface GuideLoadProgress {
  sourceId: string;
  channels: number;
  programmes: number;
  chars: number;
}

/**
 * The guide, as this device has it.
 *
 * The runtime switch for the guide, and the counterpart to
 * ProviderAccessService: it picks how to fetch and where to store, and hands
 * everything else to the shared code. Android fetches through the platform and
 * stores in SQLite; the desktop fetches with plain fetch and stores in
 * IndexedDB, which is the one database it has without a native module.
 *
 * A browser gets neither, and says so rather than half-working. It cannot
 * fetch a cross-origin guide any more than it can reach the provider, and the
 * server that used to do it for it is being retired.
 */
@Injectable({ providedIn: 'root' })
export class GuideService {
  private readonly platform = inject(PlatformService);
  private readonly database = inject(DeviceDatabaseService);

  /** Whether this build can load a guide at all. */
  readonly supported = this.platform.canReachProviderDirectly;

  /** The source currently loading, or null. */
  readonly loading = signal<GuideLoadProgress | null>(null);

  readonly isLoading = computed(() => this.loading() !== null);

  /**
   * Guides waiting their turn behind the one loading, by source id, in order:
   * what a caller loading several one after another has said it will load
   * next. Each leaves when its load starts, or when the caller lets it go.
   */
  readonly queued = signal<readonly string[]>([]);

  /** Says these guides will be loaded here next, one at a time. */
  willLoad(sourceIds: readonly string[]): void {
    this.queued.update(held => [...held, ...sourceIds.filter(id => !held.includes(id))]);
  }

  /** Takes guides off the queue that will not be loaded after all. */
  wontLoad(sourceIds: readonly string[]): void {
    this.queued.update(held => held.filter(id => !sourceIds.includes(id)));
  }

  /** What the last load did, kept so a screen can say what happened. */
  readonly lastReport = signal<GuideLoadReport | null>(null);

  private store: GuideStore | null = null;
  private opening: Promise<GuideStore> | null = null;

  /**
   * Reads a guide from a URL into this device's store.
   *
   * One at a time: two loads at once would be two large downloads competing
   * for the memory this whole design exists to protect, and on Android they
   * would both hold a whole document.
   */
  async load(sourceId: string, url: string): Promise<GuideLoadReport> {
    if (!this.supported) {
      throw new Error('This build cannot load a guide');
    }

    if (this.loading()) {
      throw new Error('A guide is already loading');
    }

    this.loading.set({ sourceId, channels: 0, programmes: 0, chars: 0 });
    this.wontLoad([sourceId]);
    let source: GuideBytes | null = null;
    // Where a failure happened, for its error report: never what or whose.
    let stage: 'open' | 'download' | 'read' | 'prune' = 'open';

    try {
      const store = await this.opened();
      stage = 'download';
      source = await this.bytesFrom(url);
      const bytes = source.bytes;
      stage = 'read';

      // The progress shown twice a second at most: the count redrawn per
      // batch was two seconds of style and layout in forty on the TV emulator
      // while a guide loaded (the performance audit, 10 October).
      let shownAt = 0;
      const report = await loadGuide(sourceId, bytes, store, {
        onProgress: progress => {
          const now = Date.now();
          if (now - shownAt >= PROGRESS_EVERY_MS) {
            shownAt = now;
            this.loading.set({ sourceId, ...progress });
          }
        },
        parse: this.parser(source.address)
      });

      // Remembered outside the store, so that if the store later loses this
      // guide it can be told apart from one nobody ever loaded here.
      rememberLoadedHere(sourceId);

      // The channel list has just changed, so whatever was memoised describes
      // the guide before this one.
      this.knownChannels = null;
      this.lastReport.set(report);

      // Done after rather than before: a load that fails should leave what was
      // there, and pruning first would take some of it away for nothing.
      stage = 'prune';
      await store.prune(Date.now() - KEEP_FINISHED_HOURS * 60 * 60 * 1000);

      return report;
    } catch (error) {
      const chars = this.loading()?.chars ?? 0;
      reportFailure('guide', stage, {
        error: error instanceof Error ? error.name : typeof error,
        // The guide server's status and the size limit, from the messages that say them; nothing else of the message.
        http: Number(/answered (\d{3})\b/.exec(String(error))?.[1]) || null,
        tooLarge: /is larger than/.test(String(error)),
        // Rounded to a megabyte: the size says big or small, not which guide.
        megabytes: Math.round(chars / 1_000_000),
        programmes: this.loading()?.programmes ?? 0
      });
      throw error;
    } finally {
      // Ends the byte source however the load went. A parse that fails part
      // way stops reading without telling the source, and on Android the
      // source is holding a downloaded file in the cache that only its own
      // cleanup deletes. Harmless for a source that already finished.
      await (source?.bytes as AsyncGenerator<Uint8Array> | undefined)?.return?.(undefined).catch(() => undefined);
      await source?.done();
      this.loading.set(null);
    }
  }

  /** Set once the worker could not be started here, so the next guide does not try again. */
  private readHere = typeof Worker === 'undefined';

  /**
   * Who reads the guide: a worker, so the page goes on answering the remote
   * while a guide reloads (shared/xtream/guideWorker.ts); the page itself
   * where a worker cannot be started -- from the same bytes, untouched, so
   * nothing is downloaded twice.
   */
  private parser(address: string | null = null): GuideParser {
    if (this.readHere) {
      return parseGuide;
    }
    return async (bytes, sink, options) => {
      let start: typeof import('./native/guide-worker').startGuideWorker;
      try {
        ({ startGuideWorker: start } = await import('./native/guide-worker'));
      } catch (error) {
        return this.readOnThePage(error, bytes, sink, options);
      }
      // The worker reads the downloaded file itself where it can, and nothing
      // crosses the bridge; where it cannot, the same file goes over the
      // bridge, so nothing is downloaded twice.
      if (address && !this.fileOverBridge) {
        try {
          return await workerGuideParser(start, address)(bytes, sink, options);
        } catch (error) {
          if (!(error instanceof GuideFileUnreadable)) {
            return this.workerFailed(error, bytes, sink, options);
          }
          console.warn('The guide worker could not fetch the download; reading it over the bridge');
          this.fileOverBridge = true;
        }
      }
      try {
        return await workerGuideParser(start)(bytes, sink, options);
      } catch (error) {
        return this.workerFailed(error, bytes, sink, options);
      }
    };
  }

  /** Set once a worker could not fetch a downloaded guide here, so the next one goes over the bridge. */
  private fileOverBridge = false;

  /**
   * Failing part way through is the guide's failure, the caller's to report;
   * only a worker that never started is read around.
   */
  private workerFailed(error: unknown, ...read: Parameters<GuideParser>): ReturnType<GuideParser> {
    if (error instanceof GuideWorkerUnavailable) {
      return this.readOnThePage(error, ...read);
    }
    throw error;
  }

  private readOnThePage(why: unknown, ...read: Parameters<GuideParser>): ReturnType<GuideParser> {
    console.warn('Reading the guide on the page, as a worker could not be started:', why);
    this.readHere = true;
    return parseGuide(...read);
  }

  /**
   * How this device gets a guide's bytes.
   *
   * Android downloads to a file and reads it back in chunks, so the guide never
   * sits in memory whole. An APK built before that plugin existed has only the
   * whole-body download, and a web bundle can arrive on one -- so that stays as
   * the fallback rather than a failure.
   */
  private async bytesFrom(url: string): Promise<GuideBytes> {
    const nothingToClean = async () => undefined;
    if (this.platform.platform === 'electron') {
      return { bytes: fetchGuideBytes(url), address: null, done: nothingToClean };
    }

    const plugin = guideDownloadPlugin();
    if (plugin) {
      // Downloaded first, so the worker can be pointed at the file; deleted
      // however the load ends, because a guide is tens of megabytes of
      // somebody's storage.
      const downloaded = await plugin.download({ url, connectTimeoutMs: 120_000, idleTimeoutMs: 60_000 });
      return {
        bytes: downloadedFileBytes(plugin, downloaded),
        address: downloadedFileAddress(downloaded),
        done: () => plugin.discard({ id: downloaded.id }).catch(() => undefined)
      };
    }

    console.warn('This APK cannot download a guide to a file; loading it whole');
    return { bytes: capacitorGuideBytes(url), address: null, done: nothingToClean };
  }

  /** Programmes on these channels overlapping the window. */
  async programmesFor(refs: ChannelRef[], from: number, to: number): Promise<GuideProgramme[]> {
    if (!this.supported || !refs.length) {
      return [];
    }

    const programmes = await (await this.opened()).programmesFor(refs, from, to);
    // Kept out of error reports from now on (utils/held-titles.ts).
    noteHeldTitles(programmes);
    return programmes;
  }

  /** Programmes whose titles hold the words, across this device's guides (guideSearch.ts). */
  async searchProgrammes(query: string, from: number, to: number, limit: number): Promise<GuideHit[]> {
    if (!this.supported) {
      return [];
    }
    const hits = await (await this.opened()).searchProgrammes(query, from, to, limit);
    noteHeldTitles(hits);
    return hits;
  }

  /** When the last programme a source holds ends, or null. */
  async runsOutAt(sourceId: string): Promise<number | null> {
    if (!this.supported) {
      return null;
    }
    return (await this.opened()).runsOutAt(sourceId);
  }

  /** What a source holds, without loading it again. */
  async summaryFor(sourceId: string): Promise<GuideLoadSummary | null> {
    if (!this.supported) {
      return null;
    }
    return (await this.opened()).loadSummary(sourceId);
  }

  /**
   * What is on now and what follows, per channel.
   *
   * The shape every guide row wants, and worth doing here rather than in each
   * component: one query for all the channels on screen instead of two per
   * channel, which on a television listing is the difference between one
   * round trip and a hundred.
   */
  async nowAndNext(
    refs: ChannelRef[],
    at = Date.now()
  ): Promise<Map<string, { now?: GuideProgramme; next?: GuideProgramme }>> {
    const window = 12 * 60 * 60 * 1000;
    const programmes = await this.programmesFor(refs, at, at + window);
    const byChannel = new Map<string, { now?: GuideProgramme; next?: GuideProgramme }>();

    for (const programme of programmes) {
      const entry = byChannel.get(programme.channel) ?? {};

      if (programme.start <= at && programme.stop > at) {
        entry.now = programme;
      } else if (programme.start > at && !entry.next) {
        // The list arrives in order, so the first one after now is the next one.
        entry.next = programme;
      }

      byChannel.set(programme.channel, entry);
    }

    return byChannel;
  }

  /** The channels a source knows about, for matching them to streams. */
  async channels(sourceId: string): Promise<GuideChannel[]> {
    if (!this.supported) {
      return [];
    }
    return (await this.opened()).channels(sourceId);
  }

  /**
   * Every channel this device has a guide for.
   *
   * Read on every guide lookup, so it is memoised until a load replaces it.
   * Building the match index needs the whole list, and a line-up of fifty
   * thousand streams asks for it once per category opened.
   */
  async allChannels(): Promise<KnownChannel[]> {
    if (!this.supported) {
      return [];
    }

    this.knownChannels ??= (await this.opened()).allChannels();
    return this.knownChannels;
  }

  private knownChannels: Promise<KnownChannel[]> | null = null;

  /**
   * When this device last loaded a source, or null if it never has.
   *
   * The question behind the offer to load one: the account knows the source
   * exists, and this says whether this particular device has it.
   */
  async lastLoadedAt(sourceId: string): Promise<string | null> {
    if (!this.supported) {
      return null;
    }
    return (await this.opened()).lastLoadedAt(sourceId);
  }

  /** Which of these sources this device has no copy of. */
  async missing(sourceIds: string[]): Promise<string[]> {
    const absent: string[] = [];

    for (const sourceId of sourceIds) {
      if (!(await this.lastLoadedAt(sourceId))) {
        absent.push(sourceId);
      }
    }

    return absent;
  }

  /** Throws the stored guide away, for a sign-out. */
  async forget(): Promise<void> {
    const store = this.store;
    this.store = null;
    this.opening = null;
    this.knownChannels = null;
    this.lastReport.set(null);

    await (store as { forget?: () => Promise<void> } | null)?.forget?.();
  }

  /**
   * The store, opened once.
   *
   * Memoised on the promise so several callers during startup share one
   * attempt rather than each creating a table.
   */
  private async opened(): Promise<GuideStore> {
    if (this.store) {
      return this.store;
    }

    this.opening ??= this.build();

    try {
      this.store = await this.opening;
      return this.store;
    } finally {
      this.opening = null;
    }
  }

  private async build(): Promise<GuideStore> {
    if (this.platform.platform === 'electron') {
      try {
        const store = new IndexedDbGuideStore();
        await store.initialise();
        return store;
      } catch (error) {
        // A guide that lasts one session is worse than one that lasts, and
        // better than none: a renderer with its storage blocked should still
        // be able to load a guide and use it until the window closes.
        console.warn('Falling back to a guide held in memory', error);
        return new MemoryGuideStore();
      }
    }

    const store = new CapacitorGuideStore(await this.database.connect());
    await store.initialise();
    return store;
  }
}

