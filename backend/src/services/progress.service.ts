import { db } from '../utils/database';
import { syncService } from './sync.service';
import { syncNow } from '../utils/syncClock';
import { StreamType, WatchProgress, WatchProgressInput } from '../../../shared/types';

/** Past this fraction of the runtime, there is nothing left worth resuming. */
const COMPLETE_FRACTION = 0.95;

interface ProgressRow {
  type: string;
  item_id: string;
  series_id: string | null;
  season: number | null;
  episode_num: number | null;
  name: string;
  episode_title: string | null;
  icon: string | null;
  container_extension: string | null;
  position_seconds: number;
  duration_seconds: number;
  completed: number;
  updated_at: string;
}

const toWatchProgress = (row: ProgressRow): WatchProgress => ({
  type: row.type as StreamType,
  itemId: String(row.item_id),
  seriesId: row.series_id === null ? null : String(row.series_id),
  season: row.season,
  episodeNum: row.episode_num,
  name: row.name,
  episodeTitle: row.episode_title,
  icon: row.icon,
  containerExtension: row.container_extension,
  positionSeconds: row.position_seconds,
  durationSeconds: row.duration_seconds,
  completed: row.completed === 1,
  updatedAt: row.updated_at
});

/** Discards NaN and negatives, which would otherwise be stored and replayed. */
const toSeconds = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const toIdOrNull = (value: unknown): string | null =>
  value === undefined || value === null || value === '' ? null : String(value);

const toIntOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * Watch history and resume points.
 *
 * Every write is an upsert on (user_id, type, item_id): watching the same
 * thing again moves it back to the top of the list rather than adding a second
 * entry for it.
 */
class ProgressService {
  /**
   * Records a position.
   *
   * Completion is decided here rather than trusted from the client, so the
   * rule that a finished film shows no resume bar holds however the entry was
   * written. A position past the end is clamped: providers report a duration
   * that occasionally runs a second or two short of the last frame.
   */
  record(userId: number, input: WatchProgressInput): WatchProgress {
    const duration = toSeconds(input.durationSeconds);
    const position = duration > 0
      ? Math.min(toSeconds(input.positionSeconds), duration)
      : toSeconds(input.positionSeconds);

    const completed =
      input.completed === true || (duration > 0 && position >= duration * COMPLETE_FRACTION);

    const updatedAt = syncNow();

    db.prepare(
      `INSERT INTO watch_progress (
         user_id, type, item_id, series_id, season, episode_num, name,
         episode_title, icon, container_extension, position_seconds,
         duration_seconds, completed, updated_at, synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`
    ).run(
      userId,
      input.type,
      String(input.itemId),
      toIdOrNull(input.seriesId),
      toIntOrNull(input.season),
      toIntOrNull(input.episodeNum),
      input.name || 'Unknown',
      input.episodeTitle ?? null,
      input.icon ?? null,
      input.containerExtension ?? null,
      position,
      duration,
      completed ? 1 : 0,
      updatedAt,
      updatedAt
    );

    return this.get(userId, input.type, String(input.itemId))!;
  }

  get(userId: number, type: StreamType, itemId: string): WatchProgress | null {
    const row = db
      .prepare('SELECT * FROM watch_progress WHERE user_id = ? AND type = ? AND item_id = ?')
      .get(userId, type, String(itemId)) as ProgressRow | undefined;
    return row ? toWatchProgress(row) : null;
  }

  /**
   * The most recently watched things of a type, newest first.
   *
   * Episodes collapse to one entry per show: partitioning on series_id where
   * it is set and on item_id where it is not means a film and a show are
   * handled by the same statement, and a show that has been watched across
   * eight episodes still takes one slot in a list of ten.
   */
  recent(userId: number, type: StreamType, limit = 10): WatchProgress[] {
    const capped = Math.max(1, Math.min(100, Math.trunc(limit) || 10));

    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY COALESCE(series_id, item_id)
             ORDER BY updated_at DESC, id DESC
           ) AS rn
           FROM watch_progress
           WHERE user_id = ? AND type = ?
         )
         WHERE rn = 1
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(userId, type, capped) as ProgressRow[];

    return rows.map(toWatchProgress);
  }

  /** Positions for a set of items, keyed by item id, for marking a list. */
  forItems(userId: number, type: StreamType, itemIds: string[]): Record<string, WatchProgress> {
    if (itemIds.length === 0) {
      return {};
    }

    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM watch_progress
         WHERE user_id = ? AND type = ? AND item_id IN (${placeholders})`
      )
      .all(userId, type, ...itemIds.map(String)) as ProgressRow[];

    const map: Record<string, WatchProgress> = {};
    for (const row of rows) {
      map[String(row.item_id)] = toWatchProgress(row);
    }
    return map;
  }

  /** Every episode position for one show, keyed by episode id. */
  forSeries(userId: number, seriesId: string): Record<string, WatchProgress> {
    const rows = db
      .prepare(
        `SELECT * FROM watch_progress
         WHERE user_id = ? AND type = 'series' AND series_id = ?
         ORDER BY updated_at DESC`
      )
      .all(userId, String(seriesId)) as ProgressRow[];

    const map: Record<string, WatchProgress> = {};
    for (const row of rows) {
      map[String(row.item_id)] = toWatchProgress(row);
    }
    return map;
  }

  /**
   * Forgets an entry.
   *
   * Removing a show means removing every episode of it, since the show is what
   * the user sees in the list; for anything else the id is the entry.
   */
  remove(userId: number, type: StreamType, itemId: string): number {
    // Which rows go is worked out first, so each one can be recorded as gone.
    const doomed = db
      .prepare(
        type === 'series'
          ? `SELECT type, item_id FROM watch_progress
              WHERE user_id = ? AND type = ? AND (series_id = ? OR item_id = ?)`
          : `SELECT type, item_id FROM watch_progress
              WHERE user_id = ? AND type = ? AND item_id = ?`
      )
      .all(
        ...(type === 'series'
          ? [userId, type, String(itemId), String(itemId)]
          : [userId, type, String(itemId)])
      ) as Array<{ type: string; item_id: string }>;

    for (const row of doomed) {
      syncService.recordDeletion(
        userId,
        'progress',
        syncService.progressKey(row.type as StreamType, String(row.item_id))
      );
    }

    if (type === 'series') {
      const bySeries = db
        .prepare('DELETE FROM watch_progress WHERE user_id = ? AND type = ? AND series_id = ?')
        .run(userId, type, String(itemId));
      if (bySeries.changes > 0) {
        return bySeries.changes;
      }
    }

    return db
      .prepare('DELETE FROM watch_progress WHERE user_id = ? AND type = ? AND item_id = ?')
      .run(userId, type, String(itemId)).changes;
  }
}

export const progressService = new ProgressService();
