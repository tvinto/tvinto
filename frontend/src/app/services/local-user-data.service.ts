import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Stream, StreamType, WatchProgress, WatchProgressInput } from '@shared/types';
import { TrackChoice } from '@shared/player';
import { PlatformService } from './platform.service';
import {
  ArrangementChange,
  ChangeSet,
  ChannelMappingChange,
  GuideSourceChange,
  FavouriteChange,
  ProgressChange,
  Tombstone,
  emptyChangeSet,
  favouriteKey,
  isEmptyChangeSet,
  progressKey
} from '@shared/sync';
import { accountStorageKey, adoptableLegacyValue } from '../utils/account-storage.utils';
import { takeBrought } from '../utils/local-drawers.utils';
import { changeSetFrom } from '../utils/sync-queue.utils';
import { AccountService } from './account.service';
import { t } from '../utils/i18n';

/**
 * A favourite, plus what it takes to draw it.
 *
 * The change that travels carries a name and nothing else, because the server
 * hydrates a favourite from its own copy of the catalogue. A device has no such
 * luxury while the backend is unreachable, so the few display fields are kept
 * beside it -- they are in hand at the moment of starring, and they cost a
 * couple of hundred bytes each.
 */
interface StoredFavourite {
  change: FavouriteChange;
  icon: string;
}

interface LocalState {
  favourites: Record<string, StoredFavourite>;
  progress: Record<string, ProgressChange>;
  arrangements: Record<string, ArrangementChange>;
  tombstones: Record<string, Tombstone>;
  /** Written but not yet accepted by the server. */
  pending: ChangeSet;
}

const STORAGE_PREFIX = 'xtream_local_data';

/**
 * Whether stored text is an account rather than an empty shell.
 *
 * The queue is deliberately not counted. A drawer holding only a queue is one
 * this app created and never filled.
 */
const holdsSomething = (raw: string): boolean => {
  try {
    const parsed = JSON.parse(raw) as Partial<LocalState>;
    return (
      Object.keys(parsed.favourites ?? {}).length > 0 ||
      Object.keys(parsed.progress ?? {}).length > 0 ||
      Object.keys(parsed.arrangements ?? {}).length > 0 ||
      Object.keys(parsed.tombstones ?? {}).length > 0
    );
  } catch {
    return false;
  }
};

const empty = (): LocalState => ({
  favourites: {},
  progress: {},
  arrangements: {},
  tombstones: {},
  pending: emptyChangeSet()
});

/**
 * The account's own work, kept on the device.
 *
 * The catalogue went local first because it is large and the provider can
 * supply it. This is the opposite kind of data: tiny, and reproducible from
 * nowhere but the user. Until now it was written straight to the backend, which
 * meant a device away from the PC could watch anything and remember nothing --
 * no star would stick, no resume point would be kept.
 *
 * Every write lands here first and is queued for the server. That ordering is
 * the point: the local copy is the truth the screen is drawn from, and the
 * server is where it gets reconciled with the account's other devices. A write
 * made with the backend unreachable is not lost, it is merely not yet
 * everywhere.
 *
 * Only on a device. A browser keeps writing straight to the server, where it
 * has always worked and where there is no offline case worth the complexity.
 */
@Injectable({ providedIn: 'root' })
export class LocalUserDataService {
  private readonly accounts = inject(AccountService);

  /** Whether this build keeps its own copy. */
  readonly enabled = inject(PlatformService).keepsLocalData;

  private readonly state = signal<LocalState>(empty());

  /** Bumped whenever something changes, so views can refetch. */
  readonly revision = computed(() => this.state());

  /** Whether anything written here is still waiting for the server. */
  readonly hasPending = computed(() => !isEmptyChangeSet(this.state().pending));

  private loadedFor: string | null = null;
  private lastSignOut = 0;

  constructor() {
    // Signing out empties this, and the watching goes this way round on
    // purpose: this service has to know whose data it holds, so it depends on
    // AccountService, and AccountService reaching back would be a cycle.
    //
    // Anything still queued goes with it, which is the right trade -- an unsent
    // change belongs to a session that has been ended deliberately.
    //
    // Deliberately is the whole of it. This used to watch the account going
    // null, which a refused token does as well: a session idling out overnight,
    // or the app being pointed at a different server, would have this throw
    // away the only copy of the account that is not on a server -- including
    // the copy it was about to offer the new one.
    effect(() => {
      const signOuts = this.accounts.deliberateSignOuts();
      untracked(() => {
        // Nothing on the first run, which is startup rather than a sign-out.
        if (signOuts !== this.lastSignOut) {
          this.lastSignOut = signOuts;
          this.clear();
        }
      });
    });
  }

