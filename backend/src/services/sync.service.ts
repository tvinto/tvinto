import { db } from '../utils/database';
import { StreamType } from '../../../shared/types';
import {
  ArrangementChange,
  CHANGE_KINDS,
  ChangeKind,
  ChangeSet,
  ChannelMappingChange,
  FavouriteChange,
  GuideSourceChange,
  ProgressChange,
  PullResult,
  PushResult,
  SettingChange,
  Tombstone,
  favouriteKey,
  progressKey
} from '../../../shared/sync';
import { syncNow } from '../utils/syncClock';

/**
 * Everything one account has made, in a form two devices can reconcile.
 *
 * The unit of sync is small and deliberately not the catalogue: half a million
 * stream rows come from the provider and every device can fetch its own. What
 * has to travel is only what the user made, which is a few kilobytes.
 *
 * Reconciliation is last-write-wins on a timestamp. That is the right rule for
 * this data because the writes are one person's, made on one device at a time
 * -- there is no second author to lose an edit to, only the same person's
 * older opinion.
 */

export {
  ChangeKind,
  FavouriteChange,
  GuideSourceChange,
  ArrangementChange,
  ProgressChange,
  SettingChange,
  Tombstone,
  ChangeSet,
  ChannelMappingChange,
  PullResult,
  PushResult
} from '../../../shared/sync';


/** The beginning of time, for a device that has never synced. */
const EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * Both the cursor a pull hands back and the stamp a write carries come from
 * the same never-repeating clock, so "everything after T" cannot step over a
 * change that happened in the same millisecond as the pull.
 */
const nowIso = () => syncNow();

/**
 * Whether an incoming change is newer than what is stored.
 *
 * Equal timestamps count as not newer: a device re-sending what it already
 * sent should be a no-op, not a write.
 */
const isNewer = (incoming: string | undefined, stored: string | undefined): boolean => {
  if (!incoming) {
    return false;
  }
  return !stored || incoming > stored;
};

class SyncService {
  // --- Pull ---------------------------------------------------------------

  /**
   * Everything that changed for this account after the given moment.
   *
   * `since` is exclusive, so a device quoting the serverTime it was last given
   * does not receive that same batch again.
   */
  changesSince(userId: number, since: string = EPOCH): PullResult {
    const from = since || EPOCH;

    return {
      serverTime: nowIso(),
      favourites: this.favouritesSince(userId, from),
      arrangements: this.arrangementsSince(userId, from),
      progress: this.progressSince(userId, from),
      settings: this.settingsSince(userId, from),
      guideSources: this.guideSourcesSince(userId, from),
      channelMappings: this.channelMappingsSince(userId, from),
      deletions: this.deletionsSince(userId, from)
    };
  }

  /**
   * The guides this account uses, as sealed blobs.
   *
   * Opaque here on purpose. The label, the URL and whether it is enabled are
   * inside the payload, under a key derived from the account password -- so
   * this server stores them, hands them back, and can read none of it.
   */
  private guideSourcesSince(userId: number, since: string): GuideSourceChange[] {
    const rows = db
      .prepare(
        `SELECT id, payload, updated_at FROM guide_sources
          WHERE user_id = ? AND synced_at > ?
          ORDER BY synced_at`
      )
      .all(userId, since) as Array<{ id: string; payload: string; updated_at: string }>;

    return rows.map(row => ({ id: row.id, payload: row.payload, updatedAt: row.updated_at }));
  }

  private channelMappingsSince(userId: number, since: string): ChannelMappingChange[] {
    const rows = db
      .prepare(
        `SELECT stream_id, source_id, channel_id, updated_at FROM channel_mappings
          WHERE user_id = ? AND synced_at > ?
          ORDER BY synced_at`
      )
      .all(userId, since) as Array<{
      stream_id: string;
      source_id: string;
      channel_id: string;
      updated_at: string;
    }>;

    return rows.map(row => ({
      streamId: String(row.stream_id),
      sourceId: row.source_id,
      channelId: row.channel_id,
      updatedAt: row.updated_at
    }));
  }

