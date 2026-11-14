import { TmdbError, TmdbFetch, ageRating, listGenre, listRequest, tmdbClient, tmdbPoster } from './client';
import { groupCopies, isVersionOf, plainTitle, versionsOf } from './popular';
import { newsForRow, newsOrder, showNews } from './episodes';
import { orderTrailers, trailersFrom, videoLanguages } from './trailers';
import { copyLanguage, copyQuality, copyQualityLabel, isCinemaRecording, orderCopies } from './copies';
import { chooseDescription, findTmdbId, pickMatch, readDescriptionLanguage } from './describe';

/** A TMDB that answers from a table, and remembers what it was asked. */
const fakeTmdb = (answers: Record<string, unknown>, status = 200) => {
  const asked: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn: TmdbFetch = async (url, init) => {
    asked.push({ url, headers: init.headers });
    const path = new URL(url).pathname.replace('/3', '');
    const body = answers[path];
    return {
      ok: status === 200 && body !== undefined,
      status: status !== 200 ? status : body === undefined ? 404 : 200,
      json: async () => body
    };
  };
  return { fetchFn, asked };
};

describe('the client', () => {
  it('sends a v3 key as api_key and a v4 token as a bearer', async () => {
    const tmdb = fakeTmdb({ '/movie/603': { id: 603, title: 'The Matrix', overview: 'A hacker.', release_date: '1999-03-30' } });

    await tmdbClient(tmdb.fetchFn, 'abc123').details('movie', 603, 'en-US');
    await tmdbClient(tmdb.fetchFn, 'eyJhbGciOi.token').details('movie', 603, 'en-US');

    expect(new URL(tmdb.asked[0].url).searchParams.get('api_key')).toBe('abc123');
    expect(tmdb.asked[0].headers['Authorization']).toBeUndefined();
    expect(new URL(tmdb.asked[1].url).searchParams.get('api_key')).toBeNull();
    expect(tmdb.asked[1].headers['Authorization']).toBe('Bearer eyJhbGciOi.token');
  });

  it('reads a film in the language asked for', async () => {
    const tmdb = fakeTmdb({ '/movie/603': { id: 603, title: 'Matrix', original_title: 'The Matrix', overview: 'Haker.', release_date: '1999-03-30' } });

    const film = await tmdbClient(tmdb.fetchFn, 'k').details('movie', 603, 'hr-HR');

    expect(film).toEqual({ id: 603, title: 'Matrix', originalTitle: 'The Matrix', overview: 'Haker.', year: '1999' });
    expect(new URL(tmdb.asked[0].url).searchParams.get('language')).toBe('hr-HR');
  });

  it('reads a season of episodes', async () => {
    const tmdb = fakeTmdb({
      '/tv/1668/season/3': { episodes: [{ episode_number: 1, name: 'The One with the Princess Leia Fantasy', overview: 'Ross.' }] }
    });

    expect(await tmdbClient(tmdb.fetchFn, 'k').season(1668, 3, 'en-US')).toEqual([
      { episode: 1, name: 'The One with the Princess Leia Fantasy', overview: 'Ross.' }
    ]);
  });

  it('answers null for an id TMDB does not have, and throws on a refused key', async () => {
    expect(await tmdbClient(fakeTmdb({}).fetchFn, 'k').details('movie', 1, 'en-US')).toBeNull();
    await expect(tmdbClient(fakeTmdb({}, 401).fetchFn, 'k').details('movie', 1, 'en-US')).rejects.toBeInstanceOf(TmdbError);
  });
});

