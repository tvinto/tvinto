import { ShowNews } from '@shared/tmdb/episodes';
import { locale, t } from './i18n';

/** "Friday 23 Oct", or "2 Nov" without the weekday, in the app's language. */
export function newsDay(date: string, weekday: boolean): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(locale(), weekday ? { weekday: 'long', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' });
}

/**
 * The show page's line about the next episode (TV-29), in full:
 * "New episode today · S2 E6 · Attila · ready to play", "Out today · S2 E7 ·
 * X · not on your provider yet", "New episode Friday 23 Oct", "Season 3 starts
 * 2 Nov", "Ended 2025".
 */
export function newsLine(news: ShowNews): string {
  if (!news) {
    return '';
  }
  const ready = (held: boolean) => t(held ? 'show.readyToPlay' : 'show.notOnProvider');
  switch (news.kind) {
    case 'today':
      return news.ready
        ? `${t('show.newToday', { s: news.season, e: news.episode, name: news.name })} · ${ready(true)}`
        : `${t('show.outToday', { s: news.season, e: news.episode, name: news.name })} · ${ready(false)}`;
    case 'recent':
      return `${t('show.newRecent', { s: news.season, e: news.episode, name: news.name })} · ${ready(news.ready)}`;
    case 'soon':
      return t('show.newOn', { day: newsDay(news.date, true) });
    case 'season':
      return t('show.seasonStarts', { season: news.season, date: newsDay(news.date, false) });
    case 'ended':
      return news.year ? t('show.endedIn', { year: news.year }) : t('show.ended');
  }
}

/**
 * For You's tile line (FY-TV-2), where the provider was not asked whether it
 * has the episode: "S2 E6 · out today", "S2 E7 · Friday 23 Oct", "Season 4
 * starts 2 Nov".
 */
export function newsTileLine(news: ShowNews): string {
  if (!news) {
    return '';
  }
  switch (news.kind) {
    case 'today':
      return t('fy.newEpisodeOut', { s: news.season, e: news.episode });
    case 'recent':
      return t('fy.newEpisodeRecent', { s: news.season, e: news.episode });
    case 'soon':
      return t('fy.newEpisodeOn', { s: news.season, e: news.episode, day: newsDay(news.date, true) });
    case 'season':
      return t('show.seasonStarts', { season: news.season, date: newsDay(news.date, false) });
    case 'ended':
      return '';
  }
}

/** The chip on a Continue watching card (FY-TV-2): "New episode today", "New episode Friday". */
export function newsChip(news: ShowNews): string {
  if (!news) {
    return '';
  }
  switch (news.kind) {
    case 'today':
      return t('fy.chipToday');
    case 'recent':
      return t('fy.chipNew');
    case 'soon':
      return t('fy.chipOn', { day: new Date(`${news.date}T12:00:00`).toLocaleDateString(locale(), { weekday: 'long' }) });
    default:
      return '';
  }
}
