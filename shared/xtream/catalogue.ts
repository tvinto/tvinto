import { Category, Stream, StreamType } from '../types';
import { CatalogueSource } from './source';
import { nameWords, nameWordsJoined } from './channelNames';
import { normaliseStreams } from './protocol';

/**
 * Where a device keeps the catalogue it has seen.
 *
 * Operations rather than SQL, because the drivers differ: better-sqlite3 is
 * synchronous, the Capacitor plugin is not, and a browser has neither. Async
 * throughout as the shape they can all meet.
 *
 * One store serves one subscription. The catalogue belongs to the credentials
 * that fetched it -- a different line is a different line-up -- so the
 * subscription is fixed when the store is built rather than threaded through
 * every call.
 */
export interface CatalogueStore {
  readCategories(type: StreamType): Promise<Category[]>;
  writeCategories(type: StreamType, categories: Category[]): Promise<void>;

  readStreams(type: StreamType, categoryId: string): Promise<Stream[]>;
  writeStreams(type: StreamType, categoryId: string, streams: Stream[]): Promise<void>;

  /**
   * When this category was last asked about, whatever came back.
   *
   * The distinction the cache cannot otherwise make: a category with no rows
   * might never have been fetched, or might have been fetched and be genuinely
   * empty. Without this the second kind is asked about on every single visit,
   * forever.
   */
  lastFetchedAt(type: StreamType, categoryId: string): Promise<string | null>;
  markFetched(type: StreamType, categoryId: string, at: string): Promise<void>;

  /**
   * Streams already held whose name contains every one of these words.
   *
   * A coarse filter, deliberately: the store's job is to get the candidates
   * down to something small without reading the whole catalogue into memory,
   * and `Catalogue.search` decides which of them actually match. A substring
   * test says "bbc" matches "Abbey", and only the caller knows that is wrong.
   *
   * Words arrive lower-cased and already stripped of the provider's packaging,
   * so an implementation only has to match them case-insensitively. With
   * `joined`, against the name as `searchable` writes it -- separators taken
   * out, so "xmen" is a candidate for "X-Men". Several times slower (445 ms
   * against 84 ms over 200,000 films on the TV emulator), so only asked for
   * when the plain match found nothing.
   */
  findStreams(type: StreamType, words: string[], limit: number, joined?: boolean): Promise<Stream[]>;

  /**
   * Streams held whose name contains any one of these words: the candidates
   * for many titles in one read of the library (`Catalogue.findTitles`).
   * Optional; a store without it is asked word by word.
   */
  findStreamsWithAny?(type: StreamType, words: string[], limit: number): Promise<Stream[]>;

  /**
   * The streams held with the latest `added` dates, newest first, each with
   * its `category_id`. For the For You page's "Recently added": it reads what
   * the device holds -- browsed categories and the daily search index -- and
   * never asks the provider.
   */
  recentlyAdded(type: StreamType, limit: number): Promise<Stream[]>;

  /**
   * Every stream held for a library, each with its `category_id`. For
   * carrying an account over to a replaced provider (shared/providers/
   * carryOver.ts), which needs the names behind the ids it holds. Optional:
   * a store without it has nothing to carry over from.
   */
  allStreams?(type: StreamType): Promise<Stream[]>;
}

export interface CataloguePolicy {
  /**
   * How long to take a provider's word for it that a category is empty.
   *
   * Not zero, because plenty of categories legitimately have nothing in them
   * and asking about each one on every visit is how a device makes hundreds of
   * pointless requests. Not forever, because a provider does fill them in.
   */
  emptyCategoryRetryHours: number;
  /**
   * How long a whole-library index is trusted before a search refreshes it.
   *
   * A day: new films and channels turn up daily, and one request a day per
   * library per device is nothing to a provider -- where the sweep that got
   * this address blocked was over a thousand at once.
   */
  indexMaxAgeHours: number;
  /** Supplied so tests need not wait for real time to pass. */
  now: () => Date;
}

const DEFAULT_POLICY: CataloguePolicy = {
  emptyCategoryRetryHours: 12,
  indexMaxAgeHours: 24,
  now: () => new Date()
};

/** Categories written so far, and of how many: null where that is not known yet. */
export type FiledProgress = (filed: number, total: number | null) => void;

/**
 * The catalogue, as a device sees it: local first, provider only when it must.
 *
 * This is what lets a phone work with nothing else running. It is deliberately
 * lazy -- it fetches the one thing being looked at and keeps it -- and it never
 * sweeps. A sweep is well over a thousand requests, and several devices each
 * doing their own is how an address gets blocked. Everything here is built so
 * that browsing costs the provider one request per category, once.
 *
 * It holds no opinion about ordering. What comes back is what the provider
 * sent or what was stored; arranging it is the caller's business, and depends
 * on an account this object knows nothing about.
 */
