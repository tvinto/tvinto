import { Category, Stream, StreamType } from '../../../shared/types';
import { CatalogueStore } from '../../../shared/xtream/catalogue';
import { searchableSql } from '../../../shared/xtream/channelNames';
import { db, statements } from '../utils/database';
import { describeError } from '../utils/errorHandler';

/**
 * The server's catalogue store, over the cache it already keeps.
 *
 * The counterpart to AxiosTransport: the shared Catalogue decides when to ask
 * the provider and what to keep, and this is the one part of it that knows
 * better-sqlite3. A phone will write the same class against its own driver,
 * and the policy above will not know the difference.
 *
 * One store per subscription. The catalogue belongs to the credentials that
 * fetched it, since a different line has a different line-up.
 */
export class SqliteCatalogueStore implements CatalogueStore {
  constructor(private readonly providerUsername: string) {}

  async readCategories(type: StreamType): Promise<Category[]> {
    return statements.getCategories.all(type, this.providerUsername) as Category[];
  }

  async writeCategories(type: StreamType, categories: Category[]): Promise<void> {
    const write = db.transaction(() => {
      for (const category of categories) {
        statements.insertCategory.run(
          category.category_id,
          category.category_name,
          type,
          category.parent_id ?? 0,
          this.providerUsername
        );
      }
    });

    this.tolerate(write, `Failed to cache ${categories.length} categories`);
  }

  async readStreams(type: StreamType, categoryId: string): Promise<Stream[]> {
    const rows = statements.getStreamsByCategory.all(
      categoryId,
      type,
      this.providerUsername
    ) as Array<Record<string, unknown>>;

    return rows.map(row => this.toStream(row));
  }

  /**
   * Stores what a browse had to fetch.
   *
   * Additive by design: it writes the rows for this category and touches
   * nothing else. A sync replaces a whole type at once, which is right for a
   * sync and quite wrong here -- filling one category should not disturb the
   * rest of the catalogue a device has built up.
   */
  async writeStreams(type: StreamType, categoryId: string, streams: Stream[]): Promise<void> {
    const write = db.transaction(() => {
      for (const stream of streams) {
        const row = stream as unknown as Record<string, unknown>;
        statements.insertStream.run(
          row['stream_id'],
          row['name'],
          type,
          row['stream_icon'] ?? '',
          row['epg_channel_id'] ?? null,
          categoryId,
          type,
          this.providerUsername,
          row['added'] ?? null,
          row['custom_sid'] ?? null,
          row['tv_archive'] ?? 0,
          row['direct_source'] ?? null,
          row['tv_archive_duration'] ?? 0,
          row['num'] ?? null
        );
      }
    });

    this.tolerate(write, `Failed to cache ${streams.length} streams for category ${categoryId}`);
  }

  async lastFetchedAt(type: StreamType, categoryId: string): Promise<string | null> {
    const row = db
      .prepare(
        `SELECT attempted_at FROM category_fetch_attempts
          WHERE username = ? AND type = ? AND category_id = ?`
      )
      .get(this.providerUsername, type, categoryId) as { attempted_at?: string } | undefined;

    return row?.attempted_at ?? null;
  }

  async markFetched(type: StreamType, categoryId: string, at: string): Promise<void> {
    this.tolerate(
      () =>
        db
          .prepare(
            `INSERT INTO category_fetch_attempts (username, type, category_id, attempted_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(username, type, category_id) DO UPDATE SET attempted_at = excluded.attempted_at`
          )
          .run(this.providerUsername, type, categoryId, at),
      `Failed to record a fetch of category ${categoryId}`
    );
  }

  /**
   * Runs a write, logging rather than throwing.
   *
   * Caching is a side effect of answering a request. Failing to keep what was
   * fetched is worth knowing about, but it is not worth failing the request the
   * user is actually waiting on -- they have the data either way.
   */
  private tolerate(write: () => unknown, description: string): void {
    try {
      write();
    } catch (error) {
      console.error(`${description}:`, describeError(error));
    }
  }

  /** The cached row, in the shape the rest of the app expects a stream in. */
  /**
   * Candidates for a search, narrowed in SQL.
   *
   * Prepared per call rather than once in `statements`, because the number of
   * LIKE clauses is the number of words typed and better-sqlite3 wants the
   * placeholders fixed at prepare time. The existing `searchStreams` statement
   * takes a single pattern, which cannot express "hrt" and "2" both appearing.
   *
   * Patterns are bound, never concatenated in: a channel called "100% Sport"
   * is provider-supplied text, and pasted into a LIKE it becomes a pattern
   * that matches the whole table.
   */
  async recentlyAdded(type: StreamType, limit: number): Promise<Stream[]> {
    const rows = db
      .prepare(
        `SELECT * FROM streams
          WHERE type = ? AND username = ? AND CAST(added AS INTEGER) > 0
          ORDER BY CAST(added AS INTEGER) DESC
          LIMIT ?`
      )
      .all(type, this.providerUsername, limit) as Array<Record<string, unknown>>;

    return rows.map(row => this.toStream(row));
  }

  async findStreams(type: StreamType, words: string[], limit: number, joined = false): Promise<Stream[]> {
    if (words.length === 0) {
      return [];
    }

    const column = joined ? searchableSql('name') : 'LOWER(name)';
    const conditions = words.map(() => `${column} LIKE ?`).join(' AND ');
    const rows = db
      .prepare(
        `SELECT * FROM streams
          WHERE type = ? AND username = ? AND ${conditions}
          ORDER BY name
          LIMIT ?`
      )
      .all(
        type,
        this.providerUsername,
        ...words.map(word => `%${word}%`),
        limit
      ) as Array<Record<string, unknown>>;

    return rows.map(row => this.toStream(row));
  }

  /** Any of the words, in one read of the library (Catalogue.findTitles). */
  async findStreamsWithAny(type: StreamType, words: string[], limit: number): Promise<Stream[]> {
    if (words.length === 0) {
      return [];
    }
    const rows = db
      .prepare(
        `SELECT * FROM streams
          WHERE type = ? AND username = ? AND (${words.map(() => 'LOWER(name) LIKE ?').join(' OR ')})
          LIMIT ?`
      )
      .all(type, this.providerUsername, ...words.map(word => `%${word}%`), limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.toStream(row));
  }

  private toStream(row: Record<string, unknown>): Stream {
    return {
      ...row,
      stream_id: row['stream_id'],
      name: row['name'],
      icon: row['stream_icon'] ?? '',
      stream_icon: row['stream_icon'] ?? '',
      // Catch-up is played on devices only, so a row here that never said is
      // taken as saying no -- rather than having Catalogue.streams fetch a
      // synced category again to find out (see storedBeforeKept).
      ...(row['type'] === 'live'
        ? { tv_archive: Number(row['tv_archive'] ?? 0), tv_archive_duration: Number(row['tv_archive_duration'] ?? 0) }
        : {})
    } as unknown as Stream;
  }
}
