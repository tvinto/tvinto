import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { Stream } from '@shared/types';
import { TmdbFilm } from '@shared/tmdb/client';
import { DescriptionsService } from './descriptions.service';
import { FilmService } from './film.service';
import { PopularService } from './popular.service';
import { TmdbService } from './tmdb.service';
import { XtreamService } from './xtream.service';

/**
 * A film's own page (round 6, TV-27) and choosing its copy (TV-28): TMDB's
 * details, the library's copies in Play's order, the choice remembered, and
 * Play still reachable when TMDB does not answer.
 */

const stream = (id: number, name: string, category: string): Stream => ({ stream_id: String(id), name, category_id: category }) as unknown as Stream;

/** What the library holds of each title. */
const copiesOf = (item: { title: string }): Stream[] =>
  item.title === 'Unheld'
    ? []
    : item.title === 'The Matrix Reloaded'
      ? [stream(9, 'EN - The Matrix Reloaded', '30')]
      : [stream(1, 'AR - The Matrix (CAM)', '10'), stream(2, '|AR| The Matrix', '10'), stream(3, '[4K] - The Matrix', '20'), stream(4, 'EN - The Matrix', '30')];

const matrix: TmdbFilm = {
  id: 603,
  title: 'The Matrix',
  originalTitle: 'The Matrix',
  overview: 'A hacker.',
  year: '1999',
  runtime: 136,
  genres: ['Action'],
  vote: 8.2,
  poster: '/p.jpg',
  backdrop: '/b.jpg',
  certifications: { DE: '16', US: 'R' },
  collection: { id: 2344, name: 'The Matrix Collection', poster: '/c.jpg', backdrop: '' },
  recommendations: [
    { kind: 'movie', id: 604, title: 'The Matrix Reloaded', originalTitle: 'The Matrix Reloaded', overview: '', year: '2003', poster: '' },
    { kind: 'movie', id: 9999, title: 'Unheld', originalTitle: 'Unheld', overview: '', year: '2001', poster: '' }
  ],
  trailers: [
    { key: 'teaser0001', name: 'Teaser', type: 'Teaser', official: true, language: 'en' },
    { key: 'trailer001', name: 'Official Trailer', type: 'Trailer', official: true, language: 'en' }
  ]
};

describe('FilmService', () => {
  const setup = (options: { film?: TmdbFilm | null; failing?: boolean; tmdbId?: number | null; providerName?: string } = {}) => {
    TestBed.resetTestingModule();
    const client = {
      film: async () => {
        if (options.failing) {
          throw new Error('TMDB answered 503');
        }
        return options.film === undefined ? matrix : options.film;
      },
      collection: async () => ({ id: 2344, name: 'The Matrix Collection', backdrop: '', parts: [matrix, { ...matrix.recommendations[0] }, { ...matrix.recommendations[1] }].map(item => ({ ...item, kind: 'movie' as const })) })
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: TmdbService, useValue: { client: async () => client } },
        {
          provide: DescriptionsService,
          useValue: { language: signal('en'), filmTmdbId: async (_id: string, name: string) => ({
            id: options.tmdbId === undefined ? 603 : options.tmdbId,
            plot: "The provider's words.",
            name: name || (options.providerName ?? '')
          })
        }
        },
        {
          provide: PopularService,
          useValue: {
            copiesOf: async (item: { title: string }) => copiesOf(item),
            copiesIn: async (_type: string, items: { id: number; title: string }[]) => new Map(items.map(item => [item.id, copiesOf(item)]))
          }
        },
        {
          provide: XtreamService,
          useValue: {
            getCategories: () =>
              of([
                { category_id: '10', category_name: '|AR| AFLAM' },
                { category_id: '20', category_name: '|EN| 4K UHD MOVIES' },
                { category_id: '30', category_name: '|EN| NEW RELEASES' }
              ])
          }
        }
      ]
    });
    return TestBed.inject(FilmService);
  };

  beforeEach(() => localStorage.clear());

  it("builds the page: TMDB's details, Germany's rating where Croatia has none, the copies in Play's order", async () => {
    const page = await setup().open('603');

    expect(page).toMatchObject({ title: 'The Matrix', runtime: 136, rating: '16', vote: 8.2, detailsFailed: false });
    expect(page.backdrop).toBe('https://image.tmdb.org/t/p/w1280/b.jpg');
    // The trailer before the teaser: the first is what the Trailer button opens.
    expect(page.trailers.map(trailer => trailer.key)).toEqual(['trailer001', 'teaser0001']);
    expect(page.copies.map(copy => [copy.stream.stream_id, copy.language, copy.quality, copy.cinema])).toEqual([
      ['3', 'en', '4K', false],
      ['4', 'en', '', false],
      ['2', 'ar', '', false],
      ['1', 'ar', '', true]
    ]);
  });

  it('remembers the copy chosen for a film, and goes back to the first when it is gone', async () => {
    const films = setup();
    const page = await films.open('603');
    expect(films.playCopy(page)?.stream.stream_id).toBe('3');

    films.choose('603', '2');
    expect(films.playCopy(page)?.stream.stream_id).toBe('2');
    expect(films.chosen('603')).toBe('2');

    films.choose('603', '99');
    expect(films.playCopy(page)?.stream.stream_id).toBe('3');
  });

  it('still finds the copies from the list entry when TMDB does not answer, and says it did not', async () => {
    const page = await setup({ failing: true }).open('603', { title: 'The Matrix', originalTitle: 'The Matrix', year: '1999', poster: '/p.jpg' });

    expect(page.detailsFailed).toBe(true);
    expect(page.copies).toHaveLength(4);
    expect(page.poster).toBe('https://image.tmdb.org/t/p/w342/p.jpg');
  });

  it('gives up when TMDB does not answer and nothing else knows the film', async () => {
    await expect(setup({ failing: true }).open('603')).rejects.toThrow('TMDB answered 503');
  });

  it('opens a library film by stream: its TMDB page when its id is found and matches the copy', async () => {
    const page = await setup().open('s3', { name: '[4K] - The Matrix' });
    expect(page).toMatchObject({ ref: 's3', id: 603, title: 'The Matrix' });
    expect(page.copies).toHaveLength(4);
  });

  it('makes the page from the library alone when TMDB knows no film for the stream', async () => {
    const page = await setup({ tmdbId: null }).open('s3', { name: '[4K] - The Matrix (1999)', poster: 'http://cover' });
    expect(page).toMatchObject({ ref: 's3', id: 0, title: 'The Matrix', year: '1999', overview: "The provider's words.", poster: 'http://cover', collection: null });
    expect(page.copies.map(copy => copy.stream.stream_id)).toContain('3');
  });

  it("takes the provider's name for a page opened by its address, which knows none", async () => {
    const page = await setup({ tmdbId: null, providerName: 'EN - The Matrix (1999)' }).open('s4');
    expect(page).toMatchObject({ ref: 's4', title: 'The Matrix', year: '1999' });
  });

  it('keeps More like this to what the library has, and a collection with its gaps', async () => {
    const films = setup();
    const page = await films.open('603');
    expect((await films.moreLikeThis(page)).map(link => link.item.title)).toEqual(['The Matrix Reloaded']);

    const collection = await films.collection(2344);
    expect(collection?.parts.map(part => [part.item.title, part.copies])).toEqual([
      ['The Matrix', 4],
      ['The Matrix Reloaded', 1],
      ['Unheld', 0]
    ]);
  });
});
