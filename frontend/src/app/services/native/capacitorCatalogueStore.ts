import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Category, Stream, StreamType } from '@shared/types';
import { CatalogueStore, GuideCandidateKeys } from '@shared/xtream/catalogue';
import { searchableSql } from '@shared/xtream/channelNames';
import { streamGuideKeys } from '@shared/xtream/guideMatching';
import {
  namesWithAny,
  namesWithEvery,
  STREAM_NAMES_FILL,
  STREAM_NAMES_FILLED,
  STREAM_NAMES_PIECE,
  STREAM_NAMES_PROGRESS,
  STREAM_NAMES_RETIRE,
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

  /** Whether `stream_words` indexes every name held (shared/xtream/streamNames.ts). */
  private namesIndexed = false;

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
      ['streams', 'extra', 'TEXT'],
      ['streams', 'guide_id', 'TEXT'],
      ['streams', 'guide_name', 'TEXT']
    ]);
    await this.db.execute(GUIDE_KEYS_SETUP);
    if ((await this.db.query('SELECT done FROM streams_guide_filled WHERE id = 1')).values?.[0]?.['done']) {
      this.guideKeysFilled = true;
    } else if (!(await this.db.query('SELECT 1 FROM streams LIMIT 1')).values?.length) {
      // Nothing held: every stream from now on is written with its keys.
      await this.markGuideKeysFilled();
    } else {
      void this.fillGuideKeys().catch(() => undefined);
    }

    try {
      await this.db.execute(STREAM_NAMES_SETUP);
    } catch {
      // No FTS5 here (the web's sql.js): titles are looked for with LIKE.
      return;
    }
    void this.indexNames().catch(() => undefined);
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
    const filled = (await this.db.query(STREAM_NAMES_FILLED)).values?.[0];
    let upto = Number(filled?.['upto'] ?? 0);
    if (!filled?.['done']) {
      const last = Number((await this.db.query('SELECT MAX(rowid) AS last FROM streams')).values?.[0]?.['last'] ?? 0);
      // `run`, not executeSet: given rows of values, executeSet writes them
      // into a VALUES list, which an INSERT ... SELECT has not got.
      for (; upto < last; upto += STREAM_NAMES_PIECE) {
        await untilIdleWork();
        await this.db.run(STREAM_NAMES_FILL, [upto, upto + STREAM_NAMES_PIECE]);
        await this.db.run(STREAM_NAMES_PROGRESS, [upto + STREAM_NAMES_PIECE, 0]);
      }
      await this.db.run(STREAM_NAMES_PROGRESS, [upto, 1]);
    }
    this.namesIndexed = true;
    await untilIdleWork();
    await this.db.execute(STREAM_NAMES_RETIRE);
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
        extraFor(item),
        ...(type === 'live' ? streamGuideKeys(item['epg_channel_id'] as string, item['name'] as string) : [null, null])
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
    // One cell of JSON, written by SQLite, rather than a row each: the plugin
    // builds a Java object for every cell, and a TV's 55,000 channels took
    // 19 s that way, 17 of them building (27 November), on every guide search.
    const result = await this.db.query(
      `SELECT json_group_array(json_object(${ALL_COLUMNS.map(column => `'${column}', ${column}`).join(', ')})) AS rows
         FROM streams
        WHERE provider = ? AND type = ?`,
      [this.providerUsername, type]
    );
    const rows = JSON.parse(String(result.values?.[0]?.['rows'] ?? '[]')) as Record<string, unknown>[];
    return rows.map(row => ({
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

  /** Looked up by the keys every live stream is written with; every live stream until those are filled. */
  async liveStreamsNear(keys: GuideCandidateKeys): Promise<Stream[]> {
    if (!this.guideKeysFilled) {
      return this.allStreams('live');
    }
    // A read per key, each through its own index: as one OR, SQLite took the
    // category index and walked every live stream, 0.6-1 s on a TV.
    const reads: string[] = [];
    const values: unknown[] = [];
    const read = (index: string, column: string, keyed: readonly string[]) => {
      if (keyed.length) {
        reads.push(
          `SELECT ${FOUND_COLUMNS} FROM streams ${index} WHERE provider = ? AND type = 'live' AND ${column} IN (${keyed.map(() => '?').join(', ')})`
        );
        values.push(this.providerUsername, ...keyed);
      }
    };
    read('INDEXED BY idx_streams_guide_id', 'guide_id', keys.looseIds);
    read('INDEXED BY idx_streams_guide_name', 'guide_name', keys.nameKeys);
    read('', 'stream_id', keys.streamIds);
    if (!reads.length) {
      return [];
    }
    const result = await this.db.query(reads.join(' UNION '), values);
    return (result.values ?? []).map(foundStream);
  }

  /** Whether every live stream held has its guide keys (`streamGuideKeys`). */
  private guideKeysFilled = false;

  /**
   * Gives the live streams held before the keys existed theirs, a piece per
   * call and only while nobody uses the app, worked out here: SQL took 14 s
   * for 55,000 channels on a TV. Then the indexes, once, while still idle.
   */
  private async fillGuideKeys(): Promise<void> {
    for (let after = 0; ; ) {
      await untilIdleWork();
      const rows =
        (
          await this.db.query(
            `SELECT rowid AS at, epg_channel_id, name FROM streams
              WHERE type = 'live' AND guide_name IS NULL AND rowid > ? ORDER BY rowid LIMIT ${GUIDE_KEYS_PIECE}`,
            [after]
          )
        ).values ?? [];
      if (rows.length) {
        const keyed = rows.map(row => [Number(row['at']), ...streamGuideKeys(row['epg_channel_id'] as string, row['name'] as string)] as const);
        const cases = keyed.map(() => 'WHEN ? THEN ?').join(' ');
        // `run`, not executeSet, which runs a DELETE with values as nothing (CLAUDE.local.md).
        await this.db.run(
          `UPDATE streams SET guide_id = CASE rowid ${cases} END, guide_name = CASE rowid ${cases} END
            WHERE rowid IN (${keyed.map(() => '?').join(', ')})`,
          [...keyed.flatMap(([at, id]) => [at, id]), ...keyed.flatMap(([at, , name]) => [at, name]), ...keyed.map(([at]) => at)]
        );
      }
      if (rows.length < GUIDE_KEYS_PIECE) {
        break;
      }
      after = Number(rows[rows.length - 1]['at']);
    }
    await untilIdleWork();
    await this.markGuideKeysFilled();
  }

  private async markGuideKeysFilled(): Promise<void> {
    await this.db.execute(GUIDE_KEYS_INDEXES);
    await this.db.run('INSERT OR REPLACE INTO streams_guide_filled (id, done) VALUES (1, 1)', []);
    this.guideKeysFilled = true;
  }

  async findStreams(type: StreamType, words: string[], limit: number, joined = false): Promise<Stream[]> {
    if (words.length === 0) {
      return [];
    }
    if (this.namesIndexed) {
      try {
        // Looked up in the word index rather than LIKE over every name: 19 s
        // on a user's TV just after a first load, its cache cold (27
        // November). Unsorted, so a word in a great many names stops at
        // `limit` rather than reading every one of them to sort.
        const result = await this.db.query(
          `SELECT ${INDEXED_COLUMNS} ${STREAMS_NAMED} AND streams.provider = ? LIMIT ?`,
          [namesWithEvery(type, words, joined), this.providerUsername, limit]
        );
        return (result.values ?? []).map(foundStream);
      } catch {
        // A word FTS5 cannot read: as before.
      }
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
          `SELECT ${INDEXED_COLUMNS} ${STREAMS_NAMED} AND streams.provider = ? LIMIT ?`,
          [namesWithAny(type, words), this.providerUsername, limit]
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

/** Live streams given their guide keys per call of `fillGuideKeys`. */
const GUIDE_KEYS_PIECE = 250;

/** Where `fillGuideKeys` keeps that it has finished. */
const GUIDE_KEYS_SETUP = 'CREATE TABLE IF NOT EXISTS streams_guide_filled (id INTEGER PRIMARY KEY CHECK (id = 1), done INTEGER NOT NULL)';

/** What `liveStreamsNear` looks streams up by: live rows only, so films and shows cost them nothing. */
const GUIDE_KEYS_INDEXES = `CREATE INDEX IF NOT EXISTS idx_streams_guide_id ON streams(provider, guide_id) WHERE type = 'live';
CREATE INDEX IF NOT EXISTS idx_streams_guide_name ON streams(provider, guide_name) WHERE type = 'live';`;

/** What `allStreams` reads of each row. */
const ALL_COLUMNS = FOUND_COLUMNS.split(', ');

/** FOUND_COLUMNS read through the word index. */
const INDEXED_COLUMNS = FOUND_COLUMNS.split(', ').map(column => `streams.${column}`).join(', ');

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
