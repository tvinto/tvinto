/**
 * Resume logic.
 *
 * Pure so the rules that decide "where do I put you back" are testable on
 * their own: they are easy to get subtly wrong, and wrong here means dropping
 * someone at the start of a film they had nearly finished.
 */

import { Episode, WatchProgress, WatchProgressInput } from '@shared/types';
import { t } from './i18n';

/**
 * Below this, resuming is worse than starting over -- the viewer has seen only
 * the opening seconds and would rather not be dropped mid-title-card.
 */
export const RESUME_MIN_SECONDS = 15;

/**
 * Past this fraction, what is left is credits. Anything beyond counts as
 * watched, and the next episode is what should be offered.
 */
export const COMPLETE_FRACTION = 0.95;

/** How much has been watched, 0 to 1. Zero when the runtime is unknown. */
export function watchedFraction(progress: WatchProgress | null | undefined): number {
  if (!progress || !Number.isFinite(progress.durationSeconds) || progress.durationSeconds <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, progress.positionSeconds / progress.durationSeconds));
}

/** The same as a percentage, for a progress bar's width. */
export function watchedPercent(progress: WatchProgress | null | undefined): number {
  return watchedFraction(progress) * 100;
}

/**
 * Whether a report about a film or an episode says nothing at all: no
 * position and no length. A player closed before its stream had loaded sends
 * one -- between two episodes, or Back on the opening panel -- and stored, it
 * replaced where the viewer had really got to. The Last Bus E2, watched to the
 * credits, came back as 0:00 and started again from the beginning
 * (25 September). A live channel is different: it never has a length, and
 * `recordWatched` stores one at zero on purpose to put it in the history.
 */
export function saysNothing(report: Pick<WatchProgressInput, 'type' | 'positionSeconds' | 'durationSeconds' | 'completed'>): boolean {
  return report.type !== 'live' && !report.completed && !(report.positionSeconds > 0) && !(report.durationSeconds > 0);
}

/** Whether this was watched to the end. */
export function isComplete(progress: WatchProgress | null | undefined): boolean {
  if (!progress) {
    return false;
  }
  return progress.completed || watchedFraction(progress) >= COMPLETE_FRACTION;
}

/**
 * Where playback should start.
 *
 * Zero for anything finished, barely started, or without a stored position --
 * every one of which should begin at the beginning.
 */
export function resumePosition(progress: WatchProgress | null | undefined): number {
  if (!progress || isComplete(progress) || !Number.isFinite(progress.positionSeconds)) {
    return 0;
  }
  // A live channel accumulates a position like anything else, but it names a
  // point in a broadcast that has since moved on. There is nothing to go back
  // to, so a channel always starts at whatever is on now.
  if (progress.type === 'live') {
    return 0;
  }
  return progress.positionSeconds >= RESUME_MIN_SECONDS ? progress.positionSeconds : 0;
}

/** Whether there is a part-watched position worth offering to resume. */
export function isResumable(progress: WatchProgress | null | undefined): boolean {
  return resumePosition(progress) > 0;
}