describe('choosing the description', () => {
  it('prefers TMDB in the chosen language, then English, then the provider', () => {
    expect(chooseDescription('hr', { chosen: 'Hrvatski.', english: 'English.', provider: 'Svenska.' })).toEqual({ text: 'Hrvatski.', source: 'tmdb' });
    expect(chooseDescription('hr', { chosen: '', english: 'English.', provider: 'Svenska.' })).toEqual({ text: 'English.', source: 'tmdb' });
    expect(chooseDescription('hr', { provider: 'Svenska.' })).toEqual({ text: 'Svenska.', source: 'provider' });
  });

  it("keeps the provider's when that is the choice, and fills it only where it is empty", () => {
    expect(chooseDescription('provider', { english: 'English.', provider: 'Svenska.' })).toEqual({ text: 'Svenska.', source: 'provider' });
    expect(chooseDescription('provider', { english: 'English.', provider: '  ' })).toEqual({ text: 'English.', source: 'tmdb' });
    expect(chooseDescription('provider', {})).toBeNull();
  });

  it('reads anything unexpected as the provider', () => {
    expect(readDescriptionLanguage('xx')).toBe('provider');
    expect(readDescriptionLanguage('de')).toBe('de');
    expect(readDescriptionLanguage(null)).toBe('provider');
    expect(readDescriptionLanguage('hr')).toBe('hr');
  });
});

describe('finding the film', () => {
  const result = (id: number, title: string, year: string, originalTitle = title) => ({ id, title, originalTitle, overview: '', year });

  it('matches a name set apart from its case, accents and punctuation', () => {
    expect(pickMatch([result(1, 'Amélie', '2001')], ['amelie'], 2001)?.id).toBe(1);
    expect(pickMatch([result(2, 'Fast & Furious', '2009')], ['Fast and Furious'], null)?.id).toBe(2);
  });

  it('tells a remake from the original by the year', () => {
    const both = [result(1, 'Dune', '1984'), result(2, 'Dune', '2021')];

    expect(pickMatch(both, ['Dune'], 2021)?.id).toBe(2);
    expect(pickMatch(both, ['Dune'], null)).toBeNull();
  });

  it('takes nothing rather than a name that is only close', () => {
    expect(pickMatch([result(1, 'X-Men: First Class', '2011')], ['X-Men'], 2011)).toBeNull();
  });

  it("uses the provider's TMDB id, then IMDb, then a search", async () => {
    const tmdb = fakeTmdb({
      '/find/tt0133093': { movie_results: [{ id: 603 }] },
      '/search/movie': { results: [{ id: 76341, title: 'Mad Max: Fury Road', release_date: '2015-05-13' }] }
    });
    const client = tmdbClient(tmdb.fetchFn, 'k');
    const known = { kind: 'movie' as const, tmdbId: null, imdbId: null, title: 'Mad Max: Fury Road', originalTitle: null, year: 2015 };

    expect(await findTmdbId(client, { ...known, tmdbId: 550 })).toBe(550);
    expect(await findTmdbId(client, { ...known, imdbId: 133093 })).toBe(603);
    expect(await findTmdbId(client, known)).toBe(76341);
    expect(tmdb.asked).toHaveLength(2);
  });
});

