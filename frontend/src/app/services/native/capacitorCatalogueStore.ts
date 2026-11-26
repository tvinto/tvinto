import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Category, Stream, StreamType } from '@shared/types';
import { CatalogueStore } from '@shared/xtream/catalogue';
import { searchableSql } from '@shared/xtream/channelNames';
import {
  namesBeginningWith,
  STREAM_NAMES_FILL,
  STREAM_NAMES_PIECE,
  STREAM_NAMES_PROGRESS,
  STREAM_NAMES_SETUP,
  STREAMS_NAMED,
  UPSERT_STREAM
} from '@shared/xtream/streamNames';
import { untilIdleWork } from '../../utils/library-refresh.utils';
import { ensureColumns } from './capacitorGuideStore';

/** Rows per write of a category's streams (`writeStreams`). */
const WRITE_PIECE_ROWS = 250;

/**
 * The device's own catalogue, in SQLite on the phone.
 *
 * The counterpart to SqliteCatalogueStore on the server: same interface, same
 * policy above it, a different driver underneath. This one is asynchronous
 * because the plugin is, which is why the interface was written async even
 * though better-sqlite3 is not.
 *
 * One store per subscription. A different line has a different line-up, and
 * mixing two would show a channel that cannot be played.
 */
export class CapacitorCatalogueStore implements CatalogueStore {
  constructor(
    private readonly db: SQLiteDBConnection,
    private readonly providerUsername: string
  ) {}

  /** Whether `stream_names` indexes every name held (shared/xtream/streamNames.ts). */
  private namesIndexed = false;

  /** Whether this SQLite has FTS5, and so the word index at all. */
  private namesHere = false;

  /** The fill of the word index running now, if one is. */
  private filling: Promise<void> | null = null;

  /** Set while a whole library is written without the word index's triggers (`bulk`). */
  private bulkWriting: Promise<void> | null = null;

