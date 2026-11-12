import { WatchProgress } from '@shared/types';
import { isComplete } from './progress.utils';
import { locale, t } from './i18n';
import { LooseProgramme } from './guide.utils';

/**
 * What the For You page puts in its rails (FY-TV, FY-D, FY-P), from data the
 * device already holds. Pure, so the rules can be tested without a page.
 */

/**
 * Shows taken out of Continue watching, by show id, with when: a show comes
 * back by itself once anything of it is watched after that. Kept as an
 * account setting (`continueHidden`), so it is the same on every device --
 * and nothing of the show's history is deleted, so its watched ticks stay.
 */
export type HiddenShows = Readonly<Record<string, string>>;

export function readHiddenShows(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string')
    );
  } catch {
    return {};
  }
}

/** The show an entry belongs to. */
export const showOf = (entry: WatchProgress): string => String(entry.seriesId ?? entry.itemId);

/**
 * One entry per show, its most recently watched episode, newest show first --
 * less the shows taken out since they were last watched.
 *
 * What Continue watching shows of a show is the show, never an episode (the
 * owner, 2 October): the card opens the show's page, which finds what is next
 * -- the episode part-watched, or the one after the last finished.
 */
export function latestPerShow(entries: readonly WatchProgress[], hidden: HiddenShows = {}): WatchProgress[] {
  const latest = new Map<string, WatchProgress>();
  for (const entry of entries) {
    if (entry.type !== 'series') {
      continue;
    }
    const known = latest.get(showOf(entry));
    if (!known || Date.parse(entry.updatedAt) > Date.parse(known.updatedAt)) {
      latest.set(showOf(entry), entry);
    }
  }
  return [...latest.values()]
    .filter(entry => {
      const hiddenAt = hidden[showOf(entry)];
      return !hiddenAt || Date.parse(entry.updatedAt) > Date.parse(hiddenAt);
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * Continue watching across all three libraries, newest first.
 *
 * Finished films are left out -- there is nothing to resume. A show stays
 * whether its latest episode was finished or not: either way there is
 * something next, and the show's page knows what. Channels always stay: a
 * channel has no end to have reached.
 */
export function continueWatching(histories: WatchProgress[][], limit = 12, hidden: HiddenShows = {}): WatchProgress[] {
  const all = histories.flat();
  const others = all.filter(entry => entry.type !== 'series' && (entry.type === 'live' || !isComplete(entry)));
  return [...others, ...latestPerShow(all, hidden)]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

/** "last night", "yesterday", "Tuesday", "3 Sep": when something was last watched. */
export function watchedWhen(updatedAt: string, now: Date): string {
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) {
    return '';
  }
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  const daysAgo = Math.floor((startOfToday.getTime() - at.getTime()) / dayMs) + 1;

  if (at.getTime() >= startOfToday.getTime()) {
    return t('time.today');
  }
  if (daysAgo === 1) {
    return at.getHours() >= 18 ? t('time.lastNight') : t('time.yesterday');
  }
  return formatter(daysAgo < 7 ? 'weekday' : 'date').format(at);
}

/**
 * Date formatters, made once per language. `toLocaleDateString` builds a new
 * one on every call, and this is asked once per card on every check: the
 * second most expensive thing on For You on the TV emulator (10 October).
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(kind: 'weekday' | 'date'): Intl.DateTimeFormat {
  const language = locale();
  const key = `${language}|${kind}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(language, kind === 'weekday' ? { weekday: 'long' } : { day: 'numeric', month: 'short' });
    formatters.set(key, found);
  }
  return found;
}

/** A programme as the device's guide hands it over. */
type GuideRow = LooseProgramme;

/** What is on a channel now, from its guide rows, or null. */
export interface ProgrammeOnNow {
  title: string;
  /** "23 min left". */
  left: string;
  /** How far through it is, 0 to 100. */
  percent: number;
}

const toMs = (value: string | number | null | undefined): number => {
  if (value === undefined || value === null || value === '') {
    return Number.NaN;
  }
  const n = Number(value);
  if (!Number.isNaN(n)) {
    return n > 1e12 ? n : n * 1000;
  }
  return new Date(value).getTime();
};

export function programmeOnNow(rows: readonly GuideRow[] | undefined, now: number): ProgrammeOnNow | null {
  for (const row of rows ?? []) {
    const start = toMs(row.start_timestamp ?? row.start);
    const stop = toMs(row.stop_timestamp ?? row.stop);
    if (Number.isFinite(start) && Number.isFinite(stop) && start <= now && now < stop) {
      return {
        title: row.title || t('time.programme'),
        left: t('time.minLeft', { count: Math.max(1, Math.round((stop - now) / 60_000)) }),
        percent: Math.max(0, Math.min(100, ((now - start) / (stop - start)) * 100))
      };
    }
  }
  return null;
}