describe('popular now', () => {
  const dune = { title: 'Dune: Part Two', originalTitle: 'Dune: Part Two', year: '2024' };

  it('finds a film under its copies: the tags, the quality, the case', () => {
    for (const name of ['Dune: Part Two', '|EN| Dune: Part Two', '[4K] - Dune Part Two', 'DUNE PART TWO 4K', 'Dune: Part Two [UHD]', 'NL - Dune: Part Two (MULTI SUB)', 'SD/CAM - Dune: Part Two', '4K-HDR - Dune: Part Two']) {
      expect(isVersionOf(dune, name, null)).toBe(true);
    }
  });

  it('keeps a remake, a sequel and a near name apart', () => {
    expect(isVersionOf(dune, 'Dune: Part Two', 2021)).toBe(false);
    expect(isVersionOf(dune, 'Dune: Part Three', 2024)).toBe(false);
    expect(isVersionOf({ title: 'Dune', originalTitle: 'Dune', year: '2021' }, 'Dune: Part Two', 2024)).toBe(false);
    expect(isVersionOf(dune, '', null)).toBe(false);
  });

  it('matches the original title, for a film the provider names in its own language', () => {
    expect(isVersionOf({ title: 'Parasite', originalTitle: '기생충', year: '2019' }, '|KR| 기생충', 2019)).toBe(true);
    expect(isVersionOf({ title: 'The Bridge', originalTitle: 'Most', year: '2024' }, 'EX - Most', 2024)).toBe(true);
  });

  it("drops an undated copy of a name that is also another year's, and keeps it where all agree", () => {
    const read = (name: string) => {
      const year = /\((\d{4})\)/.exec(name)?.[1];
      return { title: name.replace(/\s*\(\d{4}\)/, ''), year: year ? Number(year) : null };
    };
    const remake = { title: 'Resident Evil', originalTitle: 'Resident Evil', year: '2026' };
    expect(versionsOf(remake, ['EN - Resident Evil (2002)', 'NF - Resident Evil', 'EN - Resident Evil (2026)'], read)).toEqual(['EN - Resident Evil (2026)']);

    const fresh = { title: 'Practical Magic 2', originalTitle: 'Practical Magic 2', year: '2026' };
    expect(versionsOf(fresh, ['EN - Practical Magic 2 (2026)', 'SE - Practical Magic 2', 'EN - Practical Magic (1998)'], read)).toEqual([
      'EN - Practical Magic 2 (2026)',
      'SE - Practical Magic 2'
    ]);
  });

  it('leaves a short title that looks like a tag alone', () => {
    expect(plainTitle('X-Men 4K')).toBe('X-Men');
    expect(plainTitle('Up')).toBe('Up');
  });

  it('reads trending films and shows apart, and how many pages there are', async () => {
    const tmdb = fakeTmdb({
      '/trending/movie/week': {
        results: [
          { media_type: 'movie', id: 1, title: 'Sacrifice', release_date: '2025-10-01', poster_path: '/s.jpg' },
          { media_type: 'person', id: 2, name: 'Somebody' }
        ],
        total_pages: 1000
      },
      '/trending/tv/week': { results: [{ id: 3, name: 'The Bear', first_air_date: '2022-06-23', poster_path: '' }], total_pages: 7 }
    });
    const client = tmdbClient(tmdb.fetchFn, 'abc123');
    const films = await client.trending('movie', 'en-US', 2);
    const shows = await client.trending('tv', 'en-US');

    expect([...films.items, ...shows.items].map(item => [item.kind, item.title, item.year, item.poster])).toEqual([
      ['movie', 'Sacrifice', '2025', '/s.jpg'],
      ['tv', 'The Bear', '2022', '']
    ]);
    expect([films.pages, shows.pages]).toEqual([500, 7]);
    expect(new URL(tmdb.asked[0].url).searchParams.get('page')).toBe('2');
    expect(tmdbPoster('/s.jpg')).toBe('https://image.tmdb.org/t/p/w342/s.jpg');
    expect(tmdbPoster('')).toBe('');
  });
});

describe('which copy comes first', () => {
  it('reads the language from the tag on the name, else on the category', () => {
    expect(copyLanguage('|AR| Hope')).toBe('ar');
    expect(copyLanguage('EN - Hope (2026)')).toBe('en');
    expect(copyLanguage('EX - Hope', '')).toBe('hr');
    expect(copyLanguage('Hope', '|EX-YU| STRANI FILMOVI')).toBe('hr');
    expect(copyLanguage('Hope', 'Drama')).toBe('');
    expect([copyLanguage('Hope', '|GR| GREECE SERIES SUB'), copyLanguage('|IR| Hope')]).toEqual(['el', 'fa']);
  });

  it('reads the picture and a cinema recording', () => {
    expect([copyQuality('[4K] - Dune'), copyQuality('Dune 1080p'), copyQuality('Dune', '|EN| HD MOVIES'), copyQuality('Dune')]).toEqual([3, 2, 1, 0]);
    expect(isCinemaRecording('AR - Hope (CAM)')).toBe(true);
    expect(isCinemaRecording('Hope', '|AR| HDCAM 2026')).toBe(true);
    expect(isCinemaRecording('Hope (2026)')).toBe(false);
  });

  it('puts your languages first, the best picture within one, and cinema recordings last', () => {
    const copies = [
      { name: 'AR - Hope (CAM)' },
      { name: '|AR| Hope' },
      { name: 'EN - Hope', category: '|EN| NEW RELEASES' },
      { name: '[4K] - Hope', category: '|EN| 4K UHD MOVIES' },
      { name: 'EX - Hope', category: '|EX-YU| FILMOVI 2026' },
      { name: 'EN - Hope (CAM)' }
    ];
    const order = (languages: string[]) => orderCopies(copies, languages, copy => copy).map(copy => copy.name);

    expect(order(['hr', 'en'])).toEqual(['EX - Hope', '[4K] - Hope', 'EN - Hope', '|AR| Hope', 'EN - Hope (CAM)', 'AR - Hope (CAM)']);
    expect(order(['en'])[0]).toBe('[4K] - Hope');
    expect(orderCopies([{ name: 'AR - Hope (CAM)' }], ['hr'], copy => copy)).toHaveLength(1);
  });
});

