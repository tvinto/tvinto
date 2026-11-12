import {
  ArrangementChange,
  CHANGE_KINDS,
  ChangeKind,
  ChangeSet,
  FavouriteChange,
  ProgressChange,
  PullResult,
  SettingChange,
  ChannelMappingChange,
  GuideSourceChange,
  Tombstone,
  MAX_CHANGES_PER_PUSH,
  countChanges
} from '../../shared/sync';
import { StreamType } from '../../shared/types';
import { D1Database, D1PreparedStatement, Env, maybeNumber, maybeText, number, text } from './d1';
import { HttpError, ok, readJson } from './http';
import { cursorNow, now } from './clock';
import { LOCK_SETTINGS, onlyKinds, touchesLock } from '../../shared/family';
import { readCategorySets } from '../../shared/categoryLock';
import { loosens, readAgeLock } from '../../shared/tmdb/age';

/**
 * The change feed, against D1.
 *
 * The semantics are not reinvented here: `shared/sync.ts` defines what travels
 * and the Express backend's 100-odd tests describe how it must behave. What is
 * new is the shape of the work, and that is entirely about a budget.
 *
 * A Worker gets fifty queries per request on the free plan. The backend's push
 * does a SELECT and an INSERT per change, which is fine against a local file
 * and impossible here. So a push reads the account's timestamps in one query
 * per table, decides everything in memory, and writes in a single batch.
 */

/** The beginning of time, for a device that has never synced. */
const EPOCH = '1970-01-01T00:00:00.000Z';

// How many changes one push may carry lives in shared/sync.ts, beside
// `splitChangeSet`, which is what a device uses to obey it. A limit written
// down in one place and respected in another is a limit that drifts.
export { MAX_CHANGES_PER_PUSH } from '../../shared/sync';

/**
 * Whether an incoming change is newer than what is stored.
 *
 * Equal counts as not newer, which is what makes a re-send a no-op rather than
 * a write -- and the reason a lagging cursor is safe.
 */
const isNewer = (incoming: string | undefined, stored: string | undefined): boolean => {
  if (!incoming) {
    return false;
  }
  return !stored || incoming > stored;
};

/**
 * A push's times, none later than this server's clock.
 *
 * Which of two changes wins is decided by the times devices stamp them with,
 * from their own clocks, and a television box can boot believing it is next
 * year (shared/xtream/guideReload.ts). Its changes would then win every
 * comparison until that date: a setting or a watch position changed on it
 * could not be changed back from any other device for months. Capped here, a
 * change from such a clock counts as made now.
 */
const noLaterThan = (received: Partial<ChangeSet>, at: string): Partial<ChangeSet> => {
  const capped = <T>(items: T[] | undefined): T[] | undefined =>
    items?.map(item => {
      const change = item as { updatedAt?: unknown; deletedAt?: unknown };
      const updatedAt = typeof change.updatedAt === 'string' && change.updatedAt > at ? at : change.updatedAt;
      const deletedAt = typeof change.deletedAt === 'string' && change.deletedAt > at ? at : change.deletedAt;
      return updatedAt === change.updatedAt && deletedAt === change.deletedAt
        ? item
        : ({ ...item, ...(change.updatedAt !== undefined ? { updatedAt } : {}), ...(change.deletedAt !== undefined ? { deletedAt } : {}) } as T);
    });
  return {
    ...received,
    favourites: capped(received.favourites),
    arrangements: capped(received.arrangements),
    progress: capped(received.progress),
    settings: capped(received.settings),
    guideSources: capped(received.guideSources),
    channelMappings: capped(received.channelMappings),
    deletions: capped(received.deletions)
  };
};

const favouriteKey = (type: string, streamId: string): string => `${type}:${streamId}`;
const progressKey = (type: string, itemId: string): string => `${type}:${itemId}`;

/** Splits `type:id`, keeping any colons that belong to the id itself. */
const splitKey = (key: string): [string, string] => {
  const at = key.indexOf(':');
  return at === -1 ? ['', ''] : [key.slice(0, at), key.slice(at + 1)];
};

