import type { WatchProgress } from './types';

/**
 * Opening into the last channel: a television
 * that starts playing what it was showing when it was last turned off, the
 * way a television does, instead of opening on For You.
 *
 * Kept here rather than in the app so the planned tvinto CLI can read and set
 * it the same way (SETTING_KEYS.openLastChannel).
 */

/** The setting's value when it is on. Anything else, including nothing, is off. */
export const OPEN_LAST_CHANNEL_ON = 'on';
export const OPEN_LAST_CHANNEL_OFF = 'off';

export const opensLastChannel = (value: string | null | undefined): boolean => value === OPEN_LAST_CHANNEL_ON;

export const openLastChannelValue = (on: boolean): string => (on ? OPEN_LAST_CHANNEL_ON : OPEN_LAST_CHANNEL_OFF);

export interface StartingUp {
  /** The account's setting. */
  asked: boolean;
  /** Android says this is a television: the only device it applies to. */
  television: boolean;
  /**
   * The first time this run of the app reached its screens. Not a restart of
   * the page under it -- a profile switch, an update taken -- which somebody
   * using the app at the time would not want to turn into a channel playing.
   */
  firstThisRun: boolean;
  /** Opened by a link -- a reminder, the home screen -- which says what to show instead. */
  openedByLink: boolean;
  /** The page the app opened on, without its query. Only For You is replaced. */
  page: string;
}

/** Whether to look for a channel to open into at all. */
export const shouldOpenLastChannel = (start: StartingUp): boolean =>
  start.asked && start.television && start.firstThisRun && !start.openedByLink && start.page === '/for-you';

/**
 * The channel to open into: the newest entry in history when it is a channel.
 *
 * History arrives with whatever is behind a lock already taken out. When the
 * channel last watched was behind one, the answer is none, not the one before
 * it: "the last channel" that is a different channel would be a surprise.
 * So the caller asks for the newest entry alone.
 */
export const lastChannel = (history: readonly WatchProgress[]): WatchProgress | null => {
  const newest = history[0];
  return newest && newest.type === 'live' && String(newest.itemId) !== '' ? newest : null;
};
