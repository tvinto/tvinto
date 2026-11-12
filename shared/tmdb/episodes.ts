import { TmdbShow } from './client';

/**
 * What a show's page says about its next episode (round 6, TV-29): the one
 * place a show's news is stated in full. "Ready to play" only when the
 * provider's episode list already has it, so the promise never outruns the
 * library; nothing at all when nothing is announced.
 */
export type ShowNews =
  | { kind: 'today'; season: number; episode: number; name: string; ready: boolean }
  | { kind: 'recent'; season: number; episode: number; name: string; ready: boolean }
  | { kind: 'soon'; season: number; episode: number; name: string; date: string }
  | { kind: 'season'; season: number; date: string }
  | { kind: 'ended'; year: string }
  | null;

/** An episode that aired this long ago still counts as new. */
const RECENT_DAYS = 7;

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

const ended = (status: string): boolean => /ended|canceled|cancelled/i.test(status);

/**
 * `today` as "2026-10-24", in the viewer's own calendar; `held` says whether
 * the provider's episode list has an episode.
 */
export function showNews(
  show: Pick<TmdbShow, 'next' | 'last' | 'status'>,
  today: string,
  held: (season: number, episode: number) => boolean
): ShowNews {
  const { next, last } = show;
  // An episode out today, then one out this week, says more than the next
  // one announced: it is there to watch now.
  if (next?.airDate && daysBetween(today, next.airDate) === 0) {
    return { kind: 'today', season: next.season, episode: next.episode, name: next.name, ready: held(next.season, next.episode) };
  }
  if (last?.airDate) {
    const days = daysBetween(last.airDate, today);
    if (days === 0) {
      return { kind: 'today', season: last.season, episode: last.episode, name: last.name, ready: held(last.season, last.episode) };
    }
    if (days > 0 && days <= RECENT_DAYS && !ended(show.status)) {
      return { kind: 'recent', season: last.season, episode: last.episode, name: last.name, ready: held(last.season, last.episode) };
    }
  }
  if (next?.airDate && daysBetween(today, next.airDate) > 0) {
    return next.episode === 1
      ? { kind: 'season', season: next.season, date: next.airDate }
      : { kind: 'soon', season: next.season, episode: next.episode, name: next.name, date: next.airDate };
  }
  if (ended(show.status)) {
    return { kind: 'ended', year: (last?.airDate ?? '').slice(0, 4) };
  }
  return null;
}

/** How far ahead an announced episode is still worth a place on For You. */
const AHEAD_DAYS = 14;

/**
 * Whether a show's news earns it a tile in For You's "New in your shows"
 * (FY-TV-2): an episode out today or in the last week, or one announced for
 * the next two weeks. An ended show, or one with nothing dated, is left to
 * its own page.
 */
export function newsForRow(news: ShowNews, today: string): boolean {
  if (!news) {
    return false;
  }
  switch (news.kind) {
    case 'today':
    case 'recent':
      return true;
    case 'soon':
    case 'season':
      return daysBetween(today, news.date) <= AHEAD_DAYS;
    default:
      return false;
  }
}

/** The order of the row: out today, then out this week, then the nearest announced. */
export function newsOrder(a: ShowNews, b: ShowNews): number {
  const weight = (news: ShowNews): number => (news?.kind === 'today' ? 0 : news?.kind === 'recent' ? 1 : 2);
  const date = (news: ShowNews): string => (news && 'date' in news ? news.date : '');
  return weight(a) - weight(b) || date(a).localeCompare(date(b));
}