  /**
   * Creates the tables if this device has not held a catalogue before.
   *
   * Deliberately a subset of the server's schema: a device caches what it
   * browses and nothing else. Sync status, guide data and everything belonging
   * to an account live elsewhere -- the account's own work syncs through the
   * change feed, and the catalogue is disposable by design.
   */
  async initialise(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS categories (
        provider TEXT NOT NULL,
        type TEXT NOT NULL,
        category_id TEXT NOT NULL,
        category_name TEXT NOT NULL,
        parent_id TEXT,
        PRIMARY KEY (provider, type, category_id)
      );

      CREATE TABLE IF NOT EXISTS streams (
        provider TEXT NOT NULL,
        type TEXT NOT NULL,
        category_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        name TEXT NOT NULL,
        stream_icon TEXT,
        epg_channel_id TEXT,
        added TEXT,
        num INTEGER,
        container_extension TEXT,
        PRIMARY KEY (provider, type, stream_id)
      );

      CREATE INDEX IF NOT EXISTS idx_streams_category
        ON streams(provider, type, category_id);

      -- No index on (provider, type, name). On a user's TV (200,979 films)
      -- building it held the database 6.7 to 7.7 s on the first start, and
      -- it saved little: a typed word 530 to 400 ms, twenty words (More like
      -- this before stream_names is filled) 4.8 to 4.6 s. SQLite also read
      -- each category through it, in name order (26 November).

      -- Which categories have been asked about, separately from what came
      -- back. Without it an empty category is indistinguishable from one never
      -- fetched, and gets asked about on every visit forever.
      CREATE TABLE IF NOT EXISTS category_fetch_attempts (
        provider TEXT NOT NULL,
        type TEXT NOT NULL,
        category_id TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        PRIMARY KEY (provider, type, category_id)
      );
    `);

    // Catch-up, added after devices already held catalogues. Null on the rows
    // from before, which is what has their category fetched once more.
    await ensureColumns(this.db, [
      ['streams', 'tv_archive', 'INTEGER'],
      ['streams', 'tv_archive_duration', 'INTEGER'],
      ['streams', 'extra', 'TEXT']
    ]);

    try {
      await this.db.execute(STREAM_NAMES_SETUP);
    } catch {
      // No FTS5 here (the web's sql.js): titles are looked for with LIKE.
      return;
    }
    this.namesHere = true;
    this.fillNames();
  }

  private fillNames(): void {
    this.filling ??= this.indexNames()
      .catch(() => undefined)
      .finally(() => (this.filling = null));
  }

  /**
   * A library never held, written whole without the word index's insert and
   * rename triggers; the index is filled afterwards, while nobody uses the
   * app (indexNames). With them, a first load on the owner's TV held the
   * database 1 to 3 s in 31 of its writes (26 November, card 42): FTS5
   * merging as 200,000 names went in. Titles are looked for with LIKE until
   * the fill is done.
   */
  async bulk<T>(work: () => Promise<T>): Promise<T> {
    if (!this.namesHere || this.bulkWriting) {
      return work();
    }
    let done = () => undefined as void;
    this.bulkWriting = new Promise<void>(resolve => (done = resolve));
    try {
      const filled = (await this.db.query('SELECT upto, done FROM stream_names_filled WHERE id = 1')).values?.[0];
      const last = Number((await this.db.query('SELECT MAX(rowid) AS last FROM streams')).values?.[0]?.['last'] ?? 0);
      // Indexed up to here: everything held, or as far as a fill has got.
      const upto = filled && !filled['done'] ? Math.min(Number(filled['upto'] ?? 0), last) : last;
      await this.db.execute('DROP TRIGGER IF EXISTS stream_names_insert; DROP TRIGGER IF EXISTS stream_names_update;');
      await this.db.run(STREAM_NAMES_PROGRESS, [upto, 0]);
      this.namesIndexed = false;
      return await work();
    } finally {
      await this.db.execute(STREAM_NAMES_SETUP).catch(() => undefined);
      this.bulkWriting = null;
      done();
      this.fillNames();
    }
  }

  /**
   * Indexes the names held before the index existed, a piece per call, so
   * every other read waits for one piece at most. 200,000 films are two
   * hundred pieces; the triggers index whatever is written meanwhile.
   *
   * Only while nobody uses the app, as a library refresh: on a user's TV
   * the fill took about 25 s, and two to five of its calls held the
   * database 1.3 to 2.6 s each -- SQLite copying its log into the database
   * (about 1.5 s whatever the size there) and FTS5 merging (26 November).
   */
  private async indexNames(): Promise<void> {
    const filled = (await this.db.query('SELECT upto, done FROM stream_names_filled WHERE id = 1')).values?.[0];
    let upto = Number(filled?.['upto'] ?? 0);
    if (!filled?.['done']) {
      // Until no row is left past what is indexed: a library written
      // meanwhile without the triggers (`bulk`) adds rows to fill.
      for (;;) {
        await this.bulkWriting;
        const last = Number((await this.db.query('SELECT MAX(rowid) AS last FROM streams')).values?.[0]?.['last'] ?? 0);
        if (upto >= last) {
          break;
        }
        // `run`, not executeSet: given rows of values, executeSet writes them
        // into a VALUES list, which an INSERT ... SELECT has not got.
        for (; upto < last; upto += STREAM_NAMES_PIECE) {
          await untilIdleWork();
          // Never beside a library being written (`bulk`): the merging is what it avoids.
          while (this.bulkWriting) {
            await this.bulkWriting;
            await untilIdleWork();
          }
          await this.db.run(STREAM_NAMES_FILL, [upto, upto + STREAM_NAMES_PIECE]);
          await this.db.run(STREAM_NAMES_PROGRESS, [upto + STREAM_NAMES_PIECE, 0]);
        }
      }
      if (this.bulkWriting) {
        return;
      }
      await this.db.run(STREAM_NAMES_PROGRESS, [upto, 1]);
    }
    this.namesIndexed = true;
  }

  async readCategories(type: StreamType): Promise<Category[]> {
    const result = await this.db.query(
      `SELECT category_id, category_name, parent_id FROM categories
        WHERE provider = ? AND type = ?
        ORDER BY category_name`,
      [this.providerUsername, type]
    );

    return (result.values ?? []).map(row => ({
      category_id: String(row['category_id']),
      category_name: String(row['category_name'] ?? ''),
      parent_id: String(row['parent_id'] ?? '0')
    }));
  }

  async writeCategories(type: StreamType, categories: Category[]): Promise<void> {
    if (categories.length === 0) {
      return;
    }

    // One statement set, so a partly-written catalogue cannot be read as a
    // whole one by the next launch.
    await this.db.executeSet(
      [
        {
          statement: `INSERT OR REPLACE INTO categories
                        (provider, type, category_id, category_name, parent_id)
                      VALUES (?, ?, ?, ?, ?)`,
          values: categories.map(category => [
            this.providerUsername,
            type,
            String(category.category_id),
            category.category_name ?? '',
            String(category.parent_id ?? '0')
          ])
        }
      ],
      true
    );
  }

  async readStreams(type: StreamType, categoryId: string): Promise<Stream[]> {
    const result = await this.db.query(
      `SELECT stream_id, name, stream_icon, epg_channel_id, added, num, container_extension,
              tv_archive, tv_archive_duration, extra
         FROM streams
        WHERE provider = ? AND type = ? AND category_id = ?
        ORDER BY name`,
      [this.providerUsername, type, categoryId]
    );

    return (result.values ?? []).map(row => ({
      stream_id: String(row['stream_id']),
      name: String(row['name'] ?? ''),
      icon: String(row['stream_icon'] ?? ''),
      stream_icon: String(row['stream_icon'] ?? ''),
      epg_channel_id: row['epg_channel_id'] ?? undefined,
      added: row['added'] ?? undefined,
      num: row['num'] ?? undefined,
      container_extension: row['container_extension'] ?? undefined,
      ...archiveOf(row),
      ...extraOf(row),
      category_id: categoryId,
      type
    })) as unknown as Stream[];
  }

  async writeStreams(type: StreamType, categoryId: string, streams: Stream[]): Promise<void> {
    if (streams.length === 0) {
      return;
    }

    const rows = streams.map(stream => {
      const item = stream as unknown as Record<string, unknown>;
      return [
        this.providerUsername,
        type,
        categoryId,
        String(item['stream_id']),
        String(item['name'] ?? ''),
        (item['stream_icon'] as string) ?? null,
        (item['epg_channel_id'] as string) ?? null,
        (item['added'] as string) ?? null,
        (item['num'] as number) ?? null,
        (item['container_extension'] as string) ?? null,
        (item['tv_archive'] as number) ?? null,
        (item['tv_archive_duration'] as number) ?? null,
        extraFor(item)
      ];
    });

    // In pieces, each its own call. A write holds the database until it is
    // done, and every read waits behind it: the largest film category,
    // 6,442 films, held it for 6 to 8 s on the TV emulator, and a screen
    // opened during a library refresh waited that long. A piece is about a
    // quarter of a second; the pieces cost about 50 ms each.
    for (let at = 0; at < rows.length; at += WRITE_PIECE_ROWS) {
      await this.db.executeSet(
        [
          {
            // An UPSERT, not INSERT OR REPLACE: a stream already held keeps its
            // rowid, which the name index is keyed by (streamNames.ts).
            statement: UPSERT_STREAM,
            values: rows.slice(at, at + WRITE_PIECE_ROWS)
          }
        ],
        true
      );
    }
  }

  async lastFetchedAt(type: StreamType, categoryId: string): Promise<string | null> {
    const result = await this.db.query(
      `SELECT attempted_at FROM category_fetch_attempts
        WHERE provider = ? AND type = ? AND category_id = ?`,
      [this.providerUsername, type, categoryId]
    );

    const row = (result.values ?? [])[0];
    return row ? String(row['attempted_at']) : null;
  }

  /**
   * Candidates for a search, narrowed by the database rather than by us.
   *
   * One LIKE per word, ANDed, which SQLite answers with a scan of this
   * provider's rows and no sorting -- cheap next to shipping ten thousand
   * names into JavaScript to filter them there. LIKE is case-insensitive for
   * ASCII in SQLite by default, and the words arrive lower-cased.
   *
   * The wildcards are bound as parameters, never concatenated: a channel
   * called "100% Sport" would otherwise turn a search into a pattern that
   * matches everything, and a name is provider-supplied text.
   *
   * `limit` is generous on purpose. These are candidates, not results -- the
   * caller re-tests them word by word and throws away the substring accidents,
   * so cutting the list too early here loses real matches.
   */
  async recentlyAdded(type: StreamType, limit: number): Promise<Stream[]> {
    // `added` is a Unix time in seconds, stored as the provider sent it.
    const result = await this.db.query(
      `SELECT stream_id, name, stream_icon, epg_channel_id, added, num, container_extension, category_id,
              tv_archive, tv_archive_duration, extra
         FROM streams
        WHERE provider = ? AND type = ? AND CAST(added AS INTEGER) > 0
        ORDER BY CAST(added AS INTEGER) DESC
        LIMIT ?`,
      [this.providerUsername, type, limit]
    );

    return (result.values ?? []).map(row => ({
      stream_id: String(row['stream_id']),
      name: String(row['name'] ?? ''),
      icon: String(row['stream_icon'] ?? ''),
      stream_icon: String(row['stream_icon'] ?? ''),
      epg_channel_id: (row['epg_channel_id'] as string) ?? undefined,
      added: (row['added'] as string) ?? undefined,
      num: row['num'] ?? undefined,
      container_extension: row['container_extension'] ?? undefined,
      ...archiveOf(row),
      ...extraOf(row),
      category_id: String(row['category_id'] ?? '')
    })) as unknown as Stream[];
  }

  async allStreams(type: StreamType): Promise<Stream[]> {
    const result = await this.db.query(
      `SELECT stream_id, name, stream_icon, epg_channel_id, added, num, container_extension, category_id,
              tv_archive, tv_archive_duration, extra
         FROM streams
        WHERE provider = ? AND type = ?`,
      [this.providerUsername, type]
    );
    return (result.values ?? []).map(row => ({
      stream_id: String(row['stream_id']),
      name: String(row['name'] ?? ''),
      icon: String(row['stream_icon'] ?? ''),
      stream_icon: String(row['stream_icon'] ?? ''),
      epg_channel_id: row['epg_channel_id'] ?? undefined,
      added: row['added'] ?? undefined,
      num: row['num'] ?? undefined,
      container_extension: row['container_extension'] ?? undefined,
      ...archiveOf(row),
      ...extraOf(row),
      category_id: String(row['category_id'] ?? '')
    })) as unknown as Stream[];
  }

  async findStreams(type: StreamType, words: string[], limit: number, joined = false): Promise<Stream[]> {
    if (words.length === 0) {
      return [];
    }
    // `name`, not `LOWER(name)`: LIKE already ignores case, and the words
    // arrive lower-cased. LOWER on every name made a read of twenty titles three times slower.
    const column = joined ? searchableSql('name') : 'name';
    return this.findWhere(type, words.map(() => `${column} LIKE ?`).join(' AND '), words, limit);
  }

  /** Any of the words, in one read of the library (Catalogue.findTitles): from the name index once it is whole. */
  async findStreamsWithAny(type: StreamType, words: string[], limit: number): Promise<Stream[]> {
    if (words.length === 0) {
      return [];
    }
    if (this.namesIndexed) {
      try {
        // A word that begins a word of the name, where LIKE found it anywhere:
        // findTitles keeps only those anyway. Unsorted, so a word in a great
        // many names stops at `limit` rather than sorting every one of them
        // (three times quicker on the emulator for a word in 200,000).
        const result = await this.db.query(
          `SELECT ${FOUND_COLUMNS.split(', ').map(column => `streams.${column}`).join(', ')}
             ${STREAMS_NAMED} AND streams.provider = ? AND streams.type = ?
            LIMIT ?`,
          [namesBeginningWith(words), this.providerUsername, type, limit]
        );
        return (result.values ?? []).map(foundStream);
      } catch {
        // A word FTS5 cannot read: as before.
      }
    }
    return this.findWhere(type, `(${words.map(() => 'name LIKE ?').join(' OR ')})`, words, limit);
  }

  /** Streams of a type whose names meet `conditions`, one `LIKE ?` per word in order. */
  private async findWhere(type: StreamType, conditions: string, words: string[], limit: number): Promise<Stream[]> {
    const parameters: (string | number)[] = [this.providerUsername, type];
    for (const word of words) {
      parameters.push('%' + word + '%');
    }
    parameters.push(limit);

    const result = await this.db.query(
      // category_id, because a search result that cannot say which category it
      // came from cannot be grouped by one: the facet chips on the results page
      // had nothing to count and offered nothing.
      `SELECT ${FOUND_COLUMNS}
         FROM streams
        WHERE provider = ? AND type = ? AND ${conditions}
        ORDER BY name
        LIMIT ?`,
      parameters
    );

    return (result.values ?? []).map(foundStream);
  }

  async markFetched(type: StreamType, categoryId: string, at: string): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO category_fetch_attempts
         (provider, type, category_id, attempted_at)
       VALUES (?, ?, ?, ?)`,
      [this.providerUsername, type, categoryId, at]
    );
  }

  /**
   * Throws the catalogue away, keeping the account's own work.
   *
   * What a subscription change calls: the line-up is no longer this one's, and
   * every row here can be fetched again. Favourites and history are not
   * touched, because those are the user's and not the provider's.
   */
  async forget(): Promise<void> {
    for (const table of ['categories', 'streams', 'category_fetch_attempts']) {
      await this.db.run(`DELETE FROM ${table} WHERE provider = ?`, [this.providerUsername]);
    }
  }
}