/** JSON that came out of a column, or a fallback if the row is damaged. */
const parseJson = <T>(value: unknown, fallback: T): T => {
  try {
    const parsed = JSON.parse(text(value));
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
};

// --- Pull -----------------------------------------------------------------

/**
 * Everything that changed for this account after a given moment.
 *
 * Six queries, whatever the account holds. `since` is exclusive, so a device
 * quoting the cursor it was last given does not receive that batch again --
 * except for the second of overlap the cursor deliberately keeps, which see
 * in clock.ts.
 */
export const pullChanges = async (
  request: Request,
  env: Env,
  userId: number,
  allowed: readonly ChangeKind[] | null = null
): Promise<Response> => {
  const since = (new URL(request.url).searchParams.get('since') ?? '').trim();

  // A malformed timestamp would otherwise be compared as a string against real
  // ones and quietly return the wrong slice of history.
  if (since && Number.isNaN(Date.parse(since))) {
    throw new HttpError('since must be an ISO timestamp', 400);
  }

  const from = since || EPOCH;
  const db = env.DB;

  const [favourites, arrangements, progress, settings, guideSources, channelMappings, deletions] =
    await Promise.all([
      favouritesSince(db, userId, from),
      arrangementsSince(db, userId, from),
      progressSince(db, userId, from),
      settingsSince(db, userId, from),
      guideSourcesSince(db, userId, from),
      channelMappingsSince(db, userId, from),
      deletionsSince(db, userId, from)
    ]);

  const result: PullResult = {
    serverTime: cursorNow(),
    favourites,
    arrangements,
    progress,
    settings,
    guideSources,
    channelMappings,
    deletions
  };

  // Read whole and narrowed after, rather than a query per allowed kind left
  // out: one place decides what a caller sees.
  const narrowed = onlyKinds(result, allowed).batch;
  return ok({ ...result, ...emptyLists(), ...narrowed, serverTime: result.serverTime });
};

const favouritesSince = async (
  db: D1Database,
  userId: number,
  since: string
): Promise<FavouriteChange[]> => {
  const rows = await db
    .prepare(
      `SELECT type, stream_id, name, updated_at FROM favorites
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
    )
    .bind(userId, since)
    .all();

  return rows.results.map(row => {
    const record = row as Record<string, unknown>;
    return {
      type: text(record['type']) as StreamType,
      streamId: text(record['stream_id']),
      name: maybeText(record['name']),
      updatedAt: text(record['updated_at'])
    };
  });
};

const arrangementsSince = async (
  db: D1Database,
  userId: number,
  since: string
): Promise<ArrangementChange[]> => {
  const rows = await db
    .prepare(
      `SELECT scope, item_ids, names, updated_at FROM sort_order
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
    )
    .bind(userId, since)
    .all();

  return rows.results.map(row => {
    const record = row as Record<string, unknown>;
    return {
      scope: text(record['scope']),
      itemIds: parseJson<string[]>(record['item_ids'], []),
      names: parseJson<Record<string, string>>(record['names'], {}),
      updatedAt: text(record['updated_at'])
    };
  });
};

const progressSince = async (
  db: D1Database,
  userId: number,
  since: string
): Promise<ProgressChange[]> => {
  const rows = await db
    .prepare(
      `SELECT * FROM watch_progress WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
    )
    .bind(userId, since)
    .all();

  return rows.results.map(row => {
    const record = row as Record<string, unknown>;
    return {
      type: text(record['type']) as StreamType,
      itemId: text(record['item_id']),
      seriesId: maybeText(record['series_id']),
      season: maybeNumber(record['season']),
      episodeNum: maybeNumber(record['episode_num']),
      name: text(record['name']),
      episodeTitle: maybeText(record['episode_title']),
      icon: maybeText(record['icon']),
      containerExtension: maybeText(record['container_extension']),
      positionSeconds: number(record['position_seconds']),
      durationSeconds: number(record['duration_seconds']),
      completed: number(record['completed']) === 1,
      // Null rather than '' when nothing was ever recorded: a device merging
      // this has to tell "watched with no subtitles" from "nobody has said".
      audioLanguage: maybeText(record['audio_language']),
      subtitleLanguage: maybeText(record['subtitle_language']),
      audioTitle: maybeText(record['audio_title']),
      subtitleTitle: maybeText(record['subtitle_title']),
      subtitlesEnabled:
        record['subtitles_enabled'] === null || record['subtitles_enabled'] === undefined
          ? null
          : number(record['subtitles_enabled']) === 1,
      updatedAt: text(record['updated_at'])
    };
  });
};

const settingsSince = async (
  db: D1Database,
  userId: number,
  since: string
): Promise<SettingChange[]> => {
  const rows = await db
    .prepare(
      `SELECT key, value, updated_at FROM user_settings
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
    )
    .bind(userId, since)
    .all();

  return rows.results.map(row => {
    const record = row as Record<string, unknown>;
    return {
      key: text(record['key']),
      value: text(record['value']),
      updatedAt: text(record['updated_at'])
    };
  });
};

const guideSourcesSince = async (
  db: D1Database,
  userId: number,
  since: string
): Promise<GuideSourceChange[]> => {
  const rows = await db
    .prepare(
      `SELECT id, payload, updated_at FROM guide_sources
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
    )
    .bind(userId, since)
    .all();

  return rows.results.map(row => {
    const record = row as Record<string, unknown>;
    return {
      id: text(record['id']),
      payload: text(record['payload']),
      updatedAt: text(record['updated_at'])
    };
  });
};

const channelMappingsSince = async (
  db: D1Database,
  userId: number,
  since: string
): Promise<ChannelMappingChange[]> => {
  const rows = await db
    .prepare(
      `SELECT stream_id, source_id, channel_id, updated_at FROM channel_mappings
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
    )
    .bind(userId, since)
    .all();

  return rows.results.map(row => {
    const record = row as Record<string, unknown>;
    return {
      streamId: text(record['stream_id']),
      sourceId: text(record['source_id']),
      channelId: text(record['channel_id']),
      updatedAt: text(record['updated_at'])
    };
  });
};

const deletionsSince = async (
  db: D1Database,
  userId: number,
  since: string
): Promise<Tombstone[]> => {
  const rows = await db
    .prepare(
      `SELECT kind, item_key, deleted_at FROM sync_tombstones
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
    )
    .bind(userId, since)
    .all();

  return rows.results.map(row => {
    const record = row as Record<string, unknown>;
    return {
      kind: text(record['kind']) as ChangeKind,
      key: text(record['item_key']),
      deletedAt: text(record['deleted_at'])
    };
  });
};

// --- Push -----------------------------------------------------------------

/** What is already stored, read once and consulted many times. */
interface Stored {
  favourites: Map<string, string>;
  arrangements: Map<string, string>;
  progress: Map<string, string>;
  settings: Map<string, string>;
  guideSources: Map<string, string>;
  channelMappings: Map<string, string>;
  tombstones: Map<string, string>;
}

/** Every list empty, so a narrowed answer still has the shape a device expects. */
const emptyLists = () => ({
  favourites: [],
  arrangements: [],
  progress: [],
  settings: [],
  guideSources: [],
  channelMappings: [],
  deletions: []
});

export const pushChanges = async (
  request: Request,
  env: Env,
  userId: number,
  allowed: readonly ChangeKind[] | null = null,
  charge?: (changes: number) => Promise<void>,
  lockRefused = false
): Promise<Response> => {
  const received = await readJson<Partial<ChangeSet>>(request);
  // Refused rather than dropped: a tool asked to take the lock off should hear
  // that it cannot, not see its change counted as superseded.
  if (lockRefused && touchesLock(received) && (await loosensLock(env.DB, userId, received))) {
    throw new HttpError('A tool cannot loosen the parental lock; ask the app (pin-off)', 403);
  }
  refuseOversized(received);
  await refuseNewSettingsOverLimit(env.DB, userId, (received.settings ?? []).map(setting => setting?.key));

  for (const field of [
    'favourites',
    'arrangements',
    'progress',
    'settings',
    'guideSources',
    'channelMappings',
    'deletions'
  ] as const) {
    const value = received[field];
    if (value !== undefined && !Array.isArray(value)) {
      throw new HttpError(`${field} must be an array`, 400);
    }
  }

  const total = countChanges(received);
  if (total > MAX_CHANGES_PER_PUSH) {
    // Named rather than merely refused, so a device can split to fit instead of
    // guessing at what would have been acceptable.
    throw new HttpError(
      `A push may carry at most ${MAX_CHANGES_PER_PUSH} changes; this one had ${total}. Send it in pieces.`,
      413
    );
  }

  // A tool's changes are counted against its own limit first (index.ts).
  await charge?.(total);

  // What this caller may not change is left out, not refused: a kid's device,
  // or one from before families, pushes everything it holds at once, and the
  // favourites in the same batch should still arrive. Counted as superseded,
  // which to a device means the same thing -- the server keeps what it has.
  const at = now();
  const { batch, dropped } = onlyKinds(noLaterThan(received, at), allowed);

  const db = env.DB;
  const stored = await readStored(db, userId, batch, at);
  const statements: D1PreparedStatement[] = [];

  let applied = 0;
  let superseded = dropped;
  const count = (accepted: boolean) => (accepted ? (applied += 1) : (superseded += 1));

  // Deletions first. A batch that both removes and re-adds the same favourite
  // means the re-add is the later intent, and doing removals first lets the add
  // win rather than being wiped by its own tombstone.
  for (const deletion of batch.deletions ?? []) {
    count(planDeletion(db, userId, deletion, stored, at, statements));
  }
  for (const favourite of batch.favourites ?? []) {
    count(planFavourite(db, userId, favourite, stored, at, statements));
  }
  for (const arrangement of batch.arrangements ?? []) {
    count(planArrangement(db, userId, arrangement, stored, at, statements));
  }
  for (const entry of batch.progress ?? []) {
    count(planProgress(db, userId, entry, stored, at, statements));
  }
  for (const setting of batch.settings ?? []) {
    count(planSetting(db, userId, setting, stored, at, statements));
  }
  for (const source of batch.guideSources ?? []) {
    count(planGuideSource(db, userId, source, stored, at, statements));
  }
  for (const mapping of batch.channelMappings ?? []) {
    count(planChannelMapping(db, userId, mapping, stored, at, statements));
  }

  // One round trip, in one implicit transaction. A half-applied batch would
  // leave an arrangement referring to a favourite that never arrived.
  if (statements.length) {
    await db.batch(statements);
  }

  return ok({ applied, superseded, serverTime: cursorNow() });
};

/**
 * The timestamps this batch will be compared against.
 *
 * Whole tables rather than the keys in the batch. It is one query either way,
 * and this one has no list to build: what the account holds here is favourites,
 * settings and history, which is kilobytes. Building an IN-list per kind would
 * be more SQL, more string handling and the same number of round trips.
 *
 * Only the kinds present are read, so an empty push is no queries at all.
 */
const readStored = async (
  db: D1Database,
  userId: number,
  batch: Partial<ChangeSet>,
  at: string
): Promise<Stored> => {
  /**
   * A kind's timestamps, or an empty map when the batch says nothing about it.
   *
   * The skip is the point. An empty push costs no queries, and a push carrying
   * only history does not read the favourites to decide it.
   */
  const timestamps = async (
    wanted: boolean,
    query: string,
    column: string,
    key: (row: Record<string, unknown>) => string
  ): Promise<Map<string, string>> => {
    if (!wanted) {
      return new Map();
    }

    const rows = await db.prepare(query).bind(userId).all();
    return new Map(
      rows.results.map(row => {
        const record = row as Record<string, unknown>;
        // Stamped later than now by a clock that ran ahead, before pushes
        // were capped (`noLaterThan`): no time at all, so the next real
        // change replaces it rather than waiting for that date.
        const stamp = text(record[column]);
        return [key(record), stamp > at ? '' : stamp];
      })
    );
  };

  // Deletions are decided in SQL -- `updated_at <= ?` on the delete itself --
  // so they need no map of their own. What they do need is the tombstones,
  // which anything that can be buried is also weighed against.
  const [favourites, arrangements, progress, settings, guideSources, channelMappings, tombstones] =
    await Promise.all([
      timestamps(
        !!batch.favourites?.length,
        'SELECT type, stream_id, updated_at FROM favorites WHERE user_id = ?',
        'updated_at',
        row => favouriteKey(text(row['type']), text(row['stream_id']))
      ),
      timestamps(
        !!batch.arrangements?.length,
        'SELECT scope, updated_at FROM sort_order WHERE user_id = ?',
        'updated_at',
        row => text(row['scope'])
      ),
      timestamps(
        !!batch.progress?.length,
        'SELECT type, item_id, updated_at FROM watch_progress WHERE user_id = ?',
        'updated_at',
        row => progressKey(text(row['type']), text(row['item_id']))
      ),
      timestamps(
        !!batch.settings?.length,
        'SELECT key, updated_at FROM user_settings WHERE user_id = ?',
        'updated_at',
        row => text(row['key'])
      ),
      timestamps(
        !!batch.guideSources?.length,
        'SELECT id, updated_at FROM guide_sources WHERE user_id = ?',
        'updated_at',
        row => text(row['id'])
      ),
      timestamps(
        !!batch.channelMappings?.length,
        'SELECT stream_id, updated_at FROM channel_mappings WHERE user_id = ?',
        'updated_at',
        row => text(row['stream_id'])
      ),
      timestamps(
        !!batch.deletions?.length ||
          !!batch.favourites?.length ||
          !!batch.guideSources?.length ||
          !!batch.channelMappings?.length,
        'SELECT kind, item_key, deleted_at FROM sync_tombstones WHERE user_id = ?',
        'deleted_at',
        row => `${text(row['kind'])} ${text(row['item_key'])}`
      )
    ]);

  return {
    favourites,
    arrangements,
    progress,
    settings,
    guideSources,
    channelMappings,
    tombstones
  };
};

const planFavourite = (
  db: D1Database,
  userId: number,
  change: FavouriteChange,
  stored: Stored,
  at: string,
  statements: D1PreparedStatement[]
): boolean => {
  const key = favouriteKey(change.type, String(change.streamId));

  // A tombstone newer than this add means it was removed after being made.
  const removed = stored.tombstones.get(`favourite ${key}`);
  if (removed && removed >= change.updatedAt) {
    return false;
  }
  if (!isNewer(change.updatedAt, stored.favourites.get(key))) {
    return false;
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO favorites (user_id, type, stream_id, name, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, type, stream_id) DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
      )
      .bind(userId, change.type, String(change.streamId), change.name ?? null, change.updatedAt, at)
  );

  clearTombstone(db, userId, 'favourite', key, stored, statements);
  return true;
};

const planArrangement = (
  db: D1Database,
  userId: number,
  change: ArrangementChange,
  stored: Stored,
  at: string,
  statements: D1PreparedStatement[]
): boolean => {
  if (!isNewer(change.updatedAt, stored.arrangements.get(change.scope))) {
    return false;
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO sort_order (user_id, scope, item_ids, names, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, scope) DO UPDATE SET
           item_ids = excluded.item_ids,
           names = excluded.names,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
      )
      .bind(
        userId,
        change.scope,
        JSON.stringify((change.itemIds ?? []).map(String)),
        JSON.stringify(change.names ?? {}),
        change.updatedAt,
        at
      )
  );

  clearTombstone(db, userId, 'arrangement', change.scope, stored, statements);
  return true;
};

const planProgress = (
  db: D1Database,
  userId: number,
  change: ProgressChange,
  stored: Stored,
  at: string,
  statements: D1PreparedStatement[]
): boolean => {
  const key = progressKey(change.type, String(change.itemId));

  if (!isNewer(change.updatedAt, stored.progress.get(key))) {
    return false;
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO watch_progress (
           user_id, type, item_id, series_id, season, episode_num, name, episode_title,
           icon, container_extension, position_seconds, duration_seconds, completed,
           audio_language, subtitle_language, audio_title, subtitle_title, subtitles_enabled,
           updated_at, synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, type, item_id) DO UPDATE SET
           series_id = excluded.series_id,
           season = excluded.season,
           episode_num = excluded.episode_num,
           name = excluded.name,
           episode_title = excluded.episode_title,
           icon = excluded.icon,
           container_extension = excluded.container_extension,
           position_seconds = excluded.position_seconds,
           duration_seconds = excluded.duration_seconds,
           completed = excluded.completed,
           -- Kept when the arriving change says nothing. A device whose player
           -- cannot report its tracks still sends progress, and it must not
           -- wipe what another device remembered about this film.
           audio_language = COALESCE(excluded.audio_language, watch_progress.audio_language),
           subtitle_language = COALESCE(excluded.subtitle_language, watch_progress.subtitle_language),
           audio_title = COALESCE(excluded.audio_title, watch_progress.audio_title),
           subtitle_title = COALESCE(excluded.subtitle_title, watch_progress.subtitle_title),
           subtitles_enabled = COALESCE(excluded.subtitles_enabled, watch_progress.subtitles_enabled),
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
      )
      .bind(
        userId,
        change.type,
        String(change.itemId),
        change.seriesId ?? null,
        change.season ?? null,
        change.episodeNum ?? null,
        change.name || 'Unknown',
        change.episodeTitle ?? null,
        change.icon ?? null,
        change.containerExtension ?? null,
        Number(change.positionSeconds) || 0,
        Number(change.durationSeconds) || 0,
        change.completed ? 1 : 0,
        change.audioLanguage ?? null,
        change.subtitleLanguage ?? null,
        change.audioTitle ?? null,
        change.subtitleTitle ?? null,
        change.subtitlesEnabled === null || change.subtitlesEnabled === undefined
          ? null
          : change.subtitlesEnabled
            ? 1
            : 0,
        change.updatedAt,
        at
      )
  );

  clearTombstone(db, userId, 'progress', key, stored, statements);
  return true;
};

const planSetting = (
  db: D1Database,
  userId: number,
  change: SettingChange,
  stored: Stored,
  at: string,
  statements: D1PreparedStatement[]
): boolean => {
  if (!isNewer(change.updatedAt, stored.settings.get(change.key))) {
    return false;
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO user_settings (user_id, key, value, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
      )
      .bind(userId, change.key, change.value, change.updatedAt, at)
  );

  return true;
};

/**
 * A guide the account uses.
 *
 * Weighed against a tombstone the way a favourite is, and for the same reason:
 * a source removed on the television and still held by the phone would come
 * back on the phone's next push, and removing a guide would be impossible to
 * make stick.
 */
const planGuideSource = (
  db: D1Database,
  userId: number,
  change: GuideSourceChange,
  stored: Stored,
  at: string,
  statements: D1PreparedStatement[]
): boolean => {
  if (!change.id || typeof change.payload !== 'string' || !change.payload) {
    return false;
  }

  const removed = stored.tombstones.get(`guideSource ${change.id}`);
  if (removed && removed >= change.updatedAt) {
    return false;
  }
  if (!isNewer(change.updatedAt, stored.guideSources.get(change.id))) {
    return false;
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO guide_sources (user_id, id, payload, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
      )
      .bind(userId, change.id, change.payload, change.updatedAt, at)
  );

  clearTombstone(db, userId, 'guideSource', change.id, stored, statements);
  return true;
};

/**
 * One stream tied by hand to one guide channel.
 *
 * Keyed by the stream, because a stream takes its guide from one place and
 * choosing which is exactly what was decided. Mapping the same stream again
 * replaces the choice rather than adding a second one.
 */
const planChannelMapping = (
  db: D1Database,
  userId: number,
  change: ChannelMappingChange,
  stored: Stored,
  at: string,
  statements: D1PreparedStatement[]
): boolean => {
  const streamId = String(change.streamId ?? '');
  if (!streamId || !change.sourceId || !change.channelId) {
    return false;
  }

  const removed = stored.tombstones.get(`channelMapping ${streamId}`);
  if (removed && removed >= change.updatedAt) {
    return false;
  }
  if (!isNewer(change.updatedAt, stored.channelMappings.get(streamId))) {
    return false;
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO channel_mappings (user_id, stream_id, source_id, channel_id, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, stream_id) DO UPDATE SET
           source_id = excluded.source_id,
           channel_id = excluded.channel_id,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
      )
      .bind(userId, streamId, change.sourceId, change.channelId, change.updatedAt, at)
  );

  clearTombstone(db, userId, 'channelMapping', streamId, stored, statements);
  return true;
};

const planDeletion = (
  db: D1Database,
  userId: number,
  tombstone: Tombstone,
  stored: Stored,
  at: string,
  statements: D1PreparedStatement[]
): boolean => {
  if (!CHANGE_KINDS.includes(tombstone.kind)) {
    return false;
  }

  // Already buried, at or after this moment. Re-recording it would write the
  // same row and delete the same nothing -- two statements out of a budget of
  // fifty, spent to change no state at all. A device re-offering everything it
  // holds sends exactly this, so it is not a rare case.
  const buried = stored.tombstones.get(`${tombstone.kind} ${tombstone.key}`);
  if (buried && buried >= tombstone.deletedAt) {
    return false;
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO sync_tombstones (user_id, kind, item_key, deleted_at, synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, kind, item_key) DO UPDATE SET
           deleted_at = MAX(sync_tombstones.deleted_at, excluded.deleted_at),
           synced_at = excluded.synced_at`
      )
      .bind(userId, tombstone.kind, tombstone.key, tombstone.deletedAt, at)
  );

  // Remembered as well as written, because a favourite later in this same batch
  // is decided against what this deletion just said.
  stored.tombstones.set(`${tombstone.kind} ${tombstone.key}`, tombstone.deletedAt);

  planRowRemoval(db, userId, tombstone, at, statements);
  return true;
};

