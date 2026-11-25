import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Category, Stream, StreamType } from '@shared/types';
import { CatalogueStore } from '@shared/xtream/catalogue';
import { searchableSql } from '@shared/xtream/channelNames';
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

      -- For the name searches (findWhere): a LIKE '%word%' still reads every
      -- name, but here in name order, so with no sort and no seek into the
      -- table for a name that does not match. Without it SQLite went through
      -- idx_streams_category, a seek per row: a search of 200,000 films was
      -- 450 ms on a PC and 16 s on a user's TV; with it, 40 ms (26 November).
      CREATE INDEX IF NOT EXISTS idx_streams_name
        ON streams(provider, type, name);

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
            statement: `INSERT OR REPLACE INTO streams
                          (provider, type, category_id, stream_id, name, stream_icon,
                           epg_channel_id, added, num, container_extension,
                           tv_archive, tv_archive_duration, extra)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  /** Any of the words, in one read of the library (Catalogue.findTitles). */
  async findStreamsWithAny(type: StreamType, words: string[], limit: number): Promise<Stream[]> {
    if (words.length === 0) {
      return [];
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
      `SELECT stream_id, name, stream_icon, epg_channel_id, added, num, container_extension, category_id,
              tv_archive, tv_archive_duration, extra
         FROM streams
        WHERE provider = ? AND type = ? AND ${conditions}
        ORDER BY name
        LIMIT ?`,
      parameters
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
      category_id: row['category_id'] ?? undefined
    })) as Stream[];
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