describe("a film's own page", () => {
  it('reads runtime, genres, score, artwork and each country\'s age rating in one request', async () => {
    const tmdb = fakeTmdb({
      '/movie/603': {
        id: 603,
        title: 'The Matrix',
        release_date: '1999-03-30',
        runtime: 136,
        genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
        vote_average: 8.217,
        vote_count: 25000,
        poster_path: '/p.jpg',
        backdrop_path: '/b.jpg',
        release_dates: {
          results: [
            { iso_3166_1: 'DE', release_dates: [{ certification: '' }, { certification: '16' }] },
            { iso_3166_1: 'US', release_dates: [{ certification: 'R' }] },
            { iso_3166_1: 'HR', release_dates: [{ certification: '' }] }
          ]
        }
      }
    });
    const film = await tmdbClient(tmdb.fetchFn, 'k').film(603, 'en-US');

    expect(film).toMatchObject({ title: 'The Matrix', year: '1999', runtime: 136, genres: ['Action', 'Science Fiction'], vote: 8.2, poster: '/p.jpg', backdrop: '/b.jpg' });
    expect(film?.certifications).toEqual({ DE: '16', US: 'R' });
    expect(new URL(tmdb.asked[0].url).searchParams.get('append_to_response')).toBe('release_dates,recommendations,videos');
  });

  it('asks for the top rated, a genre at its most popular and at its best, and the genres', async () => {
    const page = { results: [{ id: 238, title: 'The Godfather', original_title: 'The Godfather', release_date: '1972-03-14' }], total_pages: 900 };
    const tmdb = fakeTmdb({
      '/discover/movie': page,
      '/genre/tv/list': { genres: [{ id: 80, name: 'Crime' }, { id: 0, name: 'Nothing' }] },
      '/movie/238': { id: 238, genres: [{ id: 18, name: 'Drama' }, { id: 80, name: 'Crime' }] }
    });
    const client = tmdbClient(tmdb.fetchFn, 'k');
    expect(await client.list('movie', 'top', 'en-US')).toEqual({ items: [expect.objectContaining({ id: 238, year: '1972' })], pages: 500 });
    await client.list('movie', 'genre-80', 'en-US', 2);
    await client.list('movie', 'genre-80-top', 'en-US');
    const [, popular, best] = tmdb.asked.map(asked => new URL(asked.url).searchParams);
    expect([popular.get('with_genres'), popular.get('sort_by'), popular.get('page')]).toEqual(['80', 'popularity.desc', '2']);
    expect([best.get('sort_by'), best.get('vote_count.gte')]).toEqual(['vote_average.desc', '2000']);
    expect(new URL(tmdb.asked[0].url).pathname).toBe('/3/discover/movie');
    expect(await client.genres('tv', 'hr-HR')).toEqual([{ id: 80, name: 'Crime' }]);
    expect(await client.genreIds('movie', 238)).toEqual([18, 80]);
    expect(listGenre('genre-35-top')).toEqual({ genre: 35, top: true });
    expect(listGenre('top')).toBeNull();
  });

  it("asks for the most popular, and the year's releases out at home", () => {
    const today = new Date('2026-11-14T12:00:00Z');
    expect(listRequest('movie', 'popular', today)).toEqual({ path: '/movie/popular', params: {} });
    expect(listRequest('tv', 'popular', today)).toEqual({ path: '/tv/popular', params: {} });
    expect(listRequest('movie', 'new', today)).toEqual({
      path: '/discover/movie',
      params: { sort_by: 'popularity.desc', with_release_type: '4|5', 'release_date.gte': '2025-11-14', 'release_date.lte': '2026-11-14' }
    });
    expect(listRequest('tv', 'new', today).params).toMatchObject({ 'first_air_date.gte': '2025-11-14', 'first_air_date.lte': '2026-11-14' });
    expect(listRequest('movie', 'trending', today).path).toBe('/trending/movie/week');
  });

  it("asks for a title's ratings alone, for the age lock", async () => {
    const tmdb = fakeTmdb({
      '/movie/603/release_dates': { results: [{ iso_3166_1: 'DE', release_dates: [{ certification: '' }, { certification: '16' }] }] },
      '/tv/95396/content_ratings': { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }, { iso_3166_1: 'HR', rating: '' }] }
    });
    const client = tmdbClient(tmdb.fetchFn, 'k');
    expect(await client.certifications('movie', 603)).toEqual({ DE: '16' });
    expect(await client.certifications('tv', 95396)).toEqual({ US: 'TV-MA' });
    expect(await client.certifications('movie', 1)).toBeNull();
  });

  it('takes the age rating from Croatia, else Germany, else the United States', () => {
    expect(ageRating({ DE: '16', US: 'R' })).toBe('16');
    expect(ageRating({ HR: '15', DE: '16' })).toBe('15');
    expect(ageRating({ US: 'PG-13' })).toBe('PG-13');
    expect(ageRating({ FR: '12' })).toBe('');
  });

  it('labels a copy\'s picture for its box', () => {
    expect([copyQualityLabel('[4K] - Dune'), copyQualityLabel('Dune 1080p'), copyQualityLabel('Dune', '|EN| HD MOVIES'), copyQualityLabel('Dune')]).toEqual(['4K', 'HD', 'HD', '']);
  });
});

