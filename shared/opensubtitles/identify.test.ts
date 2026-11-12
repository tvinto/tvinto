import { episodeIdentity, filmIdentity, idFrom, searchFor, titleSuggestions } from './identify';
import {
  IDENTITY_LIMIT,
  IDENTITY_TTL_MS,
  identityKey,
  readIdentityStore,
  recall,
  remember,
  subscriptionKey
} from './identityCache';

/**
 * Knowing which film or episode it is. The shapes are an Xtream panel's:
 * `get_series_info` as this provider sent it for Friends and Deadwood on
 * 15 September (ids only kept), and `get_vod_info` as Xtream panels send it.
 */

describe('an id out of what a provider wrote', () => {
  it('reads numbers, numeric text and IMDb ids', () => {
    expect(idFrom(24188)).toBe(24188);
    expect(idFrom('1668')).toBe(1668);
    expect(idFrom('tt0133093')).toBe(133093);
    expect(idFrom(' 01406 ')).toBe(1406);
  });

  it('reads the ways panels say "unknown" as no id', () => {
    for (const nothing of [0, '0', '', 'null', 'N/A', null, undefined, -5, '12a', {}]) {
      expect(idFrom(nothing)).toBeNull();
    }
  });
});

describe('a film', () => {
  const VOD_INFO = {
    info: {
      tmdb_id: '24188',
      name: 'HR - Ne diraj mi mamu (2004)',
      o_name: 'Ne diraj mi mamu',
      releasedate: '2004-03-11',
      container_extension: 'mkv'
    },
    movie_data: { stream_id: 4512, name: 'HR - Ne diraj mi mamu (2004)', container_extension: 'mkv' }
  };

  it('is found by its TMDB id, and searched by the id alone', () => {
    const film = filmIdentity(VOD_INFO, { title: 'Ne diraj mi mamu', year: '2004' });

    expect(film).toEqual({
      kind: 'film',
      matchedBy: 'tmdb',
      tmdbId: 24188,
      imdbId: null,
      title: 'Ne diraj mi mamu',
      originalTitle: null,
      year: 2004
    });
    expect(searchFor(film, ['hr'])).toEqual({ tmdbId: 24188, languages: ['hr'] });
  });

  it('reads this provider’s films, which carry the year in the original title too', () => {
    // Two of the five films checked on 15 September, ids only.
    const outta = filmIdentity(
      { info: { tmdb_id: '74217', o_name: 'Outta Time (2002)', releasedate: '2002-03-28' }, movie_data: {} },
      { title: 'Outta Time', year: '2002' }
    );
    const lycans = filmIdentity(
      { info: { tmdb_id: '12437', o_name: 'Underworld: Rise of the Lycans', releasedate: '2009-01-22' } },
      { title: 'Underworld: Rise Of The Lycans', year: '2009' }
    );

    expect(outta).toMatchObject({ matchedBy: 'tmdb', tmdbId: 74217, originalTitle: null, year: 2002 });
    expect(lycans).toMatchObject({ tmdbId: 12437, originalTitle: null });
  });

  it('takes an IMDb id when there is no TMDB one', () => {
    const film = filmIdentity({ info: { tmdb_id: '', imdb_id: 'tt0110912' } }, { title: 'Pulp Fiction' });

    expect(film.matchedBy).toBe('imdb');
    expect(searchFor(film, ['en'])).toEqual({ imdbId: 110912, languages: ['en'] });
  });

  it('falls back to the title and year, and offers the original title', () => {
    const film = filmIdentity(
      { info: { tmdb_id: '0', o_name: 'The Dead Don’t Die', releasedate: '2019-06-14' } },
      { title: 'Mrtvi ne umiru' }
    );

    expect(film).toMatchObject({ matchedBy: 'title', title: 'Mrtvi ne umiru', originalTitle: 'The Dead Don’t Die', year: 2019 });
    expect(searchFor(film, ['hr', 'en'])).toEqual({ query: 'Mrtvi ne umiru', year: 2019, type: 'movie', languages: ['hr', 'en'] });
  });

  it('searches what the person typed instead, without a year that may be wrong', () => {
    const film = filmIdentity(VOD_INFO, { title: 'Ne diraj mi mamu', year: '2004' });

    expect(searchFor(film, ['hr'], 'ne diraj mi mamu 2')).toEqual({ query: 'ne diraj mi mamu 2', type: 'movie', languages: ['hr'] });
  });

  it('copes with a panel that sends nothing useful', () => {
    expect(filmIdentity(null, { title: 'Film' })).toMatchObject({ matchedBy: 'title', tmdbId: null, year: null });
    expect(filmIdentity('<html>', { title: 'Film' }).matchedBy).toBe('title');
  });
});