  // --- Reading ------------------------------------------------------------

  /**
   * The favourited streams for a type, as much of them as was kept.
   *
   * A favourite is stored with its name and its logo, because a device has to
   * be able to draw the rail with nothing to hydrate it from. Only the name
   * travels between devices, though: the logo is a URL into the provider and
   * not the sort of thing the change feed carries. So a favourite starred on
   * the laptop arrives here as a name and no picture, and one starred before
   * names travelled arrives as neither -- which drew a card with a star, a
   * placeholder glyph, and nothing else on it at all.
   *
   * The watch history is asked for what is missing. It is the same channels,
   * on the same device, and it keeps both.
   */
  favourites(type: StreamType): Stream[] {
    const state = this.load();

    return Object.values(state.favourites)
      .filter(entry => entry.change.type === type && !this.isDeleted(state, 'favourite', favouriteKey(type, entry.change.streamId)))
      .map(entry => {
        const known = state.progress[progressKey(type, String(entry.change.streamId))];
        const icon = entry.icon || known?.icon || '';

        return {
          stream_id: entry.change.streamId,
          // The id last, so a card is never blank. It is not a name anybody
          // would choose, and it is something to click on and recognise.
          name: entry.change.name || known?.name || t('section.channelN', { number: entry.change.streamId }),
          icon,
          stream_icon: icon,
          type
        };
      }) as unknown as Stream[];
  }

  favouriteIds(type: StreamType): string[] {
    return this.favourites(type).map(stream => String(stream.stream_id));
  }