describe('more like this, and collections', () => {
  it('reads the collection a film belongs to and its recommendations, in the same request', async () => {
    const tmdb = fakeTmdb({
      '/movie/1576': {
        id: 1576,
        title: 'Resident Evil',
        release_date: '2002-03-15',
        belongs_to_collection: { id: 17255, name: 'Resident Evil Collection', poster_path: '/c.jpg', backdrop_path: '/cb.jpg' },
        recommendations: { results: [{ id: 7737, media_type: 'movie', title: 'Resident Evil: Extinction', release_date: '2007-09-20', poster_path: '/e.jpg' }] }
      }
    });
    const film = await tmdbClient(tmdb.fetchFn, 'k').film(1576, 'en-US');

    expect(film?.collection).toEqual({ id: 17255, name: 'Resident Evil Collection', poster: '/c.jpg', backdrop: '/cb.jpg' });
    expect(film?.recommendations.map(item => [item.id, item.title, item.year])).toEqual([[7737, 'Resident Evil: Extinction', '2007']]);
    expect(new URL(tmdb.asked[0].url).searchParams.get('append_to_response')).toBe('release_dates,recommendations,videos');
  });

  it('reads a collection with its films in release order', async () => {
    const tmdb = fakeTmdb({
      '/collection/17255': {
        id: 17255,
        name: 'Resident Evil Collection',
        parts: [
          { id: 7737, title: 'Resident Evil: Extinction', release_date: '2007-09-20' },
          { id: 1576, title: 'Resident Evil', release_date: '2002-03-15' },
          { id: 1577, title: 'Resident Evil: Apocalypse', release_date: '2004-09-10' }
        ]
      }
    });
    const collection = await tmdbClient(tmdb.fetchFn, 'k').collection(17255, 'en-US');

    expect(collection?.parts.map(part => part.year)).toEqual(['2002', '2004', '2007']);
  });
});

