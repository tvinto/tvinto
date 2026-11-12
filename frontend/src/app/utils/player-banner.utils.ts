/**
 * What the channel banner in the player says (design board PL-TV-1, PL-TV-1b).
 *
 * The player draws it; this decides it from the device's own guide, so the
 * awkward inputs -- a guide in any of its three time spellings, a gap between
 * programmes, a channel with nothing -- are settled in tested TypeScript
 * rather than in Java. Times go across as milliseconds and the player writes
 * them out itself, because "23 min left" has to keep counting while the banner
 * is up and after it comes back.
 */

import { asEpgPrograms, onNow } from './guide.utils';
import { channelDisplay } from './channel-display.utils';
import { t } from './i18n';

export interface BannerProgramme {
  title: string;
  startMs: number;
  stopMs: number;
  /** What the guide says about it, for the details a second OK shows. Absent when it says nothing. */
  description?: string;
}

export interface ChannelBanner {
  /** "ᴴᴰ ᵛᴵᴾ ᴿᴬᵂ", or empty. */
  tags: string;
  /** Null between programmes, or with no guide. */
  now: BannerProgramme | null;
  next: BannerProgramme | null;
  /**
   * Whether this channel has any listings on this device. PL-TV-1b -- "No
   * programme guide for this channel" -- is for false; a gap between two
   * programmes is not that, and shows the next one alone.
   */
  hasGuide: boolean;
}

const asBannerProgramme = (
  programme: { title: string; description?: string; start_timestamp: number; stop_timestamp: number } | null
): BannerProgramme | null => {
  if (!programme) {
    return null;
  }
  const described: BannerProgramme = {
    title: programme.title || t('time.programme'),
    startMs: programme.start_timestamp * 1000,
    stopMs: programme.stop_timestamp * 1000
  };
  const description = (programme.description ?? '').trim();
  if (description) {
    described.description = description;
  }
  return described;
};

export const channelBanner = (name: string, programmes: readonly unknown[] | undefined, nowMs: number): ChannelBanner => {
  const listed = asEpgPrograms(programmes ?? []);
  const { current, next } = onNow(listed, nowMs);
  return {
    tags: channelDisplay(name).tags,
    now: asBannerProgramme(current),
    next: asBannerProgramme(next),
    hasGuide: listed.length > 0
  };
};