describe('an episode', () => {
  // As the provider sent Friends: facts under `info`, ids as text.
  const FRIENDS = {
    info: { name: 'EN - Friends - UNCUT (1994)', tmdb: '1668', releaseDate: '1994-09-22' },
    episodes: { '3': [{ id: '90811', episode_num: 2, season: 3 }] }
  };

  it('is found by the show’s TMDB id with its season and episode', () => {
    const episode = episodeIdentity(FRIENDS, { season: 3, episode: 2 }, { title: 'Friends - UNCUT', year: '1994' });

    expect(episode).toEqual({
      kind: 'episode',
      matchedBy: 'tmdb',
      parentTmdbId: 1668,
      parentImdbId: null,
      season: 3,
      episode: 2,
      title: 'Friends - UNCUT',
      originalTitle: null,
      year: 1994
    });
    expect(searchFor(episode, ['hr'])).toEqual({ parentTmdbId: 1668, season: 3, episode: 2, languages: ['hr'] });
  });

  it('reads the Express backend’s flattened shape too', () => {
    expect(episodeIdentity({ name: 'Deadwood', tmdb: 1406 }, { season: 1, episode: 1 }, { title: 'Deadwood' }).parentTmdbId).toBe(1406);
  });

  it('falls back to the show’s name with the season and episode', () => {
    const episode = episodeIdentity({ info: { tmdb: '' } }, { season: 2, episode: 5 }, { title: 'Novine' });

    expect(searchFor(episode, ['hr'])).toEqual({ query: 'Novine', type: 'episode', season: 2, episode: 5, languages: ['hr'] });
  });
});

describe('suggestions when a title finds nothing', () => {
  it('offers the name without packaging words, and the original title', () => {
    const film = filmIdentity({ info: { o_name: 'The Dead Don’t Die' } }, { title: 'Mrtvi ne umiru 4K MULTI SUB' });

    expect(titleSuggestions(film, 'Mrtvi ne umiru 4K MULTI SUB')).toEqual(['Mrtvi ne umiru', 'The Dead Don’t Die']);
  });

  it('does not offer what was just tried', () => {
    const film = filmIdentity({}, { title: 'Novine' });

    expect(titleSuggestions(film, 'novine')).toEqual([]);
  });
});

describe('remembering the answer', () => {
  const NOW = 1_800_000_000_000;
  const sub = subscriptionKey('http://provider.example', 'someone');

  it('names a subscription without its username', () => {
    expect(sub).not.toContain('someone');
    expect(subscriptionKey('http://provider.example', 'someone')).toBe(sub);
    expect(subscriptionKey('http://provider.example', 'another')).not.toBe(sub);
  });

  it('recalls a fresh answer, including "no id", and forgets a stale one', () => {
    const key = identityKey(sub, 'vod', 4512);
    let store = remember({}, key, { tmdbId: null, imdbId: null, originalTitle: null, year: 2004 }, NOW);

    expect(recall(store, key, NOW + 1000)).toMatchObject({ tmdbId: null, year: 2004 });
    expect(recall(store, key, NOW + IDENTITY_TTL_MS)).toBeNull();

    store = remember(store, key, { tmdbId: 24188, imdbId: null, originalTitle: null, year: 2004 }, NOW + 5);
    expect(recall(store, key, NOW + 10)?.tmdbId).toBe(24188);
  });

  it('keeps the newest few hundred', () => {
    let store = {};
    for (let index = 0; index <= IDENTITY_LIMIT; index++) {
      store = remember(store, identityKey(sub, 'vod', index), { tmdbId: index + 1, imdbId: null, originalTitle: null, year: null }, NOW + index);
    }

    expect(Object.keys(store)).toHaveLength(IDENTITY_LIMIT);
    expect(recall(store, identityKey(sub, 'vod', 0), NOW)).toBeNull();
    expect(recall(store, identityKey(sub, 'vod', IDENTITY_LIMIT), NOW)).not.toBeNull();
  });

  it('survives storage that is damaged or from somewhere else', () => {
    expect(readIdentityStore(null)).toEqual({});
    expect(readIdentityStore('{not json')).toEqual({});
    expect(readIdentityStore('[1,2]')).toEqual({});
    expect(readIdentityStore(JSON.stringify({ a: { tmdbId: 'x', at: 5 }, b: { tmdbId: 1 } }))).toEqual({
      a: { tmdbId: null, imdbId: null, originalTitle: null, year: null, at: 5 }
    });
  });
});
