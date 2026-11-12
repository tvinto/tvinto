import axios, { AxiosInstance, AxiosError } from 'axios';
import zlib from 'zlib';
import { Category, CategorySort, isSyncStatusRecord, Stream, StreamSort, StreamType, SyncStatus, SyncStatusRecord, SyncStatusState, SyncTypeDetail, EPGListing, SeriesInfo } from '../../../shared/types';
import { config } from '../config/config';
import { AppError, describeError } from '../utils/errorHandler';
import { db, statements } from '../utils/database';
import { syncService } from './sync.service';
import { syncNow } from '../utils/syncClock';
import { processEPGListings } from '../../../shared/xtream/epg';
import { parseXmltv } from '../../../shared/xtream/xmltv';
import { SyncController } from '../types/api.types';
import { XtreamCredentials } from '../utils/sessions';
import { AuthResponse, XtreamClient } from '../../../shared/xtream/client';
import { Catalogue } from '../../../shared/xtream/catalogue';
import { XtreamTransport } from '../../../shared/xtream/transport';
import { AxiosTransport } from './axiosTransport';
import { SqliteCatalogueStore } from './sqliteCatalogueStore';
import {
  categoryScope,
  sortCategories,
  sortStreams,
  streamScope
} from '../../../shared/xtream/ordering';
import {
  XtreamError,
  buildPlaybackUrl as buildProviderPlaybackUrl,
  resolveApiUrl,
  isProviderUnreachable as isUnreachableStatus
} from '../../../shared/xtream/protocol';

/** Raised when a sync is cancelled mid-flight so callers can distinguish it from a failure. */
/** A row of the `streams` table, as `SELECT *` reads it (utils/database.ts). */
interface StreamRow {
  stream_id: string;
  name: string;
  stream_type: string | null;
  stream_icon: string | null;
  epg_channel_id: string | null;
  category_id: string;
  type: StreamType;
  username: string;
  added: string | null;
  custom_sid: string | null;
  tv_archive: number | null;
  direct_source: string | null;
  tv_archive_duration: number | null;
  num: number | null;
}

/** A stream as a sync collects it, with the category it was asked for under. */
type SyncedStream = Stream & { categoryId: string; username: string };

/** A row of the `epg_listings` table: times as ISO strings. */
export interface EPGRow {
  id: number;
  epg_channel_id: string;
  start: string;
  stop: string;
  title: string | null;
  description: string | null;
  lang: string | null;
  username: string;
}

/** Which guide channel a stream is on. */
interface StreamChannelRow {
  stream_id: string;
  epg_channel_id: string | null;
}

/** One programme as a provider's short EPG gives it, in any of its spellings. */
interface ProviderListing {
  title?: string;
  description?: string;
  desc?: string;
  lang?: string;
  start?: string | number;
  stop?: string | number;
  start_timestamp?: string | number;
  stop_timestamp?: string | number;
}

export class SyncCancelledError extends Error {
  constructor() {
    super('Sync cancelled by user');
    this.name = 'SyncCancelledError';
  }
}

/**
 * Who is asking, and whose catalogue they are asking about.
 *
 * Two owners travel together on every browse. The account owns favourites,
 * arranging and history, and outlives any subscription. The provider
 * credentials own the catalogue and expire. They are passed as one object
 * because both halves are strings, both are called a username in their own
 * table, and swapping them would quietly show one person another's list.
 */
export interface Viewer {
  /** The account. Personal data is keyed to this and nothing else. */
  userId: number;
  /** The subscription whose catalogue is being read. */
  providerUsername: string;
  providerPassword: string;
  serverUrl?: string;
}

/** The most an external guide may be, as sent. */
const MAX_EXTERNAL_EPG_BYTES = 50 * 1024 * 1024;

/**
 * Whether a host is this machine or a private network, by name or literal
 * address. A name that resolves there is not caught; this backend fetches
 * only for a signed-in caller, and redirects are not followed.
 */
const isPrivateHost = (host: string): boolean => {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')) {
    return true;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return name === '::1' || name === '::' || /^(fc|fd|fe80|::ffff:)/.test(name);
};

class XtreamService {
  private api: AxiosInstance;
  /** How the shared client reaches the provider from here. */
  private readonly transport: XtreamTransport;
  private defaultBaseUrl: string;
  private readonly allStreamTypes: StreamType[] = ['series', 'live', 'vod'];
  private readonly activeSyncs = new Map<string, SyncController>();

  constructor() {
    this.defaultBaseUrl = config.xtreamBaseUrl || '';
    this.api = axios.create({
      timeout: 10000, // 10 seconds
      headers: {
        'User-Agent': 'IPTV-Xtream-Loader/1.0',
        'Accept': 'application/json'
      }
    });
    // Built over this instance rather than its own, so the one place tests
    // stub to stay off the network still covers everything.
    this.transport = new AxiosTransport(this.api);
  }

  /** A conversation with one account, over this server's transport. */
  private clientFor(
    username: string,
    password: string,
    serverUrl?: string,
    timeoutMs?: number
  ): XtreamClient {
    return this.rethrow(
      () =>
        new XtreamClient(
          this.transport,
          { serverUrl: serverUrl || this.defaultBaseUrl, username, password },
          timeoutMs
        )
    );
  }