  private favouritesSince(userId: number, since: string): FavouriteChange[] {
    const rows = db
      .prepare(
        `SELECT type, stream_id, name, updated_at
           FROM favorites
          WHERE user_id = ? AND synced_at > ?
          ORDER BY synced_at`
      )
      .all(userId, since) as Array<{
      type: string;
      stream_id: string;
      name: string | null;
      updated_at: string;
    }>;

    return rows.map(row => ({
      type: row.type as StreamType,
      streamId: String(row.stream_id),
      name: row.name,
      updatedAt: row.updated_at
    }));
  }

  /**
   * Arrangements, as whole lists.
   *
   * An arrangement is stored as one row per position, but it only means
   * anything entire -- half an ordering is not a smaller ordering, it is a
   * wrong one. So a scope is gathered up and sent as a unit, timestamped by
   * its most recently touched row.
   */
  private arrangementsSince(userId: number, since: string): ArrangementChange[] {
    const scopes = db
      .prepare(
        `SELECT scope, MAX(updated_at) AS updated_at, MAX(synced_at) AS synced_at
           FROM sort_order
          WHERE user_id = ?
          GROUP BY scope
         HAVING MAX(synced_at) > ?`
      )
      .all(userId, since) as Array<{ scope: string; updated_at: string }>;

    return scopes.map(({ scope, updated_at }) => {
      const rows = db
        .prepare(
          `SELECT item_id, name FROM sort_order
            WHERE user_id = ? AND scope = ?
            ORDER BY position`
        )
        .all(userId, scope) as Array<{ item_id: string; name: string | null }>;

      const names: Record<string, string> = {};
      for (const row of rows) {
        if (row.name) {
          names[String(row.item_id)] = row.name;
        }
      }

      return {
        scope,
        itemIds: rows.map(r => String(r.item_id)),
        names,
        updatedAt: updated_at
      };
    });
  }

