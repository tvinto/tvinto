import { Stream, WatchProgress } from '@shared/types';
import { HiddenShows, continueWatching, showOf } from './for-you.utils';

/**
 * What the television's home screen shows of the app
 * (HomeScreenPlugin.java): a row of favourite channels, and the
 * films and shows half watched, in the system's "Play next" row. Plain
 * functions, so what goes there can be tested without a television.
 */

export interface HomeRowItem {
  /** Stays the same for the same channel, so the row is updated rather than refilled. */
  id: string;
  title: string;
  description: string;
  poster: string;
  link: string;
}

export interface PlayNextItem extends HomeRowItem {
  kind: 'movie' | 'series';
  positionMs: number;
  durationMs: number;
  lastWatched: number;
}

/** As many channels as a row is worth scrolling through with a remote. */
export const ROW_LIMIT = 20;
/** The same as Continue watching on For You shows. */
export const PLAY_NEXT_LIMIT = 12;

/** What the channel row is made from. */
export interface ChannelRowSource {
  favourites: readonly Stream[];
  recent: readonly WatchProgress[];
  /** Whether a category is hidden or locked (ParentalLockService). */
  keptOut: (categoryId: string | number | null | undefined) => boolean;
  /** Whether any category is: history says no category, so it is then left out. */
  anyKeptOut: boolean;
}

/** The channel row, and which list it is -- the row is named after it. */
export interface ChannelRow {
  from: 'favourites' | 'recent';
  items: HomeRowItem[];
}

/**
 * The favourite channels -- or, with none chosen yet, the ones watched
 * lately. Never one from a hidden or locked category: the home screen is
 * outside the app's PIN, and anybody holding the remote sees it.
 */
export function channelRow({ favourites, recent, keptOut, anyKeptOut }: ChannelRowSource): ChannelRow {
  const fromFavourites = favourites
    .filter(stream => !keptOut(stream.category_id))
    .map(stream => channelItem(String(stream.stream_id), stream.name, stream.stream_icon ?? ''));
  if (fromFavourites.length || anyKeptOut) {
    return { from: 'favourites', items: fromFavourites.slice(0, ROW_LIMIT) };
  }
  const watched = recent
    .filter(entry => entry.type === 'live')
    .map(entry => channelItem(String(entry.itemId), entry.name, entry.icon ?? ''));
  return { from: 'recent', items: watched.slice(0, ROW_LIMIT) };
}

const channelItem = (streamId: string, name: string, icon: string): HomeRowItem => ({
  id: `live:${streamId}`,
  title: name,
  description: '',
  poster: icon,
  link: `tvinto://watch?stream=${encodeURIComponent(streamId)}&name=${encodeURIComponent(name)}&kind=home`
});

/** What Continue watching on For You shows -- each show once, at its latest episode -- for "Play next". */
export function playNext(films: WatchProgress[], episodes: WatchProgress[], hidden: HiddenShows = {}): PlayNextItem[] {
  return continueWatching([films, episodes], PLAY_NEXT_LIMIT, hidden).map(entry => {
    const lastWatched = Date.parse(entry.updatedAt) || 0;
    if (entry.type === 'series') {
      const show = showOf(entry);
      return {
        id: `series:${show}`,
        kind: 'series',
        title: entry.name,
        description: episodeLine(entry),
        poster: entry.icon ?? '',
        link: `tvinto://series/${encodeURIComponent(show)}?name=${encodeURIComponent(entry.name)}`,
        positionMs: 0,
        durationMs: 0,
        lastWatched
      };
    }
    return {
      id: `vod:${entry.itemId}`,
      kind: 'movie',
      title: entry.name,
      description: '',
      poster: entry.icon ?? '',
      link: `tvinto://movie?play=${encodeURIComponent(String(entry.itemId))}&name=${encodeURIComponent(entry.name)}`,
      positionMs: Math.max(0, Math.round(entry.positionSeconds * 1000)),
      durationMs: Math.max(0, Math.round(entry.durationSeconds * 1000)),
      lastWatched
    };
  });
}

/** "S2 E5 · The Title", from what history kept. */
function episodeLine(entry: WatchProgress): string {
  const number = entry.season != null && entry.episodeNum != null ? `S${entry.season} E${entry.episodeNum}` : '';
  return [number, entry.episodeTitle ?? ''].filter(Boolean).join(' · ');
}