export class Catalogue {
  private readonly policy: CataloguePolicy;

  constructor(
    private readonly client: CatalogueSource,
    private readonly store: CatalogueStore,
    policy: Partial<CataloguePolicy> = {}
  ) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  /**
   * The categories for a type.
   *
   * Fetched once and kept. There is no freshness check: a provider adding a
   * category is not worth a request on every visit, and a sync is what exists
   * for deliberately catching up.
   */
  async categories(type: StreamType): Promise<Category[]> {
    const cached = await this.store.readCategories(type);
    if (cached.length > 0) {
      return cached;
    }

    const fetched = await this.client.getCategories(type);
    if (fetched.length > 0) {
      await this.store.writeCategories(type, fetched);
    }
    return fetched;
  }

  /**
   * The streams in one category.
   *
   * The whole lazy-fill policy in one method: serve what is stored, and
   * otherwise fetch exactly this category and keep it. A category that comes
   * back empty is remembered as having been asked, so the emptiness costs one
   * request rather than one per visit.
   */
  async streams(type: StreamType, categoryId: string): Promise<Stream[]> {
    const cached = await this.store.readStreams(type, categoryId);
    if (cached.length > 0 && !storedBeforeKept(type, cached)) {
      return cached;
    }

    // Rows kept before a field they now carry: asked for once more, and the
    // old rows kept if that cannot be done.
    if (cached.length > 0) {
      try {
        const fetched = await this.client.getStreams(type, categoryId);
        await this.store.markFetched(type, categoryId, this.policy.now().toISOString());
        if (fetched.length > 0) {
          await this.store.writeStreams(type, categoryId, fetched);
          return fetched;
        }
      } catch {
        // Offline, or the provider busy: what is held still plays.
      }
      return cached;
    }

    if (await this.askedRecently(type, categoryId)) {
      return [];
    }

    const fetched = await this.client.getStreams(type, categoryId);

    // Recorded before the rows, and recorded even when there are none: that is
    // the whole point of it.
    await this.store.markFetched(type, categoryId, this.policy.now().toISOString());
    if (fetched.length > 0) {
      await this.store.writeStreams(type, categoryId, fetched);
    }

    return fetched;
  }

  /**
   * Fills a category without returning it, for a deliberate top-up.
   *
   * Separate from streams() so that pre-fetching is always something asked
   * for. Nothing here decides on its own to go and get more.
   */
  async prefetch(type: StreamType, categoryId: string): Promise<number> {
    const streams = await this.streams(type, categoryId);
    return streams.length;
  }

  /** Every stream this device holds for a library (see `CatalogueStore.allStreams`). */
  async allStreams(type: StreamType): Promise<Stream[]> {
    return (await this.store.allStreams?.(type)) ?? [];
  }

  /**
   * A category as this device holds it, never asked of the provider -- empty
   * when it is not held. For rows that must cost the provider nothing (the
   * library's front page, round 13).
   */
  held(type: StreamType, categoryId: string): Promise<Stream[]> {
    return this.store.readStreams(type, categoryId);
  }

  /** Newest additions this device holds for a library (see `CatalogueStore.recentlyAdded`). */
  recentlyAdded(type: StreamType, limit = 24): Promise<Stream[]> {
    return this.store.recentlyAdded(type, limit);
  }

  /**
   * When this library was last indexed whole, or null if it never has been.
   *
   * Kept as a fetch mark under a category id no provider uses, so no store
   * needs a table or a column for it.
   */
  async indexedAt(type: StreamType): Promise<string | null> {
    return this.store.lastFetchedAt(type, WHOLE_LIBRARY);
  }

  /** Whether the index is younger than `indexMaxAgeHours`. */
  async indexIsFresh(type: StreamType): Promise<boolean> {
    const at = await this.indexedAt(type);
    const age = at ? this.policy.now().getTime() - Date.parse(at) : Number.NaN;
    return Number.isFinite(age) && age >= 0 && age < this.policy.indexMaxAgeHours * 3600 * 1000;
  }

  private readonly indexing = new Map<StreamType, Promise<number>>();