/**
 * Removes the row a tombstone refers to, if it has not since been rewritten.
 * A row stamped later than this server's clock (`at`) was stamped by a device
 * whose clock ran ahead, and is older than any deletion (`noLaterThan`).
 */
const planRowRemoval = (
  db: D1Database,
  userId: number,
  tombstone: Tombstone,
  at: string,
  statements: D1PreparedStatement[]
): void => {
  const { kind, key, deletedAt } = tombstone;

  if (kind === 'arrangement') {
    statements.push(
      db
        .prepare('DELETE FROM sort_order WHERE user_id = ? AND scope = ? AND (updated_at <= ? OR updated_at > ?)')
        .bind(userId, key, deletedAt, at)
    );
    return;
  }

  if (kind === 'setting') {
    statements.push(
      db
        .prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ? AND (updated_at <= ? OR updated_at > ?)')
        .bind(userId, key, deletedAt, at)
    );
    return;
  }

  if (kind === 'guideSource') {
    statements.push(
      db
        .prepare('DELETE FROM guide_sources WHERE user_id = ? AND id = ? AND (updated_at <= ? OR updated_at > ?)')
        .bind(userId, key, deletedAt, at)
    );
    return;
  }

  if (kind === 'channelMapping') {
    statements.push(
      db
        .prepare(
          'DELETE FROM channel_mappings WHERE user_id = ? AND stream_id = ? AND (updated_at <= ? OR updated_at > ?)'
        )
        .bind(userId, key, deletedAt, at)
    );
    return;
  }

  const [type, id] = splitKey(key);
  if (!type || !id) {
    return;
  }

  if (kind === 'favourite') {
    statements.push(
      db
        .prepare(
          'DELETE FROM favorites WHERE user_id = ? AND type = ? AND stream_id = ? AND (updated_at IS NULL OR updated_at <= ? OR updated_at > ?)'
        )
        .bind(userId, type, id, deletedAt, at)
    );
  } else if (kind === 'progress') {
    statements.push(
      db
        .prepare(
          'DELETE FROM watch_progress WHERE user_id = ? AND type = ? AND item_id = ? AND (updated_at <= ? OR updated_at > ?)'
        )
        .bind(userId, type, id, deletedAt, at)
    );
  }
};

