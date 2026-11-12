import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Stream } from '@shared/types';
import { TmdbShow } from '@shared/tmdb/client';
import { DescriptionsService } from './descriptions.service';
import { FilmService } from './film.service';
import { PopularService } from './popular.service';
import { ShowService, localToday } from './show.service';
import { TmdbService } from './tmdb.service';

/**
 * TMDB on a show's page (round 6, TV-29): the age rating and score, the line
 * about the next episode -- "ready to play" only when the provider has it --
 * the copies, and nothing at all without TMDB.
 */

const stream = (id: number, name: string): Stream => ({ stream_id: String(id), name }) as unknown as Stream;

const severance = (next: string): TmdbShow => ({
  id: 95396,
  title: 'Severance',
  originalTitle: 'Severance',
  overview: '',
  year: '2022',
  genres: ['Drama'],
  vote: 8.4,
  poster: '/p.jpg',
  backdrop: '/b.jpg',
  seasons: 2,
  status: 'Returning Series',
  next: { season: 2, episode: 6, name: 'Attila', airDate: next },
  last: null,
  certifications: { DE: '16' },
  recommendations: [],
  trailers: []
});

describe('ShowService', () => {
  const setup = (options: { show?: TmdbShow; tmdbId?: number | null; asked?: { count: number }; fail?: boolean } = {}) => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TmdbService, useValue: {
            client: async () => ({
              show: async () => {
                if (options.asked) {
                  options.asked.count++;
                }
                if (options.fail) {
                  throw new Error('down');
                }
                return options.show ?? severance(localToday());
              }
            })
          }
        },
        { provide: DescriptionsService, useValue: { language: signal('en'), showTmdbId: async () => (options.tmdbId === undefined ? 95396 : options.tmdbId) } },
        { provide: PopularService, useValue: { copiesOf: async () => [stream(10, 'EN - Severance'), stream(11, 'DE - Severance')] } },
        {
          provide: FilmService,
          useValue: {
            described: async (streams: Stream[]) => streams.map(item => ({ stream: item, category: '', language: '', languageName: '', quality: '', cinema: false })),
            linked: async () => []
          }
        }
      ]
    });
    return TestBed.inject(ShowService);
  };

  beforeEach(() => localStorage.clear());

  it("builds the page: Germany's rating, the score, the copies, and today's episode as ready when the provider has it", async () => {
    const info = { episodes: { '2': [{ season: 2, episode_num: 6 }] } };
    const page = await setup().forSeries('10', 'EN - Severance', info);

    expect(page).toMatchObject({ tmdbId: 95396, rating: '16', vote: 8.4, seasons: 2 });
    expect(page?.news).toMatchObject({ kind: 'today', season: 2, episode: 6, ready: true });
    expect(page?.copies.map(copy => copy.stream.stream_id)).toEqual(['10', '11']);
  });

  it('says an episode out today is not on the provider yet when its list lacks it', async () => {
    const page = await setup().forSeries('10', 'EN - Severance', { episodes: { '2': [{ season: 2, episode_num: 5 }] } });
    expect(page?.news).toMatchObject({ kind: 'today', ready: false });
  });

  it('adds nothing for a show TMDB does not know', async () => {
    expect(await setup({ tmdbId: null }).forSeries('10', 'EN - Severance', {})).toBeNull();
  });

  it("asks TMDB for For You's news once a day per show", async () => {
    const asked = { count: 0 };
    const shows = setup({ asked });
    const facts = await shows.newsFacts('10', 'Severance', null, '2026-10-18');
    expect(facts).toMatchObject({ tmdbId: 95396, poster: 'https://image.tmdb.org/t/p/w342/p.jpg', next: { season: 2, episode: 6 } });
    await shows.newsFacts('10', 'Severance', null, '2026-10-18');
    expect(asked.count).toBe(1);
    await shows.newsFacts('10', 'Severance', null, '2026-10-19');
    expect(asked.count).toBe(2);
  });

  it('asks again after a failed request instead of keeping nothing for the day', async () => {
    const asked = { count: 0 };
    expect(await setup({ asked, fail: true }).newsFacts('10', 'Severance', null, '2026-10-18')).toBeNull();
    expect(await setup({ asked }).newsFacts('10', 'Severance', null, '2026-10-18')).not.toBeNull();
    expect(asked.count).toBe(2);
  });

  it('remembers the copy chosen for a show', () => {
    const shows = setup();
    shows.choose(95396, '11');
    expect(shows.chosen(95396)).toBe('11');
  });
});