  /**
   * Fetches a whole library in one request and files it under its categories.
   *
   * What makes search cover every category. Xtream answers `get_vod_streams`
   * (and the live and series equivalents) without a category with everything
   * at once: one request, where filling the categories one by one would be the
   * sweep this class exists to prevent. The rows land in the same per-category
   * cache browsing reads, so a category opened afterwards costs nothing.
   *
   * One at a time per library: a second call while one is running shares it,
   * so a search typed twice does not ask twice.
   *
   * `onFiled` hears how many categories are written of how many there are,
   * once the download is in: the one part of an index whose length is known.
   *
   * `pause` is awaited before each category is written: a background refresh
   * yields the database to someone using the app (card 38).
   */
  index(type: StreamType, timeoutMs = INDEX_TIMEOUT_MS, onFiled?: FiledProgress, pause?: () => Promise<void>): Promise<number> {
    return this.once(type, async () => {
      const all = await this.client.getStreams(type, undefined, timeoutMs);
      return this.fileLibrary(type, all.map(slim), onFiled, pause);
    });
  }

  /**
   * The same index from a listing read a title at a time -- how a television
   * does it, where the whole response held at once was more than the app's
   * memory (see `jsonArrayObjects`). The items are the provider's raw rows;
   * each is normalised and cut down to what the store keeps as it arrives, so
   * what is held while reading is a few fields per title rather than every
   * synopsis and cast list in the library.
   */
  indexFrom(type: StreamType, rawItems: AsyncIterable<Record<string, unknown>>): Promise<number> {
    return this.once(type, async () => {
      const kept: Stream[] = [];
      let batch: Record<string, unknown>[] = [];
      for await (const item of rawItems) {
        batch.push(item);
        if (batch.length >= NORMALISE_BATCH) {
          kept.push(...normaliseStreams(batch, type).map(slim));
          batch = [];
        }
      }
      kept.push(...normaliseStreams(batch, type).map(slim));
      return this.fileLibrary(type, kept);
    });
  }

  /**
   * The same index from a reader that files the library a category at a time
   * (shared/xtream/libraryWorker.ts) -- on a television, a worker that reads
   * the listing away from the page. Each category is written as it is handed
   * over, and the whole library is marked last, so an index cut short is not
   * taken for a finished one. `onFiled` hears each category written; how
   * many there will be is not known until the reader is done.
   */
  indexWith(
    type: StreamType,
    read: (file: (categoryId: string, streams: Stream[]) => Promise<void>) => Promise<number>,
    onFiled?: FiledProgress,
    pause?: () => Promise<void>
  ): Promise<number> {
    return this.once(type, async () => {
      const at = this.policy.now().toISOString();
      let filed = 0;
      const count = await read(async (categoryId, streams) => {
        await pause?.();
        await this.store.writeStreams(type, categoryId, streams);
        await this.store.markFetched(type, categoryId, at);
        onFiled?.(++filed, null);
      });
      await this.store.markFetched(type, WHOLE_LIBRARY, at);
      return count;
    });
  }

  private once(type: StreamType, work: () => Promise<number>): Promise<number> {
    const running = this.indexing.get(type);
    if (running) {
      return running;
    }
    const started = work().finally(() => this.indexing.delete(type));
    this.indexing.set(type, started);
    return started;
  }

  private async fileLibrary(type: StreamType, all: Stream[], onFiled?: FiledProgress, pause?: () => Promise<void>): Promise<number> {
    const at = this.policy.now().toISOString();

    const byCategory = new Map<string, Stream[]>();
    for (const stream of all) {
      const categoryId = (stream as unknown as Record<string, unknown>)['category_id'];
      if (categoryId === null || categoryId === undefined || categoryId === '') {
        continue;
      }
      const key = String(categoryId);
      const list = byCategory.get(key) ?? [];
      list.push(stream);
      byCategory.set(key, list);
    }

    let filed = 0;
    onFiled?.(0, byCategory.size);
    for (const [categoryId, streams] of byCategory) {
      await pause?.();
      await this.store.writeStreams(type, categoryId, streams);
      await this.store.markFetched(type, categoryId, at);
      onFiled?.(++filed, byCategory.size);
    }

    // Last, so an index cut short is not taken for a finished one.
    await this.store.markFetched(type, WHOLE_LIBRARY, at);
    return all.length;
  }

