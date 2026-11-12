import { Stream, WatchProgress } from '@shared/types';
import { ROW_LIMIT, channelRow, playNext } from './home-screen.utils';
import { routeForLink } from './deep-links.utils';

const channel = (id: number, category = '1'): Stream =>
  ({ stream_id: id, name: `Channel ${id}`, stream_icon: `http://logo/${id}.png`, category_id: category }) as unknown as Stream;

const watched = (over: Partial<WatchProgress>): WatchProgress => ({
  type: 'vod',
  itemId: '1',
  name: 'Film',
  positionSeconds: 600,
  durationSeconds: 6000,
  completed: false,
  updatedAt: '2026-10-04T20:00:00Z',
  ...over
});

const nothingKeptOut = { keptOut: () => false, anyKeptOut: false };

describe('the home-screen channel row', () => {
  it('is the favourite channels, in order, each opening the channel', () => {
    const row = channelRow({ favourites: [channel(7), channel(3)], recent: [], ...nothingKeptOut });
    expect(row.from).toBe('favourites');
    expect(row.items.map(item => item.id)).toEqual(['live:7', 'live:3']);
    expect(routeForLink(row.items[0].link)?.queryParams).toEqual({ play: '7', kind: 'home', name: 'Channel 7', icon: '' });
  });

  it('never shows a channel from a hidden or locked category', () => {
    const row = channelRow({
      favourites: [channel(7, 'adult'), channel(3)],
      recent: [],
      keptOut: category => category === 'adult',
      anyKeptOut: true
    });
    expect(row.items.map(item => item.id)).toEqual(['live:3']);
  });

  it('falls back to channels watched lately when none are favourites', () => {
    const recent = [watched({ type: 'live', itemId: '9', name: 'HRT 1' }), watched({ itemId: '2' })];
    const row = channelRow({ favourites: [], recent, ...nothingKeptOut });
    expect(row.from).toBe('recent');
    expect(row.items.map(item => item.id)).toEqual(['live:9']);
  });

  it('leaves history out with a lock set, since history does not say a category', () => {
    const recent = [watched({ type: 'live', itemId: '9' })];
    expect(channelRow({ favourites: [], recent, keptOut: () => false, anyKeptOut: true }).items).toEqual([]);
  });

  it('stops at a row a remote is worth scrolling', () => {
    const many = Array.from({ length: 30 }, (_, i) => channel(i));
    expect(channelRow({ favourites: many, recent: [], ...nothingKeptOut }).items).toHaveLength(ROW_LIMIT);
  });
});

describe('"Play next"', () => {
  it('resumes a film where it was left', () => {
    const [film] = playNext([watched({ itemId: '55', name: 'Up' })], []);
    expect(film).toMatchObject({ id: 'vod:55', kind: 'movie', positionMs: 600_000, durationMs: 6_000_000 });
    expect(routeForLink(film.link)?.path).toEqual(['/movies']);
  });

  it("shows a show once, opening its page, with the episode it is at", () => {
    const episodes = [
      watched({ type: 'series', itemId: 'e2', seriesId: '12', name: 'Dexter', season: 2, episodeNum: 5, episodeTitle: 'Dirty Harry', updatedAt: '2026-10-04T21:00:00Z' }),
      watched({ type: 'series', itemId: 'e1', seriesId: '12', name: 'Dexter', season: 2, episodeNum: 4, updatedAt: '2026-10-03T21:00:00Z' })
    ];
    const items = playNext([], episodes);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'series:12', kind: 'series', description: 'S2 E5 · Dirty Harry' });
    expect(routeForLink(items[0].link)?.path).toEqual(['/series', '12']);
  });

  it('leaves out a show taken out of Continue watching', () => {
    const episode = watched({ type: 'series', itemId: 'e1', seriesId: '12', name: 'Dexter' });
    expect(playNext([], [episode], { '12': '2026-10-05T00:00:00Z' })).toEqual([]);
  });
});
