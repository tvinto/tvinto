import { WatchProgressInput } from '@shared/types';

/** A watch-history entry without its position: what a play will write, once it knows how far it got. */
export type ProgressEntry = Omit<WatchProgressInput, 'positionSeconds' | 'durationSeconds'>;

/**
 * What is playing, kept in the page's storage for as long as a player is open.
 *
 * The player knows only an item's id and how far into it it is. The entry the
 * history needs -- the show an episode belongs to, its season, its poster -- is
 * the page's to say, and the page that opened the player may be gone by the
 * time the app starts again. So it is written down before the player opens, for
 * every item that play can reach: a film, or each episode of a show, since the
 * player goes on to the next by itself.
 */
export const PLAYING_KEY = 'xtream_playing';

export interface PlayingRecord {
  /** When the player opened, in milliseconds. */
  at: number;
  entries: Record<string, ProgressEntry>;
}

/** What the player kept on the device of a viewing that never closed (PlaybackCheckpoint.java). */
export interface UnfinishedPlayback {
  itemId?: string | null;
  positionSeconds?: number;
  durationSeconds?: number;
  /** When it was last written, in milliseconds. */
  at?: number;
}

/**
 * The history entry to save for a viewing that never closed, or null.
 *
 * Only when the two halves agree: the player's position belongs to an item
 * the page wrote down, and was written after that play began -- a record left
 * from an older play must not lend its entries to a newer position, nor the
 * other way round.
 */
export const recoveredProgress = (
  record: PlayingRecord | null,
  unfinished: UnfinishedPlayback | null
): WatchProgressInput | null => {
  const itemId = unfinished?.itemId;
  const position = unfinished?.positionSeconds ?? 0;
  const duration = unfinished?.durationSeconds ?? 0;
  if (!record || !itemId || position <= 0 || duration <= 0 || (unfinished?.at ?? 0) < record.at) {
    return null;
  }
  const entry = record.entries[itemId];
  return entry ? { ...entry, positionSeconds: position, durationSeconds: duration } : null;
};

/** The record as the page stored it, or null when there is none or it is not one. */
export const readPlayingRecord = (stored: string | null): PlayingRecord | null => {
  try {
    const record = JSON.parse(stored ?? 'null') as PlayingRecord | null;
    return record && typeof record.at === 'number' && record.entries && typeof record.entries === 'object' ? record : null;
  } catch {
    return null;
  }
};