/** `1:04:07` past an hour, `4:07` below it. Negative and unknown read as `0:00`. */
export function formatTimecode(seconds: number | null | undefined): string {
  const total = Number.isFinite(seconds as number) ? Math.max(0, Math.floor(seconds as number)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * How much is left, in words, for a card caption.
 *
 * Empty when the runtime is unknown, which is the normal case for live: there
 * is no end to be a given distance from.
 */
export function remainingLabel(progress: WatchProgress | null | undefined): string {
  if (!progress || progress.durationSeconds <= 0) {
    return '';
  }
  if (isComplete(progress)) {
    return t('time.watched');
  }

  const remaining = Math.max(0, progress.durationSeconds - progress.positionSeconds);
  const minutes = Math.round(remaining / 60);

  if (minutes < 1) {
    return t('time.almostDone');
  }
  if (minutes < 60) {
    return t('time.minLeft', { count: minutes });
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? t('time.hLeft', { hours }) : t('time.hMinLeft', { hours, minutes: rest });
}

/** `S2 E4`, or as much of it as is known. */
export function episodeLabel(
  season: number | null | undefined,
  episodeNum: number | null | undefined
): string {
  const parts: string[] = [];
  if (season !== null && season !== undefined) {
    parts.push(`S${season}`);
  }
  if (episodeNum !== null && episodeNum !== undefined) {
    parts.push(`E${episodeNum}`);
  }
  return parts.join(' ');
}

/**
 * An episode title with what the surrounding UI already says stripped out.
 *
 * Providers name episodes in full -- "The Show (2024) - S01E02 - Vet Drugs" --
 * which under a heading of "The Show" and beside a badge reading "S1 E2" is
 * the same three facts three times over. What survives is the part that
 * actually identifies the episode; when nothing survives, the caller falls
 * back to the episode number.
 */
export function shortEpisodeTitle(
  showName: string | null | undefined,
  episodeTitle: string | null | undefined
): string {
  let title = (episodeTitle ?? '').trim();
  if (!title) {
    return '';
  }

  const show = (showName ?? '').trim();

  // A language tag in front -- 'DE - Supernatural - S04E13 - Schulzeit' on a
  // show named Supernatural (26 September) -- hid the name, so every card read
  // 'DE - Supernatural - S04...' and never reached the title. Only taken off
  // when the show's name follows it, so a title that merely starts with short
  // capitals ('CSI - ...') is left alone.
  const tagged = /^(?:\|[^|]{1,8}\|\s*|[A-Za-z]{2,4}\s*[-:|]\s*)/.exec(title);
  if (show && tagged && !title.toLowerCase().startsWith(show.toLowerCase())) {
    const untagged = title.slice(tagged[0].length);
    if (untagged.toLowerCase().startsWith(show.toLowerCase())) {
      title = untagged;
    }
  }

  let matched = false;
  if (show && title.toLowerCase().startsWith(show.toLowerCase())) {
    // Only when the name ends where a word ends. "The Showdown" starts with
    // "The Show" as text but is not that show's name followed by anything, and
    // trimming it would leave "down".
    const rest = title.slice(show.length);
    if (rest === '' || /^[\s\-–—·:|]/.test(rest)) {
      title = rest.trim();
      matched = true;
    }
  }

  const separators = /^[-–—·:|]+\s*/;
  title = title.replace(separators, '');
  // The show's year, when the name it was matched by did not carry it:
  // "The Chestnut Man" against "The Chestnut Man (2021) - S01E01 - ...".
  title = title.replace(/^\(\d{4}\)\s*/, '');
  // And, once the name was found, the provider's other short brackets after
  // it: "EN - Friends (1994) (US) - S01E01 - Pilot".
  if (matched) {
    title = title.replace(/^(?:\([^()]{1,12}\)\s*)+/, '');
  }
  title = title.replace(separators, '');
  title = title.replace(/^s\d{1,3}\s*e\d{1,4}\b/i, '').trim();
  title = title.replace(separators, '');

  return title.trim();
}

/**
 * Every episode of a show in running order.
 *
 * Season keys arrive as strings, so they are compared as numbers -- sorted as
 * text, season 10 lands between 1 and 2.
 */
export function flattenEpisodes(seasons: Record<string, Episode[]> | undefined): Episode[] {
  if (!seasons) {
    return [];
  }

  return Object.keys(seasons)
    .sort((a, b) => Number(a) - Number(b))
    .flatMap(season =>
      [...(seasons[season] || [])].sort(
        (a, b) => Number(a.episode_num ?? 0) - Number(b.episode_num ?? 0)
      )
    );
}

/** What clicking "continue" on a show should play. */
export interface NextUp {
  episode: Episode;
  /** Where to start it. Zero for one not yet begun. */
  resumeAt: number;
  /** True when picking up part-way, false when starting something fresh. */
  resuming: boolean;
}

/**
 * The episode to offer next.
 *
 * Driven by the episode watched most recently rather than by the furthest
 * reached: someone who goes back to rewatch an earlier episode means to
 * continue from there, not to be thrown forward again. A finished episode
 * hands over to the one after it; the last episode of the show has nothing to
 * hand over to, so it stays put and the show simply reads as watched.
 */
export function nextUp(
  episodes: Episode[],
  progressByEpisodeId: Record<string, WatchProgress>
): NextUp | null {
  if (episodes.length === 0) {
    return null;
  }

  let latest: { index: number; progress: WatchProgress } | null = null;

  episodes.forEach((episode, index) => {
    const progress = progressByEpisodeId[String(episode.id)];
    if (!progress) {
      return;
    }
    if (!latest || progress.updatedAt > latest.progress.updatedAt) {
      latest = { index, progress };
    }
  });

  // Nothing watched yet: the show starts at its first episode.
  if (latest === null) {
    return { episode: episodes[0], resumeAt: 0, resuming: false };
  }

  const { index, progress } = latest as { index: number; progress: WatchProgress };

  if (!isComplete(progress)) {
    return { episode: episodes[index], resumeAt: resumePosition(progress), resuming: true };
  }

  const following = episodes[index + 1];
  return following
    ? { episode: following, resumeAt: 0, resuming: false }
    : { episode: episodes[index], resumeAt: 0, resuming: false };
}
