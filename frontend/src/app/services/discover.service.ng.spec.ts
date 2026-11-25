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
        { provide: PopularService, useValue: { page: async (_kind: string, _page: number, list: string) => ({ found: Array(found[Number(list.slice(6))] ?? 0).fill({}), checked: 20, pages: 1 }) } },
        { provide: DescriptionsService, useValue: { language: signal('en'), filmTmdbId: async (id: string) => ({ id: Number(id), plot: '' }), showTmdbId: async () => null } }
      ]
    });
    return { discover: TestBed.inject(DiscoverService), asked };
  };

  beforeEach(() => localStorage.clear());

  it('offers every genre until counted, then only those the library has six of', async () => {
    const { discover, asked } = setup({ 28: 9, 35: 2, 80: 6 });
    expect((await discover.offered('movie')).map(genre => genre.name)).toEqual(['Action', 'Comedy', 'Crime']);
    expect(await discover.countGenres('movie', () => false)).toBe(true);
    expect((await discover.offered('movie')).map(genre => genre.name)).toEqual(['Action', 'Crime']);
    expect(asked.genres).toBe(1);
  });

  it('finds the genres watched most, two titles at least, each title asked about once', async () => {
    const { discover, asked } = setup();
    const history = [watched('1', 'Heat'), watched('2', 'Ronin'), watched('3', 'Airplane!'), watched('1', 'Heat')];
    expect(await discover.watched('movie', history)).toEqual([80]);
    await discover.watched('movie', history);
    expect(asked.titles).toBe(3);
  });
});