const FOUND_COLUMNS =
  'stream_id, name, stream_icon, epg_channel_id, added, num, container_extension, category_id, tv_archive, tv_archive_duration, extra';

/** A row of a search (FOUND_COLUMNS) as a stream. */
function foundStream(row: Record<string, unknown>): Stream {
  return {
    stream_id: String(row['stream_id']),
    name: String(row['name'] ?? ''),
    icon: String(row['stream_icon'] ?? ''),
    stream_icon: String(row['stream_icon'] ?? ''),
    epg_channel_id: row['epg_channel_id'] ?? undefined,
    added: row['added'] ?? undefined,
    num: row['num'] ?? undefined,
    container_extension: row['container_extension'] ?? undefined,
    ...archiveOf(row),
    ...extraOf(row),
    category_id: row['category_id'] ?? undefined
  } as unknown as Stream;
}

/** Catch-up, when the row says; nothing on a row stored before it was kept. */
function archiveOf(row: Record<string, unknown>): Pick<Stream, 'tv_archive' | 'tv_archive_duration'> {
  if (row['tv_archive'] === null || row['tv_archive'] === undefined) {
    return {};
  }
  return { tv_archive: Number(row['tv_archive']), tv_archive_duration: Number(row['tv_archive_duration'] ?? 0) };
}

/**
 * What only a playlist's row carries -- its address and catch-up template --
 * as one JSON column rather than a column each: an Xtream row has none of
 * them, and one column is one migration.
 */
const EXTRA_FIELDS = ['source_url', 'catchup_mode', 'catchup_source', 'portal_cmd'] as const;

function extraFor(item: Record<string, unknown>): string | null {
  const extra = Object.fromEntries(
    EXTRA_FIELDS.filter(field => item[field] !== undefined && item[field] !== null).map(field => [field, item[field]])
  );
  return Object.keys(extra).length ? JSON.stringify(extra) : null;
}

function extraOf(row: Record<string, unknown>): Record<string, string> {
  const raw = row['extra'];
  if (typeof raw !== 'string' || !raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}
