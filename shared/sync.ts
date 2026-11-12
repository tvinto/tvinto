import { StreamType } from './types';

/**
 * The shape of what one account has made, as it travels between its devices.
 *
 * Here rather than in the backend because both ends speak it now: the server
 * applies these and a device produces them. A disagreement about a field name
 * would not fail a build -- the server ignores what it does not recognise --
 * it would silently drop the favourite you starred on the sofa.
 *
 * The unit of sync is deliberately not the catalogue. Half a million stream
 * rows come from the provider and every device can fetch its own; what has to
 * travel is only what the user made, which is a few kilobytes.
 *
 * Reconciliation is last-write-wins on `updatedAt`. That is the right rule for
 * this data because the writes are one person's, made on one device at a time
 * -- there is no second author to lose an edit to, only the same person's older
 * opinion.
 */

export type ChangeKind =
  | 'favourite'
  | 'arrangement'
  | 'progress'
  | 'setting'
  | 'guideSource'
  | 'channelMapping';

export interface FavouriteChange {
  type: StreamType;
  streamId: string;
  name: string | null;
  updatedAt: string;
}

export interface ArrangementChange {
  scope: string;
  itemIds: string[];
  names: Record<string, string>;
  updatedAt: string;
}

export interface ProgressChange {
  type: StreamType;
  itemId: string;
  seriesId: string | null;
  season: number | null;
  episodeNum: number | null;
  name: string;
  episodeTitle: string | null;
  icon: string | null;
  containerExtension: string | null;
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;

  /**
   * The tracks this item was last watched with, if a player said.
   *
   * Here rather than in settings because it is about one film: subtitles
   * turned on for a foreign one are not a request for subtitles on the news.
   * The account-wide preference still exists and still applies to everything
   * nobody has chosen for -- see `tracksFor` in `shared/player.ts`.
   *
   * Optional, and absent rather than empty when unknown: a player that cannot
   * report its tracks must not erase what another device remembered. Languages
   * rather than track numbers, which mean nothing to a different player.
   */
  audioLanguage?: string | null;
  subtitleLanguage?: string | null;

  /**
   * The chosen track's own name.
   *
   * Because a language does not identify a track: a film here offers "English
   * (forced)", "English" and "English (SDH)", and remembering only `eng` meant
   * reopening it always selected the first of the three.
   */
  audioTitle?: string | null;
  subtitleTitle?: string | null;

  subtitlesEnabled?: boolean | null;

  updatedAt: string;
}

export interface SettingChange {
  key: string;
  value: string;
  updatedAt: string;
}

/**
 * A guide the account uses, as a sealed blob.
 *
 * The whole reason guide sources travel: signing in on a new device should
 * offer the guides you already use rather than send you hunting for the URL
 * again. What each device has actually downloaded stays on that device -- a
 * guide is tens of megabytes and a phone on mobile data should get a choice.
 *
 * The label, the URL and whether it is enabled are all inside `payload`,
 * sealed under `enc`. An Xtream guide URL is
 * `xmltv.php?username=...&password=...`, so it is a credential whatever it
 * looks like, and storing it as an ordinary setting would undo the point of
 * encrypting the subscription.
 *
 * The id is a hash of the URL and carries none of it, which is what lets it be
 * the primary key of a row on a server that can read nothing else. It is also
 * the tombstone key.
 */
export interface GuideSourceChange {
  id: string;
  payload: string;
  updatedAt: string;
}

/**
 * One stream tied by hand to one guide channel.
 *
 * Sent in the clear, unlike a source: a stream id, a guide id and a channel id
 * like `HTV1.hr` are not credentials and nothing is learned from them.
 *
 * Per entry with tombstones rather than as one blob, because this is work a
 * person did by hand -- nearly half a real line-up carries no channel id at
 * all -- and two devices editing it must not silently discard each other's.
 * The tombstone key is the stream id, which is also how it is always read.
 */
export interface ChannelMappingChange {
  streamId: string;
  sourceId: string;
  channelId: string;
  updatedAt: string;
}

/**
 * A record that something was deleted.
 *
 * Needed because absence does not travel. Without one of these, a device that
 * still holds a favourite you removed elsewhere would re-add it on its next
 * push, and unstarring anything would be impossible to make stick.
 */
export interface Tombstone {
  kind: ChangeKind;
  key: string;
  deletedAt: string;
}

