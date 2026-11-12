import { WatchProgress } from '@shared/types';
import { continueWatching, latestPerShow, programmeOnNow, readHiddenShows, watchedWhen } from './for-you.utils';

const entry = (overrides: Partial<WatchProgress>): WatchProgress => ({
  type: 'vod',
  itemId: '1',
  name: 'Film',
  positionSeconds: 600,
  durationSeconds: 6000,
  completed: false,
  updatedAt: '2026-09-14T20:00:00Z',
  ...overrides
});

describe('continueWatching', () => {
  it('mixes the libraries newest first, and leaves out what was finished', () => {
    const result = continueWatching([
      [entry({ type: 'live', itemId: 'c', name: 'HRT 1', durationSeconds: 0, updatedAt: '2026-09-14T21:00:00Z' })],
      [
        entry({ itemId: 'f1', name: 'Tri zime', updatedAt: '2026-09-14T19:00:00Z' }),
        entry({ itemId: 'f2', name: 'Done', completed: true, positionSeconds: 5990, updatedAt: '2026-09-14T22:00:00Z' })
      ],
      [entry({ type: 'series', itemId: 'e1', name: 'Novine', seriesId: 's1', updatedAt: '2026-09-14T20:30:00Z' })]
    ]);

    expect(result.map(item => item.name)).toEqual(['HRT 1', 'Novine', 'Tri zime']);
  });

  it('gives a show one card, for its latest episode', () => {
    const result = continueWatching([
      [
        entry({ type: 'series', itemId: 'e1', seriesId: 's1', name: 'Novine', episodeNum: 1, updatedAt: '2026-09-14T18:00:00Z' }),
        entry({ type: 'series', itemId: 'e2', seriesId: 's1', name: 'Novine', episodeNum: 2, updatedAt: '2026-09-14T19:00:00Z' })
      ]
    ]);
    expect(result.map(item => item.itemId)).toEqual(['e2']);
  });

  it('keeps no more than it is asked for', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      entry({ itemId: String(i), updatedAt: new Date(Date.UTC(2026, 8, 1, i)).toISOString() })
    );
    expect(continueWatching([many], 5)).toHaveLength(5);
  });
});

describe('a show in Continue watching', () => {
  const show = (itemId: string, seriesId: string, updatedAt: string, completed = false) =>
    entry({ type: 'series', itemId, seriesId, name: seriesId, completed, positionSeconds: completed ? 2990 : 600, durationSeconds: 3000, updatedAt });

  it('stays when its latest episode was finished: there is a next one', () => {
    const result = continueWatching([[show('e4', 'novine', '2026-09-14T20:00:00Z', true)]]);

    expect(result.map(item => item.seriesId)).toEqual(['novine']);
  });

  it('is left out once taken out, and comes back when watched again', () => {
    const hidden = { novine: '2026-09-14T21:00:00Z' };

    expect(latestPerShow([show('e4', 'novine', '2026-09-14T20:00:00Z')], hidden)).toEqual([]);
    expect(latestPerShow([show('e5', 'novine', '2026-09-14T22:00:00Z')], hidden).map(item => item.itemId)).toEqual(['e5']);
  });

  it('reads a damaged list of taken-out shows as none', () => {
    expect(readHiddenShows('{nope')).toEqual({});
    expect(readHiddenShows(JSON.stringify({ a: '2026-09-14T21:00:00Z', b: 3 }))).toEqual({ a: '2026-09-14T21:00:00Z' });
  });
});

describe('watchedWhen', () => {
  const now = new Date(2026, 8, 14, 21, 0);

  it('says today, last night, yesterday, a weekday, or a date', () => {
    expect(watchedWhen(new Date(2026, 8, 14, 9).toISOString(), now)).toBe('today');
    expect(watchedWhen(new Date(2026, 8, 13, 22).toISOString(), now)).toBe('last night');
    expect(watchedWhen(new Date(2026, 8, 13, 10).toISOString(), now)).toBe('yesterday');
    expect(watchedWhen(new Date(2026, 8, 10, 10).toISOString(), now)).toBe('Thursday');
    expect(watchedWhen(new Date(2026, 7, 30, 10).toISOString(), now)).toBe('30 Aug');
  });

  it('says nothing for a date it cannot read', () => {
    expect(watchedWhen('not a date', now)).toBe('');
  });
});

describe('programmeOnNow', () => {
  const now = Date.parse('2026-09-14T20:00:00Z');

  it('finds the programme on air, with the time left and how far through', () => {
    const rows = [
      { title: 'Vijesti', start: '2026-09-14T19:00:00Z', stop: '2026-09-14T19:30:00Z' },
      { title: 'Dnevnik', start_timestamp: now / 1000 - 600, stop_timestamp: now / 1000 + 1800 }
    ];
    expect(programmeOnNow(rows, now)).toEqual({ title: 'Dnevnik', left: '30 min left', percent: 25 });
  });

  it('says nothing when nothing is on or there is no guide', () => {
    expect(programmeOnNow([{ title: 'Later', start: now + 60_000, stop: now + 120_000 }], now)).toBeNull();
    expect(programmeOnNow(undefined, now)).toBeNull();
  });
});