/**
 * Forgets that something was removed, because it has been made again.
 *
 * A tombstone outliving the thing's return would have the next pull delete it
 * right back off the device that just re-added it.
 *
 * Only when there is one to forget: an unconditional DELETE would be a
 * statement spent on nothing, and statements are what this budget is in.
 */
const clearTombstone = (
  db: D1Database,
  userId: number,
  kind: ChangeKind,
  key: string,
  stored: Stored,
  statements: D1PreparedStatement[]
): void => {
  if (!stored.tombstones.has(`${kind} ${key}`)) {
    return;
  }

  statements.push(
    db
      .prepare('DELETE FROM sync_tombstones WHERE user_id = ? AND kind = ? AND item_key = ?')
      .bind(userId, kind, key)
  );
  stored.tombstones.delete(`${kind} ${key}`);
};

// --- Settings -------------------------------------------------------------

export const getSettings = async (env: Env, userId: number): Promise<Response> => {
  const rows = await env.DB.prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
    .bind(userId)
    .all();

  const settings: Record<string, string> = {};
  for (const row of rows.results) {
    const record = row as Record<string, unknown>;
    settings[text(record['key'])] = text(record['value']);
  }

  return ok(settings);
};

/**
 * Whether a change set would loosen the parental lock: change or remove the
 * PIN, unlock a category, or raise or drop the age limit. A tool may add to
 * the lock -- the CLI asks for the PIN first, on its side -- but taking any of
 * it away is the app's, where a person types the PIN.
 */