  /**
   * Runs a call to the provider, restating its failures as this app's own.
   *
   * The shared client speaks XtreamError because it is compiled into clients
   * that have never heard of AppError. Everything above here checks for
   * AppError, so the translation happens at the one boundary.
   */
  private async viaProvider<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof XtreamError) {
        throw new AppError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  /**
   * Builds the provider playback URL for a stream. Xtream embeds the
   * credentials in the path, which is why this is resolved server-side and
   * never handed to the browser.
   */
  buildPlaybackUrl(
    credentials: XtreamCredentials,
    type: StreamType,
    streamId: string,
    extension?: string
  ): string {
    return this.rethrow(() =>
      buildProviderPlaybackUrl(
        credentials.serverUrl ?? this.defaultBaseUrl,
        credentials,
        type,
        streamId,
        extension
      )
    );
  }

  /**
   * The container a film is stored in, asked of the provider and remembered.
   *
   * Only for films. Live is always the .m3u8 the protocol layer supplies, and
   * an episode carries its own container in the series info it came from --
   * which is exactly why episodes have always played and films have not.
   *
   * Cached in the streams table because the answer never changes for a given
   * film and the alternative is a request before every play. A film that has
   * never been played is one request the first time and none after.
   */
  async vodExtensionFor(credentials: XtreamCredentials, streamId: string): Promise<string | null> {
    const cached = db
      .prepare(
        `SELECT container_extension FROM streams
          WHERE username = ? AND stream_id = ? AND type = 'vod'`
      )
      .get(credentials.username, String(streamId)) as { container_extension?: string } | undefined;

    if (cached?.container_extension) {
      return cached.container_extension;
    }

    const client = this.clientFor(credentials.username, credentials.password, credentials.serverUrl);
    const extension = await this.viaProvider(() =>
      client.getVodContainerExtension(String(streamId))
    );

    if (extension) {
      db.prepare(
        `UPDATE streams SET container_extension = ?
          WHERE username = ? AND stream_id = ? AND type = 'vod'`
      ).run(extension, credentials.username, String(streamId));
    }

    return extension;
  }

  private resolveBaseUrl(serverUrl?: string): string {
    return this.rethrow(() => resolveApiUrl(serverUrl || this.defaultBaseUrl));
  }

  /**
   * Runs shared protocol code and restates its failures as this app's own.
   *
   * The shared module cannot import AppError -- it is compiled into the client
   * too, which has no such thing. Translating at the boundary keeps the error
   * handling here working on the type it already checks for.
   */
  private rethrow<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof XtreamError) {
        throw new AppError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  async authenticate(username: string, password: string, serverUrl?: string): Promise<AuthResponse> {
    try {
      const client = this.clientFor(username, password, serverUrl);

      const response = await this.viaProvider(() => client.authenticate());

      return response;
    } catch (error) {
      console.error('Authentication error:', describeError(error));
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Failed to authenticate with Xtream server', 502);
    }
  }

  /**
   * Categories for browsing, served from the local cache when it has been
   * synced for this user and type. Falls back to the provider when the cache
   * is empty so a user who has never synced still sees content.
   */
  async getCategories(
    viewer: Viewer,
    type: StreamType,
    sort: CategorySort = 'name_asc'
  ): Promise<Category[]> {
    const categories = await this.viaProvider(() => this.catalogueFor(viewer).categories(type));
    return this.applyCategorySort(categories, viewer.userId, type, sort);
  }

  /**
   * The catalogue as this subscription sees it: cache first, provider only
   * when it must.
   *
   * The deciding is shared with the clients, so a phone filling its own
   * database asks the provider in exactly the same pattern this does -- which
   * matters, because the pattern is what an address gets blocked for.
   */
  private catalogueFor(viewer: Viewer): Catalogue {
    return new Catalogue(
      this.clientFor(viewer.providerUsername, viewer.providerPassword, viewer.serverUrl),
      new SqliteCatalogueStore(viewer.providerUsername)
    );
  }

  /**
   * The ordering itself is shared; what is local is where the arrangement is
   * kept. Only a manual sort needs one, so only a manual sort reads the table.
   */
  private applyCategorySort(
    categories: Category[],
    userId: number,
    type: StreamType,
    sort: CategorySort
  ): Category[] {
    const arrangement =
      sort === 'manual' ? this.getManualOrder(userId, categoryScope(type)) : [];
    return sortCategories(categories, sort, arrangement);
  }

  private applyStreamSort(
    streams: Stream[],
    userId: number,
    type: StreamType,
    categoryId: string | undefined,
    sort: StreamSort
  ): Stream[] {
    const arrangement =
      sort === 'manual' && categoryId
        ? this.getManualOrder(userId, streamScope(type, categoryId))
        : [];
    return sortStreams(streams, sort, arrangement);
  }

  /**
   * The user's favourite streams for a type, hydrated from the cache.
   *
   * A favourite outlives the row it points at: a later sync can drop a channel
   * the provider removed. Those are skipped rather than surfaced as blanks.
   */
  getFavorites(viewer: Viewer, type: StreamType, sort: StreamSort = 'name_asc'): Stream[] {
    const ids = this.getFavoriteIds(viewer.userId, type);
    if (ids.length === 0) {
      return [];
    }

    // The favourites are the account's; the rows they name are the
    // subscription's. Both owners appear in this one query, which is the whole
    // shape of the thing in miniature.
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM streams WHERE username = ? AND type = ? AND stream_id IN (${placeholders})`
      )
      .all(viewer.providerUsername, type, ...ids) as StreamRow[];

    const streams = rows.map(row => this.mapCachedRowToStream(row));
    return this.applyStreamSort(streams, viewer.userId, type, undefined, sort);
  }

  getFavoriteIds(userId: number, type: StreamType): string[] {
    const rows = db
      .prepare('SELECT stream_id FROM favorites WHERE user_id = ? AND type = ? ORDER BY created_at')
      .all(userId, type) as Array<{ stream_id: string }>;
    return rows.map(r => String(r.stream_id));
  }

  /**
   * Marks a favourite.
   *
   * The name is stored beside the id because the id belongs to the provider.
   * Renew with the same one and ids survive; change provider and they mean
   * nothing, and the name is then the only way to find what this used to be.
   */
  addFavorite(userId: number, type: StreamType, streamId: string, name?: string): void {
    const now = syncNow();
    db.prepare(
      `INSERT INTO favorites (user_id, stream_id, type, name, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, stream_id, type) DO UPDATE SET
         name = COALESCE(excluded.name, favorites.name),
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`
    ).run(userId, String(streamId), type, name ?? null, now, now);

    // Starring something again undoes any record of it having been removed.
    syncService.recordUndelete(userId, 'favourite', syncService.favouriteKey(type, streamId));
  }

  removeFavorite(userId: number, type: StreamType, streamId: string): void {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND stream_id = ? AND type = ?').run(
      userId,
      String(streamId),
      type
    );

    // Without this the row is gone here and still present on the phone, which
    // would push it back at the next sync.
    syncService.recordDeletion(userId, 'favourite', syncService.favouriteKey(type, streamId));
  }

  getManualOrder(userId: number, scope: string): string[] {
    const rows = db
      .prepare('SELECT item_id FROM sort_order WHERE user_id = ? AND scope = ? ORDER BY position')
      .all(userId, scope) as Array<{ item_id: string }>;
    return rows.map(r => r.item_id);
  }

  /** Names travel with positions for the same reason they do with favourites. */
  saveManualOrder(
    userId: number,
    scope: string,
    itemIds: string[],
    namesById: Record<string, string> = {}
  ): void {
    const now = syncNow();
    const replace = db.transaction(() => {
      db.prepare('DELETE FROM sort_order WHERE user_id = ? AND scope = ?').run(userId, scope);
      const insert = db.prepare(
        `INSERT INTO sort_order (user_id, scope, item_id, position, name, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      itemIds.forEach((id, index) =>
        insert.run(userId, scope, String(id), index, namesById[String(id)] ?? null, now, now)
      );

      // An emptied arrangement leaves no rows to carry a timestamp, so the
      // fact of the clearing has to be recorded somewhere of its own.
      if (itemIds.length === 0) {
        syncService.recordDeletion(userId, 'arrangement', scope, now);
      } else {
        syncService.recordUndelete(userId, 'arrangement', scope);
      }
    });
    replace();
  }

  private toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Fetches categories directly from the Xtream provider, bypassing the cache.
   * Used by sync, which must not read back what it is populating.
   */
  async fetchCategoriesFromApi(
    username: string,
    password: string,
    type: StreamType,
    serverUrl?: string,
    timeoutMs?: number
  ): Promise<Category[]> {
    const client = this.clientFor(username, password, serverUrl, timeoutMs);
    return this.viaProvider(() => client.getCategories(type));
  }

  /**
   * Streams for browsing, served from the local cache when available.
   * Falls back to the provider when nothing is cached for this category.
   */
  async getStreams(
    viewer: Viewer,
    type: StreamType,
    categoryId?: string,
    sort: StreamSort = 'name_asc'
  ): Promise<Stream[]> {
    // Without a category there is nothing to cache against, so this is a
    // straight pass-through to the provider. Every browse names one.
    if (!categoryId) {
      const everything = await this.fetchStreamsFromApi(
        viewer.providerUsername,
        viewer.providerPassword,
        type,
        undefined,
        viewer.serverUrl
      );
      return this.applyStreamSort(everything, viewer.userId, type, undefined, sort);
    }

    // Cache first, provider once, and a category that comes back empty is
    // remembered as having been asked -- so the emptiness costs one request
    // rather than one on every visit. On this account 54% of live categories
    // were empty, and each was being refetched every time it was opened.
    const streams = await this.viaProvider(() =>
      this.catalogueFor(viewer).streams(type, categoryId)
    );

    return this.applyStreamSort(streams, viewer.userId, type, categoryId, sort);
  }

  /**
   * Stores streams a browse request had to fetch, so the next visit is served
   * from disk.
   *
   * Additive: it inserts the rows for this category and touches nothing else,
   * unlike sync, which swaps a whole type at once. A failure here is not worth
   * failing the request the user is waiting on, so it is logged and swallowed.
   */
  private cacheStreamsForCategory(
    username: string,
    type: StreamType,
    categoryId: string,
    streams: Stream[]
  ): void {
    try {
      const insert = db.prepare(
        'INSERT OR REPLACE INTO streams (stream_id, name, type, category_id, stream_icon, epg_channel_id, added, num, username) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      const store = db.transaction(() => {
        for (const stream of streams) {
          insert.run(
            stream.stream_id,
            stream.name,
            type,
            categoryId,
            stream.stream_icon || '',
            stream.epg_channel_id || null,
            stream.added || new Date().toISOString(),
            this.toNumberOrNull(stream.num),
            username
          );
        }
      });

      store();
    } catch (error) {
      console.error('Failed to cache fetched streams:', describeError(error));
    }
  }

  private getStreamsFromCache(
    username: string,
    type: StreamType,
    categoryId: string
  ): Stream[] {
    const rows = statements.getStreamsByCategory.all(
      categoryId,
      type,
      username
    ) as StreamRow[];

    return rows.map(row => this.mapCachedRowToStream(row));
  }

  /**
   * Fetches streams directly from the Xtream provider, bypassing the cache.
   * Used by sync, which must not read back what it is populating.
   */
  async fetchStreamsFromApi(
    username: string,
    password: string,
    type: StreamType,
    categoryId?: string,
    serverUrl?: string,
    timeoutMs?: number
  ): Promise<Stream[]> {
    const client = this.clientFor(username, password, serverUrl, timeoutMs);
    const streams = await this.viaProvider(() => client.getStreams(type, categoryId));

    if (type === 'series') {
      console.debug(
        `Normalized series items count: ${streams.length} (category ${categoryId ?? 'none'})`
      );
    }

    return streams;
  }

  async searchStreamsInDatabase(query: string, types: StreamType[], username: string): Promise<Stream[]> {
    try {
      const searchTerm = `%${query.toLowerCase()}%`;

      // Sync stores the StreamType verbatim, so no remapping is needed here.
      const dbTypes: string[] = [...types];

      const placeholders = dbTypes.map(() => '?').join(',');
      
      const query_sql = `
        SELECT * FROM streams 
        WHERE username = ? 
        AND type IN (${placeholders})
        AND LOWER(name) LIKE ?
        ORDER BY name
      `;
      
      const stmt = db.prepare(query_sql);
      const rows = stmt.all(username, ...dbTypes, searchTerm) as StreamRow[];


      return rows.map(row => this.mapCachedRowToStream(row));
    } catch (error) {
      console.error('Error searching streams in database:', error);
      throw new AppError('Database search failed: ' + (error as Error).message, 500);
    }
  }

  /** Shapes a cached `streams` row into the Stream contract the frontend expects. */
  private mapCachedRowToStream(row: StreamRow): Stream {
    return {
      stream_id: row.stream_id,
      name: row.name,
      icon: row.stream_icon || '', // Map stream_icon to icon
      stream_icon: row.stream_icon,
      stream_type: row.stream_type,
      epg_channel_id: row.epg_channel_id,
      category_id: row.category_id,
      type: row.type,
      username: row.username,
      added: row.added,
      num: row.num,
      custom_sid: row.custom_sid,
      tv_archive: row.tv_archive,
      direct_source: row.direct_source,
      tv_archive_duration: row.tv_archive_duration
    } as Stream;
  }

  async syncData(
    type: StreamType | undefined,
    username: string,
    password: string,
    serverUrl?: string
  ): Promise<{ 
    success: boolean; 
    message?: string; 
    syncedItems?: number;
    details?: SyncTypeDetail[];
  }> {
    // One sync per account at a time. A second one used to overwrite the
    // first's controller here, which left the first running with nothing
    // holding its handle -- uncancellable, and doubling the request rate the
    // provider sees until it started timing categories out.
    if (this.activeSyncs.has(username)) {
      throw new AppError('A sync is already running for this account', 409);
    }

    const controller: SyncController = { cancelled: false };
    this.activeSyncs.set(username, controller);

    try {
      if (!type) {
        const details: SyncTypeDetail[] = [];
        let totalSynced = 0;
        let overallSuccess = true;

        for (const streamType of this.allStreamTypes) {
          if (controller.cancelled) {
            throw new SyncCancelledError();
          }
          const result = await this.syncDataForType(
            streamType,
            username,
            password,
            serverUrl,
            controller
          );
          details.push(result);
          totalSynced += result.syncedItems || 0;
          if (!result.success) {
            overallSuccess = false;
          }
        }

        const message = overallSuccess
          ? 'Synced all stream types successfully'
          : 'Completed sync with some errors. Check details for more information.';

        return {
          success: overallSuccess,
          message,
          syncedItems: totalSynced,
          details
        };
      }

      const singleResult = await this.syncDataForType(
        type,
        username,
        password,
        serverUrl,
        controller
      );
      return {
        success: singleResult.success,
        message: singleResult.message,
        syncedItems: singleResult.syncedItems,
        details: [singleResult]
      };
    } finally {
      this.activeSyncs.delete(username);
    }
  }

  /**
   * Flags a running sync for cancellation.
   * @returns true if a sync was actually running for this user.
   */
  cancelSync(username: string): boolean {
    const controller = this.activeSyncs.get(username);
    if (!controller) {
      return false;
    }
    controller.cancelled = true;
    this.activeSyncs.delete(username);
    return true;
  }

  private async syncDataForType(
    type: StreamType,
    username: string,
    password: string,
    serverUrl?: string,
    controller?: SyncController
  ): Promise<SyncTypeDetail> {
    // Mark the sync as running. Existing cached rows are deliberately left in
    // place: browsing reads them, so they are only replaced once the provider
    // has actually returned data (see insertTransaction below).
    const transaction = db.transaction(() => {
      try {
        db.prepare(
          'INSERT OR REPLACE INTO sync_status (username, type, status, last_sync, total_streams, total_categories) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(username, type, SyncStatusState.SYNCING, new Date().toISOString(), 0, 0);

        return true;
      } catch (error) {
        console.error('Database cleanup error:', error);
        return false;
      }
    });

    if (!transaction()) {
      return {
        type,
        success: false,
        message: 'Failed to prepare database for sync',
        syncedItems: 0,
        totalCategories: 0
      };
    }

    let totalStreams = 0;
    let categories: Category[] = [];
    let failedCategories = 0;

    try {
      console.info(`Sync of ${type} started`);
      
      // Get all categories first. Sync must bypass the cache it is refilling.
      // The same generous timeout as the stream fetches below. This one list is
      // the whole run's starting point, so losing it to a ten second default
      // fails the sync before it has asked for anything.
      categories = await this.fetchCategoriesFromApi(
        username,
        password,
        type,
        serverUrl,
        config.sync.requestTimeoutMs
      );
      
      // How many categories are requested at once. Too many and the provider
      // times them out, and a timed-out category is stored as empty.
      const BATCH_SIZE = Math.max(1, config.sync.categoryConcurrency);
      // How many batches may fail outright before the run gives up. One covers
      // a blip; a second in a row means the provider is not answering us.
      const DEAD_BATCH_LIMIT = 2;
      let deadBatches = 0;
      const allStreamsData: SyncedStream[] = [];
      
      for (let i = 0; i < categories.length; i += BATCH_SIZE) {
        if (controller?.cancelled) {
          throw new SyncCancelledError();
        }

        const batch = categories.slice(i, i + BATCH_SIZE);
        
        // Fetch streams for all categories in this batch in parallel
        const batchPromises = batch.map(async (category) => {
          const attempts = Math.max(1, config.sync.retries + 1);

          for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
              const streams = await this.fetchStreamsFromApi(
                username,
                password,
                type,
                category.category_id,
                serverUrl,
                config.sync.requestTimeoutMs
              );

              // Add category info to each stream
              return {
                failed: false,
                streams: streams.map(stream => ({
                  ...stream,
                  categoryId: category.category_id,
                  type,
                  username
                }))
              };
            } catch (error) {
              // A provider that is refusing or unreachable will refuse the
              // retry too; asking again only adds to the load that is being
              // refused.
              const worthRetrying = attempt < attempts && !this.isProviderUnreachable(error);
              if (worthRetrying) {
                // A timeout under load is usually transient; backing off and
                // asking once more is cheaper than leaving the category empty.
                await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                continue;
              }

              // Counted, not just logged: a run that quietly skipped half the
              // categories used to report success, and every category it missed
              // then hit the provider on every visit for good.
              failedCategories++;
              console.warn(
                `Skipping category ${category.category_name}:`,
                describeError(error)
              );
              return { failed: true, streams: [] as SyncedStream[] };
            }
          }

          return { failed: true, streams: [] as SyncedStream[] };
        });

        // Wait for all requests in this batch to complete
        const batchOutcomes = await Promise.all(batchPromises);

        // A whole batch failing means the provider is not serving this run at
        // all. Grinding on through the remaining categories cannot succeed and
        // is exactly the traffic that gets an address blocked, so the run stops
        // and says why.
        if (batchOutcomes.every(outcome => outcome.failed)) {
          deadBatches++;
          if (deadBatches >= DEAD_BATCH_LIMIT) {
            throw new AppError(
              `Provider stopped serving this sync: ${deadBatches} consecutive batches ` +
                `failed entirely after ${i + batch.length} of ${categories.length} categories. ` +
                'Stopped rather than keep asking.',
              502
            );
          }
        } else {
          deadBatches = 0;
        }

        const batchResults = batchOutcomes.map(outcome => outcome.streams);

        // Collect all streams from this batch
        batchResults.forEach(streams => {
          allStreamsData.push(...streams);
        });
        
        totalStreams = allStreamsData.length;
        
        // Update sync status with progress
        db.prepare(
          'UPDATE sync_status SET last_sync = ?, total_streams = ?, total_categories = ? WHERE username = ? AND type = ?'
        ).run(new Date().toISOString(), totalStreams, categories.length, username, type);
        
        // Small delay between batches to avoid rate limiting
        if (i + BATCH_SIZE < categories.length) {
          await new Promise(resolve => setTimeout(resolve, config.sync.delayBetweenBatchesMs));
        }
      }
      
      // Insert everything in a single transaction for better performance
      
      const insertTransaction = db.transaction(() => {
        // Swap old rows for new atomically, so a failed fetch never leaves the
        // cache empty for a type that browsing depends on.
        db.prepare('DELETE FROM streams WHERE type = ? AND username = ?').run(type, username);
        db.prepare('DELETE FROM categories WHERE type = ? AND username = ?').run(type, username);

        // Insert categories
        const insertCategory = db.prepare(
          'INSERT OR REPLACE INTO categories (category_id, category_name, type, parent_id, username) VALUES (?, ?, ?, ?, ?)'
        );
        
        for (const category of categories) {
          insertCategory.run(
            category.category_id,
            category.category_name,
            type,
            category.parent_id || null,
            username
          );
        }
        
        // Insert streams. `num` is the provider's channel number and the only
        // basis for ordering a list the way the provider intends, so it is
        // stored even though nothing else reads it.
        const insertStream = db.prepare(
          'INSERT OR REPLACE INTO streams (stream_id, name, type, category_id, stream_icon, epg_channel_id, added, num, username) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );

        for (const stream of allStreamsData) {
          insertStream.run(
            stream.stream_id,
            stream.name,
            type,
            stream.categoryId,
            stream.stream_icon || '',
            stream.epg_channel_id || null,
            stream.added || new Date().toISOString(),
            this.toNumberOrNull(stream.num),
            username
          );
        }
      });
      
      insertTransaction();
      
      // Mark sync as complete
      db.prepare(
        'UPDATE sync_status SET status = ?, last_sync = ?, total_streams = ?, total_categories = ? WHERE username = ? AND type = ?'
      ).run(SyncStatusState.SYNCED, new Date().toISOString(), totalStreams, categories.length, username, type);
      
      const reached = categories.length - failedCategories;
      console.info(
        `Sync completed. ${totalStreams} streams across ${reached}/${categories.length} categories` +
          (failedCategories > 0 ? `, ${failedCategories} unreachable` : '')
      );

      return {
        type,
        // A run that could not reach some categories has not fully synced them,
        // and saying so is what prompts a retry rather than leaving the gaps to
        // be discovered one slow category at a time.
        success: failedCategories === 0,
        message:
          failedCategories === 0
            ? `Synced ${totalStreams} streams across ${categories.length} categories`
            : `Synced ${totalStreams} streams across ${reached} of ${categories.length} categories; ` +
              `${failedCategories} could not be reached and will load from the provider until re-synced`,
        syncedItems: totalStreams,
        totalCategories: categories.length
      };

    } catch (error) {
      if (error instanceof SyncCancelledError) {
        db.prepare(
          'UPDATE sync_status SET status = ? WHERE username = ? AND type = ?'
        ).run(SyncStatusState.CANCELLED, username, type);
        throw error;
      }

      // Update sync status to error
      db.prepare(
        'UPDATE sync_status SET status = ? WHERE username = ? AND type = ?'
      ).run(SyncStatusState.ERROR, username, type);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error during sync';
      console.error('Sync error:', describeError(error));
      return {
        type,
        success: false,
        message: `Sync failed: ${errorMessage}`,
        syncedItems: 0,
        totalCategories: 0
      };
    }
  }

  private getSyncStatusRecord(type: StreamType, username: string): SyncStatusRecord | null {
    const result = db.prepare(
      'SELECT last_sync, status, total_streams, total_categories, type FROM sync_status WHERE username = ? AND type = ?'
    ).get(username, type);

    if (isSyncStatusRecord(result)) {
      return result;
    }
    return null;
  }

  /**
   * Reports what is actually browsable, not what the last sync attempt did.
   *
   * The counts come from the cache rather than the sync_status row: that column
   * is written incrementally as a progress indicator, so a run that is
   * cancelled or fails leaves it holding a partial figure while the previous
   * complete data is still on disk. `synced` likewise follows the data, so a
   * cancelled run does not hide a perfectly good cache from the UI. The
   * `status` field still carries the outcome of the last attempt.
   */
  async getSyncStatus(
    type: StreamType,
    username: string
  ): Promise<SyncStatus> {
    try {
      const status = this.getSyncStatusRecord(type, username);
      const cached = this.getCachedCounts(type, username);

      return {
        synced: cached.streams > 0,
        lastSync: status?.last_sync || '',
        totalStreams: cached.streams,
        totalCategories: cached.categories,
        status: status?.status || SyncStatusState.NOT_SYNCED
      };

    } catch (error) {
      console.error('Error getting sync status:', describeError(error));
      return {
        synced: false,
        lastSync: '',
        totalStreams: 0,
        totalCategories: 0,
        status: SyncStatusState.ERROR
      };
    }
  }

  /** How much of this user's data for a type is actually cached right now. */
  private getCachedCounts(
    type: StreamType,
    username: string
  ): { streams: number; categories: number } {
    const streams = db
      .prepare('SELECT COUNT(*) AS n FROM streams WHERE username = ? AND type = ?')
      .get(username, type) as { n: number };
    const categories = db
      .prepare('SELECT COUNT(*) AS n FROM categories WHERE username = ? AND type = ?')
      .get(username, type) as { n: number };

    return { streams: streams.n, categories: categories.n };
  }

  async getStreamInfo(
    username: string,
    password: string,
    streamId: string,
    type: StreamType,
    serverUrl?: string
  ): Promise<EPGListing> {
    const client = this.clientFor(username, password, serverUrl);
    return this.viaProvider(
      () => client.getShortEPG(streamId) as Promise<EPGListing>
    );
  }

  private toIsoDateTime(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'number') {
      const ms = value > 1e12 ? value : value * 1000;
      return new Date(ms).toISOString();
    }
    if (typeof value === 'string') {
      // Try parse numeric string
      const num = Number(value);
      if (!Number.isNaN(num)) {
        const ms = num > 1e12 ? num : num * 1000;
        return new Date(ms).toISOString();
      }
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return new Date().toISOString();
  }

  private saveEPGForStream(username: string, streamId: string, epg: EPGListing): void {
    if (!epg || !Array.isArray(epg.epg_listings)) return;
    const row = db.prepare('SELECT epg_channel_id FROM streams WHERE stream_id = ? AND username = ? LIMIT 1').get(streamId, username) as Pick<StreamChannelRow, 'epg_channel_id'> | undefined;
    const epgChannelId = row?.epg_channel_id ?? undefined;
    if (!epgChannelId) return;
    const listings = epg.epg_listings as ProviderListing[];
    const insert = statements.upsertEPGListing;
    const nowUsername = username;
    const tx = db.transaction(() => {
      for (const item of listings) {
        const title = item.title ?? '';
        const description = item.description ?? item.desc ?? '';
        const lang = item.lang ?? '';
        const start = this.toIsoDateTime(item.start_timestamp ?? item.start);
        const stop = this.toIsoDateTime(item.stop_timestamp ?? item.stop);
        insert.run(epgChannelId, start, stop, title, description, lang, nowUsername);
      }
    });
    tx();
  }

  async getNowEPGForUser(username: string): Promise<EPGRow[]> {
    const nowIso = new Date().toISOString();
    return statements.getEPGNowForUser.all(username, nowIso, nowIso) as EPGRow[];
  }

  async getNowEPGForStreamIds(username: string, streamIds: string[]): Promise<Record<string, EPGRow | undefined>> {
    if (!streamIds.length) return {};
    const placeholders = streamIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT stream_id, epg_channel_id FROM streams WHERE username = ? AND stream_id IN (${placeholders})`).all(username, ...streamIds) as StreamChannelRow[];
    const channelIds = rows.map(r => r.epg_channel_id).filter(Boolean);
    if (!channelIds.length) return {};
    const nowIso = new Date().toISOString();
    const chPlaceholders = channelIds.map(() => '?').join(',');
    const epgRows = db.prepare(`SELECT * FROM epg_listings WHERE username = ? AND epg_channel_id IN (${chPlaceholders}) AND start <= ? AND stop >= ?`).all(username, ...channelIds, nowIso, nowIso) as EPGRow[];
    const byChannel: Record<string, EPGRow> = {};
    for (const r of epgRows) byChannel[r.epg_channel_id] = r;
    const result: Record<string, EPGRow | undefined> = {};
    for (const r of rows) {
      result[String(r.stream_id)] = r.epg_channel_id ? byChannel[r.epg_channel_id] : undefined;
    }
    return result;
  }

  async pruneOldEPG(username: string, olderThanHours: number = 72): Promise<number> {
    const thresholdIso = new Date(Date.now() - olderThanHours * 3600 * 1000).toISOString();
    const stmt = db.prepare('DELETE FROM epg_listings WHERE username = ? AND stop < ?');
    const info = stmt.run(username, thresholdIso);
    return info.changes || 0;
  }

  async refreshEPGForStreamIds(
    username: string,
    password: string,
    streamIds: string[],
    serverUrl?: string,
    ttlHours: number = 2
  ): Promise<{ refreshed: string[]; skipped: string[] }> {
    if (!streamIds.length) return { refreshed: [], skipped: [] };
    const placeholders = streamIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT stream_id, epg_channel_id FROM streams WHERE username = ? AND stream_id IN (${placeholders})`).all(username, ...streamIds) as StreamChannelRow[];
    const byStream: Record<string, string | undefined> = {};
    for (const r of rows) byStream[String(r.stream_id)] = r.epg_channel_id ?? undefined;
    const refreshed: string[] = [];
    const skipped: string[] = [];
    const ttlMs = ttlHours * 3600 * 1000;
    for (const sid of streamIds) {
      const channel = byStream[String(sid)];
      if (!channel) {
        skipped.push(String(sid));
        continue;
      }
      const latest = db.prepare('SELECT MAX(start) as max_start FROM epg_listings WHERE username = ? AND epg_channel_id = ?').get(username, channel) as { max_start: string | null } | undefined;
      let needsRefresh = true;
      if (latest?.max_start) {
        const lastStart = new Date(latest.max_start).getTime();
        if (!Number.isNaN(lastStart)) {
          needsRefresh = Date.now() - lastStart > ttlMs;
        }
      }
      if (!needsRefresh) {
        skipped.push(String(sid));
        continue;
      }
      try {
        await this.getEPGShort(username, password, String(sid), serverUrl);
        refreshed.push(String(sid));
      } catch {
        skipped.push(String(sid));
      }
    }
    return { refreshed, skipped };
  }

  /**
   * Channels whose guide should be topped up next, favourites first.
   *
   * Only live channels carry an EPG worth showing, and only those the provider
   * tagged with a channel id can be asked about at all. A channel whose guide
   * already reaches far enough ahead is left alone.
   *
   * Recently attempted channels are also excluded, and that is what lets the
   * fill advance: most channels return nothing at all, so selecting purely on
   * missing data would hand back the same barren channels on every pass and
   * never reach the rest of the list.
   */
  selectChannelsNeedingEPG(
    username: string,
    limit: number,
    freshForHours: number,
    retryAfterHours: number,
    /**
     * Whose favourites jump the queue. The channels belong to a subscription
     * and the favourites to an account, so both are needed; omitted, the order
     * is simply unprioritised rather than wrong.
     */
    userId?: number
  ): Array<{ streamId: string; channelId: string }> {
    const horizon = new Date(Date.now() + freshForHours * 3600 * 1000).toISOString();
    const retryCutoff = new Date(Date.now() - retryAfterHours * 3600 * 1000).toISOString();

    const rows = db
      .prepare(
        `SELECT s.stream_id, s.epg_channel_id
           FROM streams s
           LEFT JOIN favorites f
             ON f.user_id = ? AND f.stream_id = s.stream_id AND f.type = s.type
           LEFT JOIN epg_fetch_attempts a
             ON a.username = s.username AND a.epg_channel_id = s.epg_channel_id
          WHERE s.username = ?
            AND s.type = 'live'
            AND s.epg_channel_id IS NOT NULL
            AND s.epg_channel_id <> ''
            AND (a.attempted_at IS NULL OR a.attempted_at < ?)
            AND NOT EXISTS (
              SELECT 1 FROM epg_listings e
               WHERE e.username = s.username
                 AND e.epg_channel_id = s.epg_channel_id
                 AND e.stop >= ?
            )
          GROUP BY s.epg_channel_id
          ORDER BY (f.id IS NULL), s.stream_id
          LIMIT ?`
      )
      .all(userId ?? null, username, retryCutoff, horizon, limit) as Array<{
      stream_id: string;
      epg_channel_id: string;
    }>;

    return rows.map(r => ({ streamId: String(r.stream_id), channelId: String(r.epg_channel_id) }));
  }

  /**
   * Whether a failure was the provider failing to serve us, rather than
   * answering about this one request.
   *
   * The rule itself lives with the rest of the protocol, since a client
   * talking to the provider directly has to make the same judgement and would
   * otherwise make it differently.
   */
  private isProviderUnreachable(error: unknown): boolean {
    return isUnreachableStatus(error);
  }

  /** Notes that a channel was asked about, whatever the provider returned. */
  private recordEPGAttempt(username: string, channelId: string): void {
    db.prepare(
      `INSERT INTO epg_fetch_attempts (username, epg_channel_id, attempted_at)
       VALUES (?, ?, ?)
       ON CONFLICT(username, epg_channel_id)
       DO UPDATE SET attempted_at = excluded.attempted_at`
    ).run(username, channelId, new Date().toISOString());
  }

  /**
   * Tops up the guide for one account, a bounded batch at a time.
   *
   * Returns what it managed so the caller can log progress; a provider that
   * refuses a channel is skipped rather than retried, and the next pass will
   * come back to it.
   */
  async refreshEPGBatch(
    username: string,
    password: string,
    serverUrl: string | undefined,
    options: {
      batchSize: number;
      requestDelayMs: number;
      freshForHours: number;
      retryAfterHours: number;
      /** Whose favourites are filled first. */
      userId?: number;
    }
  ): Promise<{ attempted: number; withData: number; empty: number; failed: number }> {
    const channels = this.selectChannelsNeedingEPG(
      username,
      options.batchSize,
      options.freshForHours,
      options.retryAfterHours,
      options.userId
    );

    if (channels.length === 0) {
      return { attempted: 0, withData: 0, empty: 0, failed: 0 };
    }

    let withData = 0;
    let empty = 0;
    let failed = 0;

    for (const { streamId, channelId } of channels) {
      try {
        // getEPGShort stores what it fetches, which is the point of the call.
        const epg = await this.getEPGShort(username, password, streamId, serverUrl);
        const listings = epg?.epg_listings;
        if (Array.isArray(listings) && listings.length > 0) {
          withData++;
        } else {
          empty++;
        }
      } catch (error) {
        failed++;

        // A provider that cannot be reached has said nothing about this
        // channel. Recording an attempt would sideline it for the retry window
        // on the strength of an outage, and the rest of the batch would be
        // spent the same way, so the pass stops here and keeps its queue.
        if (this.isProviderUnreachable(error)) {
          console.info('EPG top-up stopping early: provider unreachable');
          return { attempted: withData + empty + failed - 1, withData, empty, failed };
        }
      }

      // Recorded whatever the provider said, so a channel it has nothing for
      // does not block the queue behind it.
      this.recordEPGAttempt(username, channelId);

      if (options.requestDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, options.requestDelayMs));
      }
    }

    return { attempted: channels.length, withData, empty, failed };
  }

  /** How much of this account's live guide is currently populated. */
  getEPGCoverage(username: string): { eligible: number; covered: number } {
    const eligible = db
      .prepare(
        `SELECT COUNT(*) AS n FROM streams
          WHERE username = ? AND type = 'live'
            AND epg_channel_id IS NOT NULL AND epg_channel_id <> ''`
      )
      .get(username) as { n: number };

    const covered = db
      .prepare(
        `SELECT COUNT(DISTINCT s.epg_channel_id) AS n
           FROM streams s
           JOIN epg_listings e
             ON e.username = s.username AND e.epg_channel_id = s.epg_channel_id
          WHERE s.username = ? AND s.type = 'live'`
      )
      .get(username) as { n: number };

    return { eligible: eligible.n, covered: covered.n };
  }

  getDistinctUsernames(): string[] {
    const streamUsers = db.prepare('SELECT DISTINCT username FROM streams').all() as Array<{ username: string }>;
    const epgUsers = db.prepare('SELECT DISTINCT username FROM epg_listings').all() as Array<{ username: string }>;
    const set = new Set<string>();
    for (const u of streamUsers) if (u.username) set.add(u.username);
    for (const u of epgUsers) if (u.username) set.add(u.username);
    return Array.from(set.values());
  }

  async getSeriesInfo(
    username: string,
    password: string,
    seriesId: string,
    serverUrl?: string
  ): Promise<SeriesInfo> {
    const client = this.clientFor(username, password, serverUrl);
    return this.viaProvider(() => client.getSeriesInfo(seriesId));
  }

  async getEPG(
    username: string,
    password: string,
    streamId: string,
    limit?: number,
    serverUrl?: string
  ): Promise<EPGListing> {
    const client = this.clientFor(username, password, serverUrl);
    const response = await this.viaProvider(() => client.getShortEPG(streamId, limit));
    const processed = processEPGListings(response) as EPGListing;
    this.saveEPGForStream(username, streamId, processed);
    return processed;
  }

  async getEPGShort(
    username: string,
    password: string,
    streamId: string,
    serverUrl?: string
  ): Promise<EPGListing> {
    const client = this.clientFor(username, password, serverUrl);
    const response = await this.viaProvider(() => client.getShortEPG(streamId));

    const processed = processEPGListings(response) as EPGListing;
    this.saveEPGForStream(username, streamId, processed);
    return processed;
  }

  async getAllEPG(
    username: string,
    password: string,
    serverUrl?: string
  ): Promise<EPGListing> {
    // Deliberately the short-guide action with no channel named. It is what
    // this always asked for, whatever the method is called.
    const client = this.clientFor(username, password, serverUrl);
    const response = await this.viaProvider(() => client.getShortEPG(''));

    // Processed and returned only: storing needs a channel, and there is none.
    return processEPGListings(response) as EPGListing;
  }

  async getExternalEPG(
    url: string,
    format: string = 'xml'
    // The parsed XMLTV guide, or for any other format whatever the guide's server sent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    try {
      
      // Validate URL format, and that it names a guide on the internet rather
      // than this server or its network: the caller chooses it.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new AppError(`Invalid EPG URL format: ${url}`, 400);
      }
      if (!/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) {
        throw new AppError('A guide address is an http or https address on the internet', 400);
      }
      
      // Fetch EPG data with streaming (like original server.ts)
      const response = await this.api.get(url, {
        responseType: 'stream',
        timeout: 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Encoding': 'gzip, deflate'
        },
        maxContentLength: MAX_EXTERNAL_EPG_BYTES,
        maxBodyLength: MAX_EXTERNAL_EPG_BYTES,
        // Not followed: a redirect would reach whatever address it names.
        maxRedirects: 0,
        validateStatus: () => true // Don't throw on HTTP error status
      });


      if (response.status === 404) {
        throw new AppError(`EPG URL not found (404): ${url}. Please check if the URL is correct and accessible.`, 404);
      }

      if (response.status >= 400) {
        throw new AppError(`EPG server error (${response.status}): ${url}`, response.status);
      }

      if (format === 'xml') {

        // Check if data is gzipped
        const isGzipped = url.endsWith('.gz');
        
        const chunks: Buffer[] = [];
        let totalSize = 0;
        const maxSize = 200 * 1024 * 1024; // 200MB limit
        const startTime = Date.now();

        // Create decompression stream if needed
        const dataStream = isGzipped ? response.data.pipe(zlib.createGunzip()) : response.data;

        // Collect chunks with progress logging
        for await (const chunk of dataStream) {
          totalSize += chunk.length;
          if (totalSize > maxSize) {
            throw new AppError('EPG file too large (>200MB)', 413);
          }
          chunks.push(chunk);
        }

        // Combine chunks into buffer
        const buffer = Buffer.concat(chunks);
        
        // Convert to string
        const xmlData = buffer.toString('utf8');

        // Parsing lives in shared/xtream/xmltv.ts, because a device has to do
        // exactly this and none of it is server work. What stays here is the
        // fetching above: gzip, streaming and the size limit, which is the
        // only part that differs between a Node server and a WebView.
        const epgResponse = parseXmltv(xmlData);
        console.info(
          `Found ${epgResponse.channels.length} channels and ${epgResponse.programmes.length} programmes ` +
            `in ${Date.now() - startTime} ms`
        );

        return epgResponse;
      }

      return response.data;
    } catch (error) {
      console.error('Error fetching external EPG:', describeError(error));
      
      if (error instanceof AppError) {
        throw error; // Re-throw our custom errors
      }
      
      if (error instanceof AxiosError) {
        if (error.code === 'ECONNABORTED') {
          throw new AppError('External EPG request timed out', 408);
        }
        if (error.response) {
          throw new AppError(`External EPG server responded with status ${error.response.status}: ${error.message}`, error.response.status);
        }
        if (error.request) {
          throw new AppError('No response received from external EPG server', 502);
        }
      }
      
      throw new AppError(`Failed to fetch external EPG: ${error instanceof Error ? error.message : 'Unknown error'}`, 502);
    }
  }
}

export const xtreamService = new XtreamService();