export interface ChangeSet {
  favourites: FavouriteChange[];
  arrangements: ArrangementChange[];
  progress: ProgressChange[];
  settings: SettingChange[];
  guideSources: GuideSourceChange[];
  channelMappings: ChannelMappingChange[];
  deletions: Tombstone[];
}

export interface PullResult extends ChangeSet {
  /**
   * The server's clock at the moment of the read.
   *
   * Handed back so the next pull can quote it rather than using the device's
   * own time. Devices disagree about what time it is, and a device running slow
   * would otherwise ask for changes since a moment that has not arrived here
   * yet, and never see what happened in between.
   */
  serverTime: string;
}

export interface PushResult {
  applied: number;
  /** Changes discarded because the stored copy was newer. */
  superseded: number;
}

export const CHANGE_KINDS: readonly ChangeKind[] = [
  'favourite',
  'arrangement',
  'progress',
  'setting',
  'guideSource',
  'channelMapping'
];

/** An empty batch, so a caller can fill in only the parts it has. */
export function emptyChangeSet(): ChangeSet {
  return {
    favourites: [],
    arrangements: [],
    progress: [],
    settings: [],
    guideSources: [],
    channelMappings: [],
    deletions: []
  };
}

/**
 * Every list in a batch, so that adding a kind cannot half-happen.
 *
 * Counting, emptiness and splitting all have to know about a new kind, and a
 * new kind that was added to the interface and forgotten in one of the three
 * fails silently: the change is simply never sent.
 */
const LISTS: readonly (keyof ChangeSet)[] = [
  'deletions',
  'favourites',
  'arrangements',
  'progress',
  'settings',
  'guideSources',
  'channelMappings'
];

/** How many changes a batch carries, which is what the limit is in. */
export function countChanges(batch: Partial<ChangeSet>): number {
  return LISTS.reduce((total, kind) => total + (batch[kind]?.length ?? 0), 0);
}

/** Whether a batch is worth sending. */
export function isEmptyChangeSet(batch: Partial<ChangeSet>): boolean {
  return countChanges(batch) === 0;
}

/**
 * How many changes one push may carry.
 *
 * A limit the *service* has and the *device* must respect, so it lives where
 * both can read it. The sync service is a Cloudflare Worker with fifty D1
 * queries per request: every change is a statement and a deletion is two, so
 * twenty is at most forty, leaving room for the reads that decided them.
 *
 * The Express backend has no such limit and does not need one. It is written
 * down here anyway, because a device that split its batches only when it
 * happened to be talking to the Worker would be a device whose first sync
 * worked in testing and failed in use.
 */
export const MAX_CHANGES_PER_PUSH = 20;

/**
 * Cuts a batch into pieces small enough to be accepted.
 *
 * The order the pieces are sent in does not affect the result, which is worth
 * knowing because it is what makes chunking safe at all. Reconciliation is
 * last-write-wins on a timestamp, and a tombstone is weighed against the same
 * clock: an add newer than a deletion survives it whichever arrives first, and
 * a deletion newer than an add removes it whichever arrives first. Pieces can
 * therefore be sent one at a time, and a failure half way through leaves the
 * rest queued rather than a half-applied mess.
 *
 * Deletions go first regardless, so that within any one piece the service
 * applies them before the adds that may supersede them.
 */
export function splitChangeSet(batch: ChangeSet, limit = MAX_CHANGES_PER_PUSH): ChangeSet[] {
  const size = Math.max(1, Math.floor(limit));
  const pieces: ChangeSet[] = [];

  let current = emptyChangeSet();
  let count = 0;

  const place = <K extends keyof ChangeSet>(kind: K, items: ChangeSet[K]) => {
    for (const item of items ?? []) {
      if (count === size) {
        pieces.push(current);
        current = emptyChangeSet();
        count = 0;
      }
      (current[kind] as unknown[]).push(item);
      count += 1;
    }
  };

  // Deletions first, and then whatever order LISTS gives -- which is the same
  // list emptiness and counting use, so a kind cannot be split but not counted.
  for (const kind of LISTS) {
    place(kind, batch[kind]);
  }

  if (count > 0) {
    pieces.push(current);
  }

  return pieces;
}

/** How a favourite is identified in a tombstone. */
export function favouriteKey(type: StreamType, streamId: string): string {
  return `${type}:${streamId}`;
}

/** How a watch-history entry is identified in a tombstone. */
export function progressKey(type: StreamType, itemId: string): string {
  return `${type}:${itemId}`;
}