describe('grouping copies in search', () => {
  const read = (name: string) => {
    const year = /\((\d{4})\)/.exec(name)?.[1];
    return { title: name.replace(/\s*\(\d{4}\)/, ''), year: year ? Number(year) : null };
  };

  it('puts the copies of one film together, in the order the first came', () => {
    const groups = groupCopies(['EN - Hope (2026)', 'Dune (2021)', '|AR| Hope (2026)', '[4K] - Hope 4K (2026)', 'EN - Dune (2021)'], read);
    expect(groups).toEqual([['EN - Hope (2026)', '|AR| Hope (2026)', '[4K] - Hope 4K (2026)'], ['Dune (2021)', 'EN - Dune (2021)']]);
  });

  it('keeps a remake apart, and joins an undated copy only where its name has one year', () => {
    expect(groupCopies(['EN - Dune (1984)', 'EN - Dune (2021)', 'NL - Dune'], read)).toEqual([['EN - Dune (1984)'], ['EN - Dune (2021)'], ['NL - Dune']]);
    expect(groupCopies(['SE - Practical Magic 2', 'EN - Practical Magic 2 (2026)'], read)).toEqual([['SE - Practical Magic 2', 'EN - Practical Magic 2 (2026)']]);
  });
});

describe("a show's page", () => {
  it('reads a show with its ratings, next and last episodes and recommendations, in one request', async () => {
    const tmdb = fakeTmdb({
      '/tv/95396': {
        id: 95396,
        name: 'Severance',
        first_air_date: '2022-02-17',
        number_of_seasons: 2,
        status: 'Returning Series',
        vote_average: 8.4,
        vote_count: 2000,
        genres: [{ name: 'Drama' }, { name: 'Mystery' }],
        next_episode_to_air: { season_number: 2, episode_number: 6, name: 'Attila', air_date: '2026-10-24' },
        last_episode_to_air: { season_number: 2, episode_number: 5, name: 'Trojan Horse', air_date: '2026-10-17' },
        content_ratings: { results: [{ iso_3166_1: 'DE', rating: '16' }, { iso_3166_1: 'US', rating: 'TV-MA' }] },
        recommendations: { results: [{ id: 100, media_type: 'tv', name: 'The Bear', first_air_date: '2022-06-23' }] }
      }
    });
    const show = await tmdbClient(tmdb.fetchFn, 'k').show(95396, 'en-US');

    expect(show).toMatchObject({ title: 'Severance', year: '2022', seasons: 2, vote: 8.4, genres: ['Drama', 'Mystery'] });
    expect(show?.next).toEqual({ season: 2, episode: 6, name: 'Attila', airDate: '2026-10-24' });
    expect(show?.certifications).toEqual({ DE: '16', US: 'TV-MA' });
    expect(show?.recommendations.map(item => [item.kind, item.title])).toEqual([['tv', 'The Bear']]);
  });

  it('says what is new: out today, a day coming, a season starting, recently, or ended', () => {
    const held = (season: number, episode: number) => season === 2 && episode === 6;
    const episode = (season: number, number: number, airDate: string) => ({ season, episode: number, name: 'X', airDate });

    expect(showNews({ next: episode(2, 6, '2026-10-24'), last: null, status: 'Returning Series' }, '2026-10-24', held)).toMatchObject({ kind: 'today', ready: true });
    expect(showNews({ next: episode(2, 7, '2026-10-24'), last: null, status: 'Returning Series' }, '2026-10-24', held)).toMatchObject({ kind: 'today', ready: false });
    expect(showNews({ next: episode(2, 7, '2026-10-31'), last: null, status: 'Returning Series' }, '2026-10-24', held)).toMatchObject({ kind: 'soon', date: '2026-10-31' });
    expect(showNews({ next: episode(3, 1, '2026-11-02'), last: null, status: 'Returning Series' }, '2026-10-24', held)).toEqual({ kind: 'season', season: 3, date: '2026-11-02' });
    expect(showNews({ next: null, last: episode(2, 6, '2026-10-20'), status: 'Returning Series' }, '2026-10-24', held)).toMatchObject({ kind: 'recent', ready: true });
    expect(showNews({ next: null, last: episode(4, 10, '2025-06-01'), status: 'Ended' }, '2026-10-24', held)).toEqual({ kind: 'ended', year: '2025' });
    expect(showNews({ next: null, last: episode(4, 10, '2025-06-01'), status: 'Returning Series' }, '2026-10-24', held)).toBeNull();
  });
});