  private progressSince(userId: number, since: string): ProgressChange[] {
    const rows = db
      .prepare(
        `SELECT * FROM watch_progress
          WHERE user_id = ? AND synced_at > ?
          ORDER BY synced_at`
      )
      .all(userId, since) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      type: row['type'] as StreamType,
      itemId: String(row['item_id']),
      seriesId: row['series_id'] === null ? null : String(row['series_id']),
      season: row['season'] as number | null,
      episodeNum: row['episode_num'] as number | null,
      name: row['name'] as string,
      episodeTitle: row['episode_title'] as string | null,
      icon: row['icon'] as string | null,
      containerExtension: row['container_extension'] as string | null,
      positionSeconds: row['position_seconds'] as number,
      durationSeconds: row['duration_seconds'] as number,
      completed: row['completed'] === 1,
      // Null rather than '' when nothing was recorded: a device has to be able
      // to tell "watched without subtitles" from "nobody has said", because
      // the second falls back to the account preference and the first does not.
      audioLanguage: (row['audio_language'] as string | null) ?? null,
      subtitleLanguage: (row['subtitle_language'] as string | null) ?? null,
      audioTitle: (row['audio_title'] as string | null) ?? null,
      subtitleTitle: (row['subtitle_title'] as string | null) ?? null,
      subtitlesEnabled:
        row['subtitles_enabled'] === null || row['subtitles_enabled'] === undefined
          ? null
          : row['subtitles_enabled'] === 1,
      updatedAt: row['updated_at'] as string
    }));
  }

  private settingsSince(userId: number, since: string): SettingChange[] {
    const rows = db
      .prepare(
        `SELECT key, value, updated_at FROM user_settings
          WHERE user_id = ? AND synced_at > ?
          ORDER BY synced_at`
      )
      .all(userId, since) as Array<{ key: string; value: string; updated_at: string }>;

    return rows.map(row => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  }

  private deletionsSince(userId: number, since: string): Tombstone[] {
    const rows = db
      .prepare(
        `SELECT kind, item_key, deleted_at FROM sync_tombstones
          WHERE user_id = ? AND synced_at > ?
          ORDER BY synced_at`
      )
      .all(userId, since) as Array<{ kind: string; item_key: string; deleted_at: string }>;

    return rows.map(row => ({
      kind: row.kind as ChangeKind,
      key: row.item_key,
      deletedAt: row.deleted_at
    }));
  }

  // --- Push ---------------------------------------------------------------

  /**
   * Takes a batch of changes from a device.
   *
   * Applied in one transaction: a device that half-syncs would leave an
   * arrangement referring to a favourite that never arrived. Anything older
   * than what is stored is discarded and counted, so a client can tell the
   * difference between "accepted" and "you were behind".
   */
  applyChanges(userId: number, incoming: Partial<ChangeSet>): PushResult {
    let applied = 0;
    let superseded = 0;

    const apply = db.transaction(() => {
      // Deletions first. A batch that both removes and re-adds the same
      // favourite means the re-add is the later intent, and doing removals
      // first lets the add win rather than being wiped by its own tombstone.
      const count = (accepted: boolean) => {
        if (accepted) {
          applied++;
        } else {
          superseded++;
        }
      };

      for (const deletion of incoming.deletions ?? []) {
        count(this.applyDeletion(userId, deletion));
      }
      for (const favourite of incoming.favourites ?? []) {
        count(this.applyFavourite(userId, favourite));
      }
      for (const arrangement of incoming.arrangements ?? []) {
        count(this.applyArrangement(userId, arrangement));
      }
      for (const entry of incoming.progress ?? []) {
        count(this.applyProgress(userId, entry));
      }
      for (const setting of incoming.settings ?? []) {
        count(this.applySetting(userId, setting));
      }
      for (const source of incoming.guideSources ?? []) {
        count(this.applyGuideSource(userId, source));
      }
      for (const mapping of incoming.channelMappings ?? []) {
        count(this.applyChannelMapping(userId, mapping));
      }
    });

    apply();
    return { applied, superseded };
  }

  private applyFavourite(userId: number, change: FavouriteChange): boolean {
    const stored = db
      .prepare('SELECT updated_at FROM favorites WHERE user_id = ? AND type = ? AND stream_id = ?')
      .get(userId, change.type, String(change.streamId)) as { updated_at?: string } | undefined;

    // A tombstone newer than this add means it was removed after being made.
    const removed = this.tombstoneFor(userId, 'favourite', this.favouriteKey(change.type, change.streamId));
    if (removed && removed >= change.updatedAt) {
      return false;
    }
    if (!isNewer(change.updatedAt, stored?.updated_at)) {
      return false;
    }

    db.prepare(
      `INSERT INTO favorites (user_id, type, stream_id, name, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, stream_id, type) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`
    ).run(
      userId,
      change.type,
      String(change.streamId),
      change.name ?? null,
      change.updatedAt,
      nowIso()
    );

    this.clearTombstone(userId, 'favourite', this.favouriteKey(change.type, change.streamId));
    return true;
  }

  private applyArrangement(userId: number, change: ArrangementChange): boolean {
    const stored = db
      .prepare('SELECT MAX(updated_at) AS updated_at FROM sort_order WHERE user_id = ? AND scope = ?')
      .get(userId, change.scope) as { updated_at?: string } | undefined;

    if (!isNewer(change.updatedAt, stored?.updated_at ?? undefined)) {
      return false;
    }

    db.prepare('DELETE FROM sort_order WHERE user_id = ? AND scope = ?').run(userId, change.scope);

    const insert = db.prepare(
      `INSERT INTO sort_order (user_id, scope, item_id, position, name, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const arrivedAt = nowIso();
    change.itemIds.forEach((id, index) =>
      insert.run(
        userId,
        change.scope,
        String(id),
        index,
        change.names?.[String(id)] ?? null,
        change.updatedAt,
        arrivedAt
      )
    );

    this.clearTombstone(userId, 'arrangement', change.scope);
    return true;
  }

  private applyProgress(userId: number, change: ProgressChange): boolean {
    const stored = db
      .prepare('SELECT updated_at FROM watch_progress WHERE user_id = ? AND type = ? AND item_id = ?')
      .get(userId, change.type, String(change.itemId)) as { updated_at?: string } | undefined;

    if (!isNewer(change.updatedAt, stored?.updated_at)) {
      return false;
    }

    db.prepare(
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
         -- Kept when the arriving change says nothing, so a device whose
         -- player cannot report its tracks does not make every device forget.
         audio_language = COALESCE(excluded.audio_language, watch_progress.audio_language),
         subtitle_language = COALESCE(excluded.subtitle_language, watch_progress.subtitle_language),
         audio_title = COALESCE(excluded.audio_title, watch_progress.audio_title),
         subtitle_title = COALESCE(excluded.subtitle_title, watch_progress.subtitle_title),
         subtitles_enabled = COALESCE(excluded.subtitles_enabled, watch_progress.subtitles_enabled),
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`
    ).run(
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
      nowIso()
    );

    this.clearTombstone(userId, 'progress', this.progressKey(change.type, change.itemId));
    return true;
  }

  private applySetting(userId: number, change: SettingChange): boolean {
    const stored = db
      .prepare('SELECT updated_at FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, change.key) as { updated_at?: string } | undefined;

    if (!isNewer(change.updatedAt, stored?.updated_at)) {
      return false;
    }

    db.prepare(
      `INSERT INTO user_settings (user_id, key, value, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`
    ).run(userId, change.key, change.value, change.updatedAt, nowIso());

    return true;
  }

  /**
   * A guide the account uses.
   *
   * Weighed against a tombstone the way a favourite is, and for the same
   * reason: a source removed on the television and still held by the phone
   * would come back on the phone's next push, and removing a guide would be
   * impossible to make stick.
   */
  private applyGuideSource(userId: number, change: GuideSourceChange): boolean {
    if (!change.id || !change.payload) {
      return false;
    }

    const removed = this.tombstoneFor(userId, 'guideSource', change.id);
    if (removed && removed >= change.updatedAt) {
      return false;
    }

    const stored = db
      .prepare('SELECT updated_at FROM guide_sources WHERE user_id = ? AND id = ?')
      .get(userId, change.id) as { updated_at?: string } | undefined;

    if (!isNewer(change.updatedAt, stored?.updated_at)) {
      return false;
    }

    db.prepare(
      `INSERT INTO guide_sources (user_id, id, payload, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, id) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`
    ).run(userId, change.id, change.payload, change.updatedAt, nowIso());

    this.clearTombstone(userId, 'guideSource', change.id);
    return true;
  }

  /**
   * One stream tied by hand to one guide channel.
   *
   * Keyed by the stream, because a stream takes its guide from one place and
   * choosing which is exactly what was decided.
   */
  private applyChannelMapping(userId: number, change: ChannelMappingChange): boolean {
    const streamId = String(change.streamId ?? '');
    if (!streamId || !change.sourceId || !change.channelId) {
      return false;
    }

    const removed = this.tombstoneFor(userId, 'channelMapping', streamId);
    if (removed && removed >= change.updatedAt) {
      return false;
    }

    const stored = db
      .prepare('SELECT updated_at FROM channel_mappings WHERE user_id = ? AND stream_id = ?')
      .get(userId, streamId) as { updated_at?: string } | undefined;

    if (!isNewer(change.updatedAt, stored?.updated_at)) {
      return false;
    }

    db.prepare(
      `INSERT INTO channel_mappings
         (user_id, stream_id, source_id, channel_id, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, stream_id) DO UPDATE SET
         source_id = excluded.source_id,
         channel_id = excluded.channel_id,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`
    ).run(userId, streamId, change.sourceId, change.channelId, change.updatedAt, nowIso());

    this.clearTombstone(userId, 'channelMapping', streamId);
    return true;
  }

  private applyDeletion(userId: number, tombstone: Tombstone): boolean {
    if (!CHANGE_KINDS.includes(tombstone.kind)) {
      return false;
    }

    // Already buried, at or after this moment. Re-recording it would write the
    // same row and delete the same nothing, and a device offering a new server
    // everything it holds sends exactly this.
    const buried = this.tombstoneFor(userId, tombstone.kind, tombstone.key);
    if (buried && buried >= tombstone.deletedAt) {
      return false;
    }

    this.recordDeletion(userId, tombstone.kind, tombstone.key, tombstone.deletedAt);
    this.removeRowFor(userId, tombstone.kind, tombstone.key, tombstone.deletedAt);
    return true;
  }

  // --- Deletions ----------------------------------------------------------

  /**
   * Notes that something was removed.
   *
   * Called by the ordinary remove paths as well as by sync, because a deletion
   * that only some devices hear about is worse than one nobody hears about --
   * the row comes back the next time an older device pushes.
   */
  recordDeletion(userId: number, kind: ChangeKind, key: string, at: string = nowIso()): void {
    db.prepare(
      `INSERT INTO sync_tombstones (user_id, kind, item_key, deleted_at, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, kind, item_key) DO UPDATE SET
         deleted_at = MAX(sync_tombstones.deleted_at, excluded.deleted_at),
         synced_at = excluded.synced_at`
    ).run(userId, kind, key, at, nowIso());
  }

  /**
   * Forgets that something was removed, because it has been made again.
   *
   * A tombstone outliving the thing's return would have the next pull delete
   * it right back off the device that just re-added it.
   */
  recordUndelete(userId: number, kind: ChangeKind, key: string): void {
    this.clearTombstone(userId, kind, key);
  }

  /**
   * Kept as methods because callers all over the service use them, but the
   * spelling is shared: a device builds tombstones with the same helpers, and
   * a key the two ends disagreed about would be a deletion that never lands.
   */
  favouriteKey(type: StreamType, streamId: string): string {
    return favouriteKey(type, streamId);
  }

  progressKey(type: StreamType, itemId: string): string {
    return progressKey(type, itemId);
  }

  private tombstoneFor(userId: number, kind: ChangeKind, key: string): string | null {
    const row = db
      .prepare('SELECT deleted_at FROM sync_tombstones WHERE user_id = ? AND kind = ? AND item_key = ?')
      .get(userId, kind, key) as { deleted_at?: string } | undefined;
    return row?.deleted_at ?? null;
  }

  private clearTombstone(userId: number, kind: ChangeKind, key: string): void {
    db.prepare('DELETE FROM sync_tombstones WHERE user_id = ? AND kind = ? AND item_key = ?').run(
      userId,
      kind,
      key
    );
  }

  /** Removes the row a tombstone refers to, if it has not since been rewritten. */
  private removeRowFor(userId: number, kind: ChangeKind, key: string, deletedAt: string): void {
    if (kind === 'arrangement') {
      db.prepare('DELETE FROM sort_order WHERE user_id = ? AND scope = ? AND updated_at <= ?').run(
        userId,
        key,
        deletedAt
      );
      return;
    }

    if (kind === 'guideSource') {
      db.prepare('DELETE FROM guide_sources WHERE user_id = ? AND id = ? AND updated_at <= ?').run(
        userId,
        key,
        deletedAt
      );
      return;
    }

    if (kind === 'channelMapping') {
      db.prepare(
        'DELETE FROM channel_mappings WHERE user_id = ? AND stream_id = ? AND updated_at <= ?'
      ).run(userId, key, deletedAt);
      return;
    }

    const [type, id] = this.splitKey(key);
    if (!type || !id) {
      return;
    }

    if (kind === 'favourite') {
      db.prepare(
        'DELETE FROM favorites WHERE user_id = ? AND type = ? AND stream_id = ? AND (updated_at IS NULL OR updated_at <= ?)'
      ).run(userId, type, id, deletedAt);
    } else if (kind === 'progress') {
      db.prepare(
        'DELETE FROM watch_progress WHERE user_id = ? AND type = ? AND item_id = ? AND updated_at <= ?'
      ).run(userId, type, id, deletedAt);
    } else if (kind === 'setting') {
      db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ? AND updated_at <= ?').run(
        userId,
        key,
        deletedAt
      );
    }
  }

  /** Splits `type:id`, keeping any colons that belong to the id itself. */
  private splitKey(key: string): [string, string] {
    const at = key.indexOf(':');
    return at === -1 ? ['', ''] : [key.slice(0, at), key.slice(at + 1)];
  }

  // --- Settings -----------------------------------------------------------

  getSettings(userId: number): Record<string, string> {
    const rows = db
      .prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
      .all(userId) as Array<{ key: string; value: string }>;

    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  saveSettings(userId: number, settings: Record<string, string>): void {
    const at = nowIso();
    const save = db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        this.applySetting(userId, { key, value, updatedAt: at });
      }
    });
    save();
  }

  /**
   * Drops tombstones older than every device could plausibly need.
   *
   * They exist only to stop a stale device resurrecting something. A device
   * that has been away longer than this needs a full pull rather than a diff,
   * so keeping its tombstones forever buys nothing.
   */
  pruneTombstones(olderThanDays = 90): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
    return db.prepare('DELETE FROM sync_tombstones WHERE deleted_at < ?').run(cutoff).changes;
  }
}

export const syncService = new SyncService();
