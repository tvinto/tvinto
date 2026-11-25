import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { WatchProgress } from '@shared/types';
import { DescriptionsService } from './descriptions.service';
import { DiscoverService } from './discover.service';
import { PopularService } from './popular.service';
import { TmdbService } from './tmdb.service';

/**
 * Browsing by TMDB's lists (TV-32): the genres offered are those the library
 * has six of, once counted; the rows are the genres someone watches most,
 * each needing two titles.
 */
describe('DiscoverService', () => {
  const watched = (id: string, name: string): WatchProgress =>
    ({ type: 'vod', itemId: id, name, positionSeconds: 0, durationSeconds: 0, completed: false, updatedAt: '' }) as WatchProgress;

  /** The library's download time, as PopularService.libraryAt reads it. */
  let libraryAt: string | null;

  const setup = (found: Record<number, number> = {}) => {
    const asked = { genres: 0, titles: 0 };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: TmdbService,
          useValue: {
            client: async () => ({
              genres: async () => {
                asked.genres++;
                return [
                  { id: 28, name: 'Action' },
                  { id: 35, name: 'Comedy' },
                  { id: 80, name: 'Crime' }
                ];
              },
              genreIds: async (_kind: string, id: number) => {
                asked.titles++;
                return ({ 1: [80, 18], 2: [80, 28], 3: [35] } as Record<number, number[]>)[id] ?? [];
              }
            })
          }
        },
        { provide: PopularService, useValue: { libraryAt: async () => libraryAt, page: async (_kind: string, _page: number, list: string) => ({ found: Array(found[Number(list.slice(6))] ?? 0).fill({}), checked: 20, pages: 1 }) } },
        { provide: DescriptionsService, useValue: { language: signal('en'), filmTmdbId: async (id: string) => ({ id: Number(id), plot: '' }), showTmdbId: async () => null } }
      ]
    });
    return { discover: TestBed.inject(DiscoverService), asked };
  };

  beforeEach(() => {
    localStorage.clear();
    libraryAt = '2026-11-25T10:00:00Z';
  });

  it('offers every genre until counted, then only those the library has six of', async () => {
    const { discover, asked } = setup({ 28: 9, 35: 2, 80: 6 });
    expect((await discover.offered('movie')).map(genre => genre.name)).toEqual(['Action', 'Comedy', 'Crime']);
    expect(await discover.countGenres('movie', () => false)).toBe(true);
    expect((await discover.offered('movie')).map(genre => genre.name)).toEqual(['Action', 'Crime']);
    expect(asked.genres).toBe(1);
  });

  it("counts made before the library was last downloaded count for nothing, an empty library's above all (24 November)", async () => {
    // What 1.0.130 kept: counted on an empty library, no library time, fresh for a week.
    localStorage.setItem('xtream_tmdb_genre_counts_movie', JSON.stringify({ at: Date.now(), counts: { 28: 0, 35: 1, 80: 0 } }));
    const { discover } = setup({ 28: 9, 35: 2, 80: 6 });
    expect((await discover.offered('movie')).map(genre => genre.name)).toEqual(['Action', 'Comedy', 'Crime']);
    expect(await discover.countGenres('movie', () => false)).toBe(true);
    expect((await discover.offered('movie')).map(genre => genre.name)).toEqual(['Action', 'Crime']);

    // The library downloaded again: the counts are of the one before, so every genre until counted anew.
    libraryAt = '2026-11-26T10:00:00Z';
    expect((await discover.offered('movie')).map(genre => genre.name)).toEqual(['Action', 'Comedy', 'Crime']);
    expect(await discover.countGenres('movie', () => false)).toBe(true);

    // And none kept while the library is not held whole.
    libraryAt = null;
    expect((await discover.offered('movie')).map(genre => genre.name)).toEqual(['Action', 'Comedy', 'Crime']);
  });

  it('finds the genres watched most, two titles at least, each title asked about once', async () => {
    const { discover, asked } = setup();
    const history = [watched('1', 'Heat'), watched('2', 'Ronin'), watched('3', 'Airplane!'), watched('1', 'Heat')];
    expect(await discover.watched('movie', history)).toEqual([80]);
    await discover.watched('movie', history);
    expect(asked.titles).toBe(3);
  });
});
