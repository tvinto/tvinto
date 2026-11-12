import { EPGProgram } from '@shared/types';

/**
 * One programme, whichever of the three shapes it arrived in.
 *
 * The guide reaches this app by more than one road and each spells a time
 * differently:
 *
 * - the device's own XMLTV store gives `start`/`stop` in **milliseconds**;
 * - the Express backend gave `start`/`stop` as **ISO strings**;
 * - Xtream's own API gives `start_timestamp`/`stop_timestamp` in **seconds**.
 *
 * Anything reading a guide has to cope with all three, and the interesting
 * failure is that none of them announces itself: seconds read as milliseconds
 * put a programme in January 1970, and milliseconds read as seconds put it
 * fifty thousand years out. Both draw a row that is simply empty.
 */
export interface LooseProgramme {
  id?: string;
  title?: string;
  description?: string;
  /** Some guides' word for the description. */
  desc?: string;
  start?: string | number | null;
  stop?: string | number | null;
  end?: string | number | null;
  start_timestamp?: string | number | null;
  stop_timestamp?: string | number | null;
}

/** A guide by stream id, as any of the roads above delivers it. */
export type GuideByStream = Record<string, LooseProgramme[]>;

/**
 * A moment, in milliseconds, from any of the spellings above.
 *
 * The threshold is the whole of it. A count of *seconds* since 1970 is about
 * 1.7e9 today and will not reach 1e12 until the year 33658; a count of
 * milliseconds passed 1e12 in 2001. So a number below the line is seconds and
 * above it is milliseconds, and that stays true for longer than this code will.
 */
/**
 * Hours before the current one the guide grid reaches back, for catch-up:
 * scrolled to by going left, past what is on.
 * Earlier than that is the channel's own programme list, which goes back as
 * far as its catch-up does.
 */
export const GUIDE_GRID_BACK_HOURS = 6;

/** How far back the grid's guide read reaches: the hours above, and the part of this one gone. */
export const GUIDE_GRID_BACK_MS = (GUIDE_GRID_BACK_HOURS + 1) * 60 * 60 * 1000;

export const millisecondsOf = (value: unknown): number => {
  if (typeof value === 'number') {
    return value > 1e12 ? value : value * 1000;
  }

  const asNumber = Number(value);
  if (value !== null && value !== '' && !Number.isNaN(asNumber)) {
    return asNumber > 1e12 ? asNumber : asNumber * 1000;
  }

  return new Date(String(value)).getTime();
};

/**
 * Programmes in the shape the guide panel draws, in the order they are on.
 *
 * Anything without a usable start is dropped rather than shown at the epoch:
 * a row claiming a film began in 1970 is worse than a row that is not there.
 */
export const asEpgPrograms = (programmes: readonly unknown[]): EPGProgram[] =>
  programmes
    .map(programme => programme as LooseProgramme)
    .map((programme, index) => {
      const start = millisecondsOf(programme.start_timestamp ?? programme.start);
      const stop = millisecondsOf(programme.stop_timestamp ?? programme.stop ?? programme.end);

      return {
        id: programme.id ?? `programme-${index}`,
        title: programme.title ?? '',
        description: programme.description ?? '',
        start_timestamp: Math.floor(start / 1000),
        stop_timestamp: Math.floor(stop / 1000)
      };
    })
    .filter(programme => Number.isFinite(programme.start_timestamp))
    .sort((a, b) => a.start_timestamp - b.start_timestamp);

/** The one on now and the one after it, out of a sorted list. */
export const onNow = (
  programmes: readonly EPGProgram[],
  nowMs: number = Date.now()
): { current: EPGProgram | null; next: EPGProgram | null } => {
  const now = nowMs / 1000;
  let current: EPGProgram | null = null;
  let next: EPGProgram | null = null;

  for (const programme of programmes) {
    if (programme.start_timestamp <= now && now <= programme.stop_timestamp) {
      current = programme;
    } else if (programme.start_timestamp > now && !next) {
      next = programme;
    }
  }

  return { current, next };
};