const loosensLock = async (db: D1Database, userId: number, batch: Partial<ChangeSet>): Promise<boolean> => {
  if ((batch.deletions ?? []).some(deletion => deletion?.kind === 'setting' && LOCK_SETTINGS.includes(deletion.key))) {
    return true;
  }
  const changed = (batch.settings ?? []).filter(setting => LOCK_SETTINGS.includes(setting?.key));
  if (changed.some(setting => setting.key === 'parentalLock')) {
    return true;
  }
  const rows = await db
    .prepare("SELECT key, value FROM user_settings WHERE user_id = ? AND key IN ('lockedCategories', 'ageLock')")
    .bind(userId)
    .all<{ key: string; value: string }>();
  const stored = new Map((rows.results ?? []).map(row => [row.key, row.value]));
  for (const setting of changed) {
    if (setting.key === 'lockedCategories') {
      const before = readCategorySets(stored.get('lockedCategories'));
      const after = readCategorySets(setting.value);
      for (const type of Object.keys(before) as (keyof typeof before)[]) {
        if (before[type].some(id => !after[type].includes(id))) {
          return true;
        }
      }
    }
    if (setting.key === 'ageLock' && loosens(readAgeLock(stored.get('ageLock')), readAgeLock(setting.value))) {
      return true;
    }
  }
  return false;
};