  /**
   * Searching what this device already holds.
   *
   * **It never fetches.** There is no search in the Xtream protocol, and a
   * search box is the most natural thing in the world to type into repeatedly;
   * wiring one to fetching per category would be the sweep that got this
   * address blocked for a fortnight. So it reads the store and nothing else.
   * What makes it cover every category is `index`, one request per library
   * at most once a day, which the caller runs before searching.
   *
   * Matching is on words rather than substrings, and that is what makes it
   * work at all here. This provider writes a channel as `HR| HRT 2 ⱽᴵᴾ ᴿᴬᵂ`:
   * a country tag, the name, and superscript packaging marks. Somebody types
   * "hrt 2". A substring test fails on the tag, and fails again on anything
   * typed in a different order. Reducing both sides with `nameWords` -- which
   * already throws away the tag, the quality words and the marks, because
   * guide matching needed exactly this -- makes "hrt 2", "HRT 2 ⱽᴵᴾ" and
   * "2 hrt" all find the same channel.
   *
   * A query that is nothing but packaging ("HD", "ᵛᴵᴾ") reduces to no words at
   * all. That returns nothing rather than everything: it is not a search for
   * anything, and answering it with the first fifty rows of the catalogue
   * would be worse than answering it with nothing.
   */
  async search(type: StreamType, query: string, limit = 100): Promise<Stream[]> {
    const words = nameWords(query);
    if (words.length === 0) {
      return [];
    }

    const found = await this.matching(type, words, limit);
    if (found.length) {
      return found;
    }

    /*
     * Nothing matched, so try again with the long words cut short.
     *
     * Somebody typing "x-men apocalipse" has spelled it wrong, and somebody
     * typing "x-men apoca" has not finished; both deserve the film rather than
     * an empty screen. Cutting each long word to its first few letters catches
     * either, because a slip is nearly always further along a word than that.
     *
     * Only when the first pass found nothing, and never on short words, where
     * a stem is not a word: `the` would become `the` and `bbc` would find
     * everything.
     */
    const stems = words.map(word => (word.length >= LONG_WORD ? word.slice(0, STEM_LENGTH) : word));
    if (!stems.every((stem, index) => stem === words[index])) {
      const stemmed = await this.matching(type, stems, limit);
      if (stemmed.length) {
        return stemmed;
      }
    }

    // "xmen" for a film written "X-Men": the name with its separators out.
    const joined = await this.matching(type, words, limit, true);
    if (joined.length) {
      return joined;
    }

    // "x men" for a film written "XMen": the words typed apart, written together.
    if (words.length > 1) {
      return this.matching(type, [words.join('')], limit);
    }
    return [];
  }

  /**
   * Many titles looked for at once, each answered with the copies held of it.
   *
   * For Popular this week (PopularService), which looks up sixty titles from
   * TMDB's lists, two names each. One search per name was a read of the whole
   * library each, plus the further passes `search` makes for a name it does
   * not find -- which is most of them, since a library holds a fraction of
   * what is trending: over a minute on a user's TV, 18 s on the emulator
   * (22 October). Here each title's longest word picks the candidates, a few
   * reads of the library for all of them, and the matching is done here.
   *
   * A title matches a name when every one of its words begins a word of the
   * name, as in `search`, or when its words written together begin the
   * name's ("Spider-Man: No Way Home" and "Spiderman No Way Home"). There
   * are no fuzzy passes: these titles are spelled by TMDB, not typed.
   *
   * `signal` stops the reads not yet made, for a page that has been left:
   * Android's one database lane runs them in turn, and a film page's went on
   * long after it, ahead of every other read (26 November).
   */
  async findTitles(type: StreamType, titles: string[], signal?: AbortSignal): Promise<Map<string, Stream[]>> {
    const found = new Map<string, Stream[]>();
    const wanted = [...new Set(titles)]
      .map(title => ({ title, words: nameWords(title) }))
      .filter(entry => entry.words.length > 0);
    if (!wanted.length) {
      return found;
    }

    const keys = [...new Set(wanted.map(entry => entry.words.reduce((a, b) => (b.length > a.length ? b : a))))];
    const candidates = new Map<string, Stream>();
    for (let start = 0; start < keys.length && !signal?.aborted; start += TITLE_KEYS_PER_READ) {
      const some = keys.slice(start, start + TITLE_KEYS_PER_READ);
      const read = this.store.findStreamsWithAny
        ? await this.store.findStreamsWithAny(type, some, TITLE_CANDIDATES)
        : (await Promise.all(some.map(key => this.store.findStreams(type, [key], TITLE_COPIES * 4)))).flat();
      for (const stream of read) {
        candidates.set(String(stream.stream_id), stream);
      }
    }

    const named = [...candidates.values()].map(stream => ({
      stream,
      words: nameWordsJoined(stream.name ?? ''),
      together: nameWords(stream.name ?? '').join('')
    }));
    for (const entry of wanted) {
      const together = entry.words.join('');
      found.set(
        entry.title,
        named
          .filter(
            candidate =>
              candidate.together.startsWith(together) ||
              entry.words.every(word =>
                candidate.words.some(nameWord => (word.length >= PREFIX_FROM ? nameWord.startsWith(word) : nameWord === word))
              )
          )
          .slice(0, TITLE_COPIES)
          .map(candidate => candidate.stream)
      );
    }
    return found;
  }