  /** Watch history for a type, newest first. */
  recent(type: StreamType, limit: number): WatchProgress[] {
    const state = this.load();

    return Object.values(state.progress)
      .filter(entry => entry.type === type && !this.isDeleted(state, 'progress', progressKey(type, entry.itemId)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(entry => this.toWatchProgress(entry));
  }

  /** Positions for a set of items, keyed by item id. */
  progressFor(type: StreamType, itemIds: string[]): Record<string, WatchProgress> {
    const state = this.load();
    const found: Record<string, WatchProgress> = {};

    for (const itemId of itemIds) {
      const entry = state.progress[progressKey(type, String(itemId))];
      if (entry && !this.isDeleted(state, 'progress', progressKey(type, String(itemId)))) {
        found[String(itemId)] = this.toWatchProgress(entry);
      }
    }

    return found;
  }

  /** Every episode position for one show, keyed by episode id. */
  seriesProgress(seriesId: string): Record<string, WatchProgress> {
    const state = this.load();
    const found: Record<string, WatchProgress> = {};

    for (const entry of Object.values(state.progress)) {
      if (entry.seriesId === String(seriesId)) {
        found[entry.itemId] = this.toWatchProgress(entry);
      }
    }

    return found;
  }

  /** Every arrangement kept here, for tvinto without an account (LocalToolService). */
  arrangements(): ArrangementChange[] {
    // An emptied arrangement is one taken away.
    return Object.values(this.state().arrangements).filter(arrangement => arrangement.itemIds.length > 0);
  }

  manualOrder(scope: string): string[] {
    const state = this.load();
    if (this.isDeleted(state, 'arrangement', scope)) {
      return [];
    }
    return state.arrangements[scope]?.itemIds ?? [];
  }

  /** When a list was last arranged, here or on another device; null when it has no arrangement. */
  arrangedAt(scope: string): string | null {
    const state = this.load();
    const arrangement = state.arrangements[scope];
    if (!arrangement?.itemIds.length || this.isDeleted(state, 'arrangement', scope)) {
      return null;
    }
    return arrangement.updatedAt;
  }

  // --- Writing ------------------------------------------------------------

  setFavourite(stream: Stream, type: StreamType, favourite: boolean): void {
    const streamId = String(stream.stream_id);
    const key = favouriteKey(type, streamId);
    const at = this.now();

    this.mutate(state => {
      if (!favourite) {
        delete state.favourites[key];
        this.remember(state, { kind: 'favourite', key, deletedAt: at });
        return;
      }

      const change: FavouriteChange = { type, streamId, name: stream.name ?? null, updatedAt: at };
      state.favourites[key] = { change, icon: stream.stream_icon || stream.icon || '' };
      this.forget(state, 'favourite', key);
      state.pending.favourites.push(change);
    });
  }

  /**
   * Moves favourites and history from old ids to new ones, for a provider
   * that was replaced by one numbering the same things differently (see
   * shared/providers/carryOver.ts). History keeps the time it was watched, so
   * the order of Continue watching does not change; the old ids are deleted
   * the way an unstar is, so no device puts them back. Episodes are not moved:
   * their ids come from each show's details, which nothing here has read.
   */
  moveItems(type: StreamType, moves: ReadonlyMap<string, { id: string; name: string }>): number {
    let moved = 0;
    const at = this.now();

    this.mutate(state => {
      for (const [from, to] of moves) {
        const oldFavourite = favouriteKey(type, from);
        const favourite = state.favourites[oldFavourite];
        if (favourite && !this.isDeleted(state, 'favourite', oldFavourite)) {
          const change: FavouriteChange = {
            ...favourite.change,
            streamId: to.id,
            name: to.name || favourite.change.name,
            updatedAt: at
          };
          const newFavourite = favouriteKey(type, to.id);
          state.favourites[newFavourite] = { change, icon: favourite.icon };
          this.forget(state, 'favourite', newFavourite);
          state.pending.favourites.push(change);
          delete state.favourites[oldFavourite];
          this.remember(state, { kind: 'favourite', key: oldFavourite, deletedAt: at });
          moved++;
        }

        const oldProgress = progressKey(type, from);
        const progress = state.progress[oldProgress];
        if (type !== 'series' && progress && !this.isDeleted(state, 'progress', oldProgress)) {
          const change: ProgressChange = { ...progress, itemId: to.id };
          const newProgress = progressKey(type, to.id);
          state.progress[newProgress] = change;
          this.forget(state, 'progress', newProgress);
          state.pending.progress = state.pending.progress.filter(
            existing => progressKey(existing.type, existing.itemId) !== newProgress
          );
          state.pending.progress.push(change);
          delete state.progress[oldProgress];
          this.remember(state, { kind: 'progress', key: oldProgress, deletedAt: at });
          moved++;
        }
      }
    });

    return moved;
  }

  /**
   * Custom orders, moved with their categories and channels (see `moveItems`):
   * a category's arrangement goes to the new category's scope, and the ids in
   * every arrangement are replaced by the new ones.
   */
  moveArrangements(
    moveScope: (scope: string) => string,
    moveId: (id: string) => string | undefined
  ): number {
    const state = this.load();
    let moved = 0;
    for (const [scope, arrangement] of Object.entries(state.arrangements)) {
      if (this.isDeleted(state, 'arrangement', scope)) {
        continue;
      }
      const target = moveScope(scope);
      const itemIds = arrangement.itemIds.map(id => moveId(id) ?? id);
      const changed = target !== scope || itemIds.some((id, i) => id !== arrangement.itemIds[i]);
      if (!changed) {
        continue;
      }
      const names = Object.fromEntries(
        Object.entries(arrangement.names ?? {}).map(([id, name]) => [moveId(id) ?? id, name])
      );
      this.saveManualOrder(target, itemIds, names);
      if (target !== scope) {
        this.saveManualOrder(scope, []);
      }
      moved++;
    }
    return moved;
  }

  saveProgress(entry: WatchProgressInput): WatchProgress {
    const at = this.now();
    const change: ProgressChange = {
      type: entry.type,
      itemId: String(entry.itemId),
      seriesId: entry.seriesId != null ? String(entry.seriesId) : null,
      season: entry.season ?? null,
      episodeNum: entry.episodeNum ?? null,
      name: entry.name ?? '',
      episodeTitle: entry.episodeTitle ?? null,
      icon: entry.icon ?? null,
      containerExtension: entry.containerExtension ?? null,
      positionSeconds: Math.max(0, Math.floor(entry.positionSeconds ?? 0)),
      durationSeconds: Math.max(0, Math.floor(entry.durationSeconds ?? 0)),
      completed: !!entry.completed,
      updatedAt: at
    };

    this.mutate(state => {
      const key = progressKey(change.type, change.itemId);

      // Carried over from what is already held, because most writes are the
      // position ticking on and say nothing about tracks. Only `rememberTracks`
      // sets them, and dropping them here would forget the choice ten seconds
      // into every film.
      const held = state.progress[key];

      // A player closed before its stream loaded knows where it was asked to
      // start but not how long the film is. The length already known stands,
      // or the progress bar and "28 min left" go with it (The Last Bus E3,
      // Back on the opening panel, 25 September).
      if (change.type !== 'live' && change.durationSeconds === 0 && (held?.durationSeconds ?? 0) > 0) {
        change.durationSeconds = held.durationSeconds;
      }

      change.audioLanguage = held?.audioLanguage ?? null;
      change.subtitleLanguage = held?.subtitleLanguage ?? null;
      change.audioTitle = held?.audioTitle ?? null;
      change.subtitleTitle = held?.subtitleTitle ?? null;
      change.subtitlesEnabled = held?.subtitlesEnabled ?? null;

      // Tracks the player reported before there was anything to write them on.
      const waiting = this.tracksWaiting.get(key);
      if (waiting) {
        this.tracksWaiting.delete(key);
        change.audioLanguage = waiting.audioLanguage || null;
        change.subtitleLanguage = waiting.subtitleLanguage || null;
        change.audioTitle = waiting.audioTitle || null;
        change.subtitleTitle = waiting.subtitleTitle || null;
        change.subtitlesEnabled = waiting.subtitlesEnabled;
      }

      state.progress[key] = change;
      this.forget(state, 'progress', key);

      // One entry per item in the queue. Watching an hour writes a position
      // every ten seconds, and a queue that kept all of them would push three
      // hundred rows describing the same moment.
      state.pending.progress = state.pending.progress.filter(
        existing => progressKey(existing.type, existing.itemId) !== key
      );
      state.pending.progress.push(change);
    });

    return this.toWatchProgress(change);
  }

  /**
   * The tracks this item was last watched with, or null if nobody has said.
   *
   * Null and "no subtitles" are different answers: the first falls back to the
   * account preference, and the second is a decision to be honoured.
   */
  tracksFor(type: StreamType, itemId: string): TrackChoice | null {
    const entry = this.load().progress[progressKey(type, String(itemId))];

    if (!entry || typeof entry.subtitlesEnabled !== 'boolean') {
      return null;
    }

    return {
      audioLanguage: entry.audioLanguage ?? '',
      subtitleLanguage: entry.subtitleLanguage ?? '',
      audioTitle: entry.audioTitle ?? '',
      subtitleTitle: entry.subtitleTitle ?? '',
      subtitlesEnabled: entry.subtitlesEnabled
    };
  }

  /**
   * The tracks chosen most recently for any episode of a show, or null.
   *
   * What an episode with no choice of its own opens with. A choice is written
   * against the episode it was made in, so the next episode opened from the
   * show's page -- rather than reached by the player going on by itself --
   * found nothing and fell back to the account's preference: Stereo and no
   * subtitles, one episode after English and English (26
   * September).
   */
  tracksForShow(seriesId: string): TrackChoice | null {
    let latest: ProgressChange | null = null;
    for (const entry of Object.values(this.load().progress)) {
      if (
        entry.type === 'series' &&
        entry.seriesId != null &&
        String(entry.seriesId) === String(seriesId) &&
        typeof entry.subtitlesEnabled === 'boolean' &&
        (!latest || entry.updatedAt >= latest.updatedAt)
      ) {
        latest = entry;
      }
    }
    return latest ? this.tracksFor('series', latest.itemId) : null;
  }

  /** Which show an episode belongs to, as far as this device has heard. */
  showOf(itemId: string): string | null {
    const entry = this.load().progress[progressKey('series', String(itemId))];
    return entry?.seriesId != null ? String(entry.seriesId) : null;
  }

  /**
   * Records what a player ended up playing, against this item.
   *
   * Queued like any other change, so the choice reaches the account's other
   * devices: start a film on the television with Croatian subtitles and it
   * opens the same way on the phone.
   */
  /** Tracks reported for an item with no position yet, by key; see `rememberTracks`. */
  private readonly tracksWaiting = new Map<string, TrackChoice>();

  rememberTracks(type: StreamType, itemId: string, chosen: TrackChoice): void {
    const key = progressKey(type, String(itemId));

    this.mutate(state => {
      const held = state.progress[key];
      if (!held) {
        // Nothing to hang it on yet. The comment here said a position is
        // always written first; it is not -- the player's answer is read,
        // tracks and all, before the page writes where it got to, so the
        // first episode of anything watched lost its choice (S4 E14,
        // 26 September). Kept until that position arrives.
        this.tracksWaiting.set(key, chosen);
        return;
      }

      const change: ProgressChange = {
        ...held,
        audioLanguage: chosen.audioLanguage || null,
        subtitleLanguage: chosen.subtitleLanguage || null,
        audioTitle: chosen.audioTitle || null,
        subtitleTitle: chosen.subtitleTitle || null,
        subtitlesEnabled: chosen.subtitlesEnabled,
        // The stamp moves, because this is a new thing said about the item and
        // the servers reconcile on stamps.
        updatedAt: this.now()
      };

      state.progress[key] = change;
      this.forget(state, 'progress', key);
      state.pending.progress = state.pending.progress.filter(
        existing => progressKey(existing.type, existing.itemId) !== key
      );
      state.pending.progress.push(change);
    });
  }

  removeProgress(type: StreamType, itemId: string): void {
    const key = progressKey(type, String(itemId));
    const at = this.now();

    this.mutate(state => {
      delete state.progress[key];
      state.pending.progress = state.pending.progress.filter(
        existing => progressKey(existing.type, existing.itemId) !== key
      );
      this.remember(state, { kind: 'progress', key, deletedAt: at });
    });
  }

  saveManualOrder(scope: string, itemIds: string[], names: Record<string, string> = {}): void {
    const at = this.now();
    const change: ArrangementChange = { scope, itemIds: itemIds.map(String), names, updatedAt: at };

    this.mutate(state => {
      state.arrangements[scope] = change;

      if (itemIds.length === 0) {
        // An emptied arrangement leaves no rows to carry a timestamp, so the
        // fact of the clearing has to be recorded as a deletion of its own.
        this.remember(state, { kind: 'arrangement', key: scope, deletedAt: at });
        return;
      }

      this.forget(state, 'arrangement', scope);
      state.pending.arrangements = state.pending.arrangements.filter(a => a.scope !== scope);
      state.pending.arrangements.push(change);
    });
  }

  /**
   * Queues everything held, for a server that has never heard of this device.
   *
   * The queue normally carries only what has not been sent, which is right
   * until the thing it was sent to stops being the thing being talked to.
   * Then the queue is empty and the local copy is the only record of years of
   * starring and watching.
   *
   * Rebuilt rather than appended to, so running it twice is the same as
   * running it once. Nothing is lost by rebuilding: a change waiting in the
   * queue is also in the state it was written to, which is what the screen has
   * been drawn from all along.
   */
  requeueEverything(): void {
    if (!this.enabled) {
      return;
    }

    this.mutate(state => {
      state.pending = changeSetFrom({
        favourites: Object.values(state.favourites).map(entry => entry.change),
        progress: Object.values(state.progress),
        arrangements: Object.values(state.arrangements),
        tombstones: Object.values(state.tombstones),
        // The guides are queued by the service that owns them, which has to
        // seal a source before it can be sent.
        guideSources: state.pending.guideSources ?? [],
        channelMappings: state.pending.channelMappings ?? []
      });
    });
  }

  // --- Guides -------------------------------------------------------------

  /**
   * Queues a guide source, or its removal.
   *
   * The state itself lives in GuideSourcesService, which owns it and knows how
   * to seal it; what lives here is the queue, the tombstones and the promise
   * that a write made with no server in reach still reaches one eventually.
   * Splitting it that way keeps one owner per kind of data and one owner of
   * the outbox.
   *
   * The stamp is the caller's, not this service's clock, which is the one
   * place that differs from favourites and history. The guide state keeps its
   * own copy of when a source changed, and the two must be the same string or
   * this device would reconcile against its own writes and lose to them.
   */
  queueGuideSource(id: string, payload: string, updatedAt: string): GuideSourceChange | null {
    if (!this.enabled) {
      return null;
    }

    const change: GuideSourceChange = { id, payload, updatedAt };

    this.mutate(state => {
      this.forget(state, 'guideSource', id);
      // One entry per source: two edits before a push should send the later.
      state.pending.guideSources = (state.pending.guideSources ?? []).filter(
        existing => existing.id !== id
      );
      state.pending.guideSources.push(change);
    });

    return change;
  }

  queueGuideSourceRemoval(id: string): void {
    if (!this.enabled) {
      return;
    }

    this.mutate(state => {
      state.pending.guideSources = (state.pending.guideSources ?? []).filter(
        existing => existing.id !== id
      );
      this.remember(state, { kind: 'guideSource', key: id, deletedAt: this.now() });
    });
  }

  queueChannelMapping(
    mapping: { streamId: string; sourceId: string; channelId: string },
    updatedAt: string
  ): void {
    if (!this.enabled) {
      return;
    }

    const change: ChannelMappingChange = { ...mapping, updatedAt };

    this.mutate(state => {
      this.forget(state, 'channelMapping', change.streamId);
      state.pending.channelMappings = (state.pending.channelMappings ?? []).filter(
        existing => existing.streamId !== change.streamId
      );
      state.pending.channelMappings.push(change);
    });
  }

  queueChannelMappingRemoval(streamId: string): void {
    if (!this.enabled) {
      return;
    }

    this.mutate(state => {
      state.pending.channelMappings = (state.pending.channelMappings ?? []).filter(
        existing => existing.streamId !== streamId
      );
      this.remember(state, { kind: 'channelMapping', key: streamId, deletedAt: this.now() });
    });
  }

  // --- Syncing ------------------------------------------------------------

  /** What is waiting to go to the server. */
  pending(): ChangeSet {
    const { pending } = this.load();
    // Each list defaulted, because this is read back from storage written by
    // an older build of the app, which had no field for a kind added since.
    return {
      favourites: [...(pending.favourites ?? [])],
      arrangements: [...(pending.arrangements ?? [])],
      progress: [...(pending.progress ?? [])],
      settings: [...(pending.settings ?? [])],
      guideSources: [...(pending.guideSources ?? [])],
      channelMappings: [...(pending.channelMappings ?? [])],
      deletions: [...(pending.deletions ?? [])]
    };
  }

  /**
   * Drops exactly what was sent, and nothing that arrived while it was in
   * flight.
   *
   * Clearing the queue wholesale would lose a star made during the request --
   * which is a second or two on a slow connection, and precisely when someone
   * is pressing buttons.
   */
  accept(sent: ChangeSet): void {
    this.mutate(state => {
      const gone = <T>(list: T[], was: T[], identity: (item: T) => string) => {
        const sentKeys = new Set(was.map(identity));
        return list.filter(item => !sentKeys.has(identity(item)));
      };

      state.pending.favourites = gone(state.pending.favourites, sent.favourites, f =>
        `${favouriteKey(f.type, f.streamId)}@${f.updatedAt}`
      );
      state.pending.progress = gone(state.pending.progress, sent.progress, p =>
        `${progressKey(p.type, p.itemId)}@${p.updatedAt}`
      );
      state.pending.arrangements = gone(state.pending.arrangements, sent.arrangements, a =>
        `${a.scope}@${a.updatedAt}`
      );
      state.pending.settings = gone(state.pending.settings, sent.settings, s =>
        `${s.key}@${s.updatedAt}`
      );
      state.pending.guideSources = gone(
        state.pending.guideSources ?? [],
        sent.guideSources ?? [],
        s => `${s.id}@${s.updatedAt}`
      );
      state.pending.channelMappings = gone(
        state.pending.channelMappings ?? [],
        sent.channelMappings ?? [],
        m => `${m.streamId}@${m.updatedAt}`
      );
      state.pending.deletions = gone(state.pending.deletions, sent.deletions, d =>
        `${d.kind}:${d.key}@${d.deletedAt}`
      );
    });
  }

  /**
   * Folds what the server sent into the local copy.
   *
   * Last-write-wins on the timestamp, the same rule the server applies, so both
   * ends reach the same answer from the same facts rather than one deferring to
   * the other.
   */
  applyIncoming(incoming: Partial<ChangeSet>): void {
    if (!this.enabled) {
      return;
    }

    this.mutate(state => {
      for (const deletion of incoming.deletions ?? []) {
        this.remember(state, deletion);

        if (deletion.kind === 'favourite') {
          this.dropIfOlder(state.favourites, deletion.key, deletion.deletedAt, e => e.change.updatedAt);
        } else if (deletion.kind === 'progress') {
          this.dropIfOlder(state.progress, deletion.key, deletion.deletedAt, e => e.updatedAt);
        } else if (deletion.kind === 'arrangement') {
          this.dropIfOlder(state.arrangements, deletion.key, deletion.deletedAt, e => e.updatedAt);
        }
      }

      for (const change of incoming.favourites ?? []) {
        const key = favouriteKey(change.type, change.streamId);
        if (this.isNewer(change.updatedAt, state.favourites[key]?.change.updatedAt)) {
          // The icon is not in the change; keep whatever this device had.
          state.favourites[key] = { change, icon: state.favourites[key]?.icon ?? '' };
          this.forget(state, 'favourite', key);
        }
      }

      for (const change of incoming.progress ?? []) {
        const key = progressKey(change.type, change.itemId);
        if (this.isNewer(change.updatedAt, state.progress[key]?.updatedAt)) {
          const held = state.progress[key];

          state.progress[key] = {
            ...change,
            // A device whose player cannot report tracks sends progress with
            // nothing in these fields. Taking that as the answer would have
            // one such device erase, on every device, the choice another one
            // learned. The servers coalesce the same way.
            audioLanguage: change.audioLanguage ?? held?.audioLanguage ?? null,
            subtitleLanguage: change.subtitleLanguage ?? held?.subtitleLanguage ?? null,
            audioTitle: change.audioTitle ?? held?.audioTitle ?? null,
            subtitleTitle: change.subtitleTitle ?? held?.subtitleTitle ?? null,
            subtitlesEnabled: change.subtitlesEnabled ?? held?.subtitlesEnabled ?? null
          };
          this.forget(state, 'progress', key);
        }
      }

      for (const change of incoming.arrangements ?? []) {
        if (this.isNewer(change.updatedAt, state.arrangements[change.scope]?.updatedAt)) {
          state.arrangements[change.scope] = change;
          this.forget(state, 'arrangement', change.scope);
        }
      }
    });
  }

  /** Forgets everything, for a sign-out. */
  clear(): void {
    // The copy that was in use, not whoever is current by the time this runs:
    // a sign-out has the device go on without an account at once, and the
    // name read now would be that one's (LocalProfileService).
    const key = this.loadedFor ?? this.storageKey();
    this.state.set(empty());
    this.loadedFor = null;
    try {
      localStorage.removeItem(key);
    } catch {
      // The in-memory copy is already gone, which is what reads consult.
    }
  }

  // --- Internals ----------------------------------------------------------

  private toWatchProgress(entry: ProgressChange): WatchProgress {
    return {
      type: entry.type,
      itemId: entry.itemId,
      seriesId: entry.seriesId ?? undefined,
      season: entry.season ?? undefined,
      episodeNum: entry.episodeNum ?? undefined,
      name: entry.name,
      episodeTitle: entry.episodeTitle ?? undefined,
      icon: entry.icon ?? '',
      containerExtension: entry.containerExtension ?? undefined,
      positionSeconds: entry.positionSeconds,
      durationSeconds: entry.durationSeconds,
      completed: entry.completed,
      updatedAt: entry.updatedAt
    } as unknown as WatchProgress;
  }

  private remember(state: LocalState, tombstone: Tombstone): void {
    state.tombstones[`${tombstone.kind}:${tombstone.key}`] = tombstone;
    state.pending.deletions = state.pending.deletions.filter(
      existing => !(existing.kind === tombstone.kind && existing.key === tombstone.key)
    );
    state.pending.deletions.push(tombstone);
  }

  /** Something removed has been made again, so the tombstone must go. */
  private forget(state: LocalState, kind: Tombstone['kind'], key: string): void {
    delete state.tombstones[`${kind}:${key}`];
    state.pending.deletions = state.pending.deletions.filter(
      existing => !(existing.kind === kind && existing.key === key)
    );
  }

  private isDeleted(state: LocalState, kind: Tombstone['kind'], key: string): boolean {
    return !!state.tombstones[`${kind}:${key}`];
  }

  private dropIfOlder<T>(
    bag: Record<string, T>,
    key: string,
    deletedAt: string,
    stampOf: (item: T) => string
  ): void {
    const held = bag[key];
    if (held && stampOf(held) <= deletedAt) {
      delete bag[key];
    }
  }

  private isNewer(candidate: string, held: string | undefined): boolean {
    return !held || candidate > held;
  }

  /**
   * A timestamp that never repeats within this device.
   *
   * Two writes in the same millisecond -- a star and an unstar on a remote, or
   * a progress report landing on a tick boundary -- would otherwise tie, and
   * last-write-wins has no answer for a tie.
   */
  private lastStamp = '';
  private now(): string {
    let stamp = new Date().toISOString();
    if (stamp <= this.lastStamp) {
      stamp = new Date(Date.parse(this.lastStamp) + 1).toISOString();
    }
    this.lastStamp = stamp;
    return stamp;
  }

  private storageKey(): string {
    return accountStorageKey(STORAGE_PREFIX, this.accounts.storageName());
  }

  /**
   * What is stored for this account, adopting an older build's copy once.
   *
   * A build that named the drawer after the account id left it under a name
   * this one will not look for -- and on a device that has just moved to a
   * different service, that drawer is the only copy of the account there is.
   * Copied rather than moved, so going back to the old service finds it too.
   */
  private readStored(): string | null {
    const key = this.storageKey();

    try {
      const held = localStorage.getItem(key);

      // An empty drawer under the right name counts as no drawer at all. This
      // app writes one the moment it saves anything, so a build that looked in
      // the wrong place and found nothing left an empty one behind -- and a
      // later build that took its mere existence as an answer would go on
      // finding nothing forever.
      if (held !== null && holdsSomething(held)) {
        return held;
      }

      const carried = adoptableLegacyValue(
        STORAGE_PREFIX,
        Object.keys(localStorage),
        name => localStorage.getItem(name),
        holdsSomething
      );

      if (carried) {
        // Moved rather than copied. A drawer left behind is one that signing out
        // does not know to remove, and that the next read adopts straight back.
        localStorage.setItem(key, carried.raw);
        localStorage.removeItem(carried.key);
        return carried.raw;
      }

      return held;
    } catch {
      return null;
    }
  }

  /**
   * The state for whoever is signed in now.
   *
   * Keyed by account, and reloaded when that changes -- inheriting the previous
   * account's favourites would be a stranger's list, and pushing them would
   * file them under the wrong user.
   */
  private load(): LocalState {
    const owner = this.storageKey();
    if (this.loadedFor === owner) {
      return this.state();
    }

    this.loadedFor = owner;

    try {
      const raw = this.readStored();
      const parsed = raw ? (JSON.parse(raw) as Partial<LocalState>) : null;
      this.state.set({ ...empty(), ...(parsed ?? {}), pending: { ...emptyChangeSet(), ...(parsed?.pending ?? {}) } });
    } catch {
      this.state.set(empty());
    }

    this.mergeBrought();
    return this.state();
  }

  /**
   * What a device kept without an account, brought into an account that had
   * its own copy here (local-drawers.utils.ts): merged the way another
   * device's changes are, newest winning, and everything queued so the
   * account hears of it.
   */
  private mergeBrought(): void {
    const brought = takeBrought(localStorage, 'xtream_local_data', this.accounts.storageName());
    if (!brought) {
      return;
    }
    try {
      const theirs = JSON.parse(brought) as Partial<LocalState>;
      this.applyIncoming({
        favourites: Object.values(theirs.favourites ?? {}).map(entry => entry.change),
        progress: Object.values(theirs.progress ?? {}),
        arrangements: Object.values(theirs.arrangements ?? {})
      });
      // The icons are not in a change; keep the device's where the account had none.
      this.mutate(state => {
        for (const [key, entry] of Object.entries(theirs.favourites ?? {})) {
          if (state.favourites[key] && !state.favourites[key].icon) {
            state.favourites[key].icon = entry.icon;
          }
        }
      });
      this.requeueEverything();
    } catch {
      // Unreadable: the account's own copy stands.
    }
  }

  private mutate(change: (state: LocalState) => void): void {
    const next = structuredClone(this.load());
    change(next);
    this.state.set(next);

    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(next));
    } catch {
      // Usable for this session even if it cannot be kept for the next.
    }
  }
}