describe('New in your shows', () => {
  const today = '2026-10-18';

  it('takes what is out and what is announced for the next two weeks', () => {
    expect(newsForRow({ kind: 'today', season: 1, episode: 2, name: '', ready: false }, today)).toBe(true);
    expect(newsForRow({ kind: 'recent', season: 1, episode: 2, name: '', ready: false }, today)).toBe(true);
    expect(newsForRow({ kind: 'soon', season: 1, episode: 3, name: '', date: '2026-11-01' }, today)).toBe(true);
    expect(newsForRow({ kind: 'soon', season: 1, episode: 3, name: '', date: '2026-11-02' }, today)).toBe(false);
    expect(newsForRow({ kind: 'season', season: 4, date: '2027-03-01' }, today)).toBe(false);
    expect(newsForRow({ kind: 'ended', year: '2025' }, today)).toBe(false);
    expect(newsForRow(null, today)).toBe(false);
  });

  it('says an episode out today or this week before the next one announced', () => {
    const show = (last: string) => ({
      status: 'Returning Series',
      last: { season: 3, episode: 4, name: 'a', airDate: last },
      next: { season: 3, episode: 5, name: 'b', airDate: '2026-10-25' }
    });
    expect(showNews(show(today), today, () => true)).toMatchObject({ kind: 'today', episode: 4 });
    expect(showNews(show('2026-10-14'), today, () => true)).toMatchObject({ kind: 'recent', episode: 4 });
    expect(showNews(show('2026-10-01'), today, () => true)).toMatchObject({ kind: 'soon', episode: 5 });
  });

  it('puts today first, then this week, then the nearest announced', () => {
    const list = [
      { kind: 'soon' as const, season: 1, episode: 3, name: 'b', date: '2026-10-25' },
      { kind: 'season' as const, season: 2, date: '2026-10-20' },
      { kind: 'recent' as const, season: 1, episode: 2, name: 'r', ready: false },
      { kind: 'today' as const, season: 1, episode: 2, name: 't', ready: false }
    ];
    expect(list.sort(newsOrder).map(news => news.kind)).toEqual(['today', 'recent', 'season', 'soon']);
  });
});

describe('Trailers', () => {
  const video = (key: string, type: string, language: string, official = true, site = 'YouTube') => ({ key, type, iso_639_1: language, official, site, name: key });

  it("keeps YouTube's trailers and teasers, and offers the official one in the person's language first", () => {
    const found = trailersFrom({
      results: [video('teaserHR01', 'Teaser', 'hr'), video('trailerEN1', 'Trailer', 'en'), video('clip00001', 'Clip', 'en'), video('vimeo0001', 'Trailer', 'en', true, 'Vimeo'), video('trailerHR1', 'Trailer', 'hr'), video('fanEN0001', 'Trailer', 'en', false)]
    });
    expect(found.map(trailer => trailer.key)).toEqual(['teaserHR01', 'trailerEN1', 'trailerHR1', 'fanEN0001']);
    expect(orderTrailers(found, ['hr', 'en']).map(trailer => trailer.key)).toEqual(['trailerHR1', 'trailerEN1', 'fanEN0001', 'teaserHR01']);
    expect(orderTrailers(found, ['en']).map(trailer => trailer.key)).toEqual(['trailerEN1', 'fanEN0001', 'trailerHR1', 'teaserHR01']);
  });

  it("asks for videos in the person's languages, English and none", () => {
    expect(videoLanguages(['hr', 'en'])).toBe('hr,en,null');
    expect(videoLanguages(['en'])).toBe('en,null');
  });
});