  /**
   * Candidates from the store, kept if every word of the query begins a word of
   * the name.
   *
   * A prefix rather than the whole word, which is the difference between
   * "apoca" finding X-Men: Apocalypse and finding nothing. It is still a word
   * boundary -- the store matches substrings anywhere, and that is what made
   * "bbc" find "Abbey" -- so a query word has to start a word of the name.
   */
  private async matching(type: StreamType, words: string[], limit: number, joined = false): Promise<Stream[]> {
    const candidates = await this.store.findStreams(type, words, limit * 4, joined);

    const matches = candidates.filter(stream => {
      // With runs of words written together, so "xmen" begins "X-Men".
      const streamWords = nameWordsJoined(stream.name ?? '');
      return words.every(word =>
        streamWords.some(nameWord =>
          word.length >= PREFIX_FROM ? nameWord.startsWith(word) : nameWord === word
        )
      );
    });

    return matches.slice(0, limit);
  }

  private async askedRecently(type: StreamType, categoryId: string): Promise<boolean> {
    const last = await this.store.lastFetchedAt(type, categoryId);
    if (!last) {
      return false;
    }

    const age = this.policy.now().getTime() - Date.parse(last);
    if (!Number.isFinite(age)) {
      // An unreadable timestamp should mean "ask again", not "never ask".
      return false;
    }

    return age < this.policy.emptyCategoryRetryHours * 3600 * 1000;
  }
}

/**
 * Whether a category was stored before something now kept was: channels
 * before catch-up (`tv_archive`), shows before their date (`added`, from
 * `last_modified`). None of the rows says either way. A row normalised since
 * always does, so this is true once per category and never again.
 */
function storedBeforeKept(type: StreamType, streams: Stream[]): boolean {
  const missing = (value: unknown) => value === undefined || value === null || value === '';
  if (type === 'live') {
    return streams.every(stream => missing(stream.tv_archive));
  }
  if (type === 'series') {
    return streams.every(stream => missing(stream.added));
  }
  return false;
}

/** The fetch-mark category id recording a whole-library index. No provider uses it. */
const WHOLE_LIBRARY = '__whole_library__';

/** How many raw rows are normalised together while a listing is read. */
const NORMALISE_BATCH = 500;

/**
 * A title cut down to what the stores keep and the screens read. A provider's
 * row can carry a synopsis, a cast list and a trailer link; a library of them
 * held whole was what ran a television out of memory.
 */
const SLIM_FIELDS = [
  'stream_id',
  'name',
  'stream_icon',
  'icon',
  'category_id',
  'epg_channel_id',
  'added',
  'num',
  'container_extension',
  'stream_type',
  'rating',
  'tv_archive',
  'tv_archive_duration',
  // How an M3U playlist's entry is reached (shared/m3u); an Xtream row has none.
  'source_url',
  'catchup_mode',
  'catchup_source',
  // What a Stalker portal's create_link turns into an address (shared/stalker).
  'portal_cmd'
] as const;

/** Raw rows of a listing, normalised and cut down to what the store keeps. */
export function slimStreams(raw: Record<string, unknown>[], type: StreamType): Stream[] {
  return normaliseStreams(raw, type).map(slim);
}

function slim(stream: Stream): Stream {
  const source = stream as unknown as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const field of SLIM_FIELDS) {
    if (source[field] !== undefined) {
      kept[field] = source[field];
    }
  }
  return kept as unknown as Stream;
}

/**
 * How long a query word must be before it may match the start of a longer one.
 *
 * Three, so "apo" can open "Apocalypse" while "a" and "of" still have to be
 * words in their own right -- a one-letter prefix matches half the library.
 */
const PREFIX_FROM = 3;

/** Titles' words asked for in one read of the library (`findTitles`). */
const TITLE_KEYS_PER_READ = 20;

/** Copies kept of each title (`findTitles`): Resident Evil is fifty copies of eight films. */
const TITLE_COPIES = 100;

/** How many candidates one such read may bring back. */
const TITLE_CANDIDATES = 4000;

/** A word long enough to be worth cutting short when nothing was found. */
const LONG_WORD = 5;

/** What a long word is cut to on the second pass: enough to be meant. */
const STEM_LENGTH = 4;

/** A whole library is one large response; slower than a category, and allowed to be. */
const INDEX_TIMEOUT_MS = 180_000;