/**
 * Limits on what one account keeps, so one account -- or a tool acting for it
 * -- cannot fill the database every account shares. Per change and per key
 * rather than per request alone: twenty changes a request, sent again and
 * again, had no end.
 */
const MAX_CHANGE_CHARS = 256 * 1024;
const MAX_SETTING_KEY_CHARS = 100;
const MAX_SETTINGS_PER_ACCOUNT = 400;

const refuseOversized = (batch: Partial<ChangeSet>): void => {
  for (const list of Object.values(batch)) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (JSON.stringify(entry ?? null).length > MAX_CHANGE_CHARS) {
        throw new HttpError('One of these changes is larger than this service keeps', 413);
      }
    }
  }
  for (const setting of batch.settings ?? []) {
    if (typeof setting?.key === 'string' && setting.key.length > MAX_SETTING_KEY_CHARS) {
      throw new HttpError('A setting name is longer than this service keeps', 413);
    }
  }
};

/** Refuses settings the account does not have yet, once it has as many as it may. */
const refuseNewSettingsOverLimit = async (db: D1Database, userId: number, keys: unknown[]): Promise<void> => {
  const named = [...new Set(keys.filter((key): key is string => typeof key === 'string'))];
  if (!named.length) {
    return;
  }
  const held = await db
    .prepare('SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?')
    .bind(userId)
    .first<{ n: number }>();
  const known = await db
    .prepare(`SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ? AND key IN (${named.map(() => '?').join(',')})`)
    .bind(userId, ...named)
    .first<{ n: number }>();
  if (Number(held?.n) + (named.length - Number(known?.n)) > MAX_SETTINGS_PER_ACCOUNT) {
    throw new HttpError('This account has as many settings as this service keeps', 413);
  }
};

export const saveSettings = async (
  request: Request,
  env: Env,
  userId: number
): Promise<Response> => {
  const settings = await readJson<Record<string, string>>(request);

  const offending = Object.entries(settings).find(([, value]) => typeof value !== 'string');
  if (offending) {
    throw new HttpError(`Setting "${offending[0]}" must be a string`, 400);
  }

  const entries = Object.entries(settings);
  if (entries.length > MAX_CHANGES_PER_PUSH) {
    throw new HttpError(
      `At most ${MAX_CHANGES_PER_PUSH} settings may be saved at once; this had ${entries.length}.`,
      413
    );
  }
  refuseOversized({ settings: entries.map(([key, value]) => ({ key, value, updatedAt: '' })) });
  await refuseNewSettingsOverLimit(env.DB, userId, entries.map(([key]) => key));

  const at = now();
  const statements = entries.map(([key, value]) =>
    env.DB.prepare(
      `INSERT INTO user_settings (user_id, key, value, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`
    ).bind(userId, key, value, at, at)
  );

  if (statements.length) {
    await env.DB.batch(statements);
  }

  return getSettings(env, userId);
};
