import { bySeason, episodePresentation, episodesAfter, filmPresentation, nextInSeason } from './film-presentation.utils';

describe('the episode after this one', () => {
  const show = [
    { id: '11', season: 1, episode_num: 1 },
    { id: '12', season: 1, episode_num: 2 },
    { id: '13', season: 1, episode_num: 3 },
    { id: '21', season: 2, episode_num: 1 }
  ];

  it('is the next one in the same season', () => {
    expect(nextInSeason(show, '12')).toEqual({ next: show[2] });
  });

  // PL-TV-6b: after a season's last episode nothing starts by itself.
  it('stops at the end of a season rather than starting the next', () => {
    expect(nextInSeason(show, '13')).toEqual({ endOfSeason: 1 });
    expect(nextInSeason(show, '21')).toEqual({ endOfSeason: 2 });
  });

  it('knows nothing about an episode it was not given', () => {
    expect(nextInSeason(show, '99')).toBeNull();
  });
});

describe('the episodes handed to the player in advance', () => {
  const season = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ id: String(n), season: 1, episode_num: n }));

  it('gives up to the limit, and cannot yet say where the season ends', () => {
    const after = episodesAfter(season, '1', 5);

    expect(after.next.map(one => one.id)).toEqual(['2', '3', '4', '5', '6']);
    expect(after.endOfSeason).toBeUndefined();
  });

  it('says the season ends when the list reaches its end', () => {
    const after = episodesAfter(season, '5', 5);

    expect(after.next.map(one => one.id)).toEqual(['6', '7', '8']);
    expect(after.endOfSeason).toBe(1);
  });

  it('says so exactly when the limit lands on the last episode', () => {
    expect(episodesAfter(season, '3', 5).endOfSeason).toBe(1);
  });

  it('has nothing after the last episode but the end of the season', () => {
    expect(episodesAfter(season, '8', 5)).toEqual({ next: [], endOfSeason: 1 });
  });
});

describe('what the player says about a film', () => {
  it('names a film as the library does, with its year apart', () => {
    const said = filmPresentation('EN - Dune: Part Two (2024)', 'http://images.example/dune.jpg');

    expect(said.kind).toBe('film');
    expect(said.title).toBe('Dune: Part Two');
    expect(said.meta).toBe('2024');
    expect(said.poster).toBe('http://images.example/dune.jpg');
  });

  it('names a film as its page does: no prefix, no copy words, nothing after the year', () => {
    expect(filmPresentation('EN - X-Men: First Class 4K (2011) X-Men 05').title).toBe('X-Men: First Class');
    expect(filmPresentation('EN - Spare Copy 1080p (2020)').title).toBe('Spare Copy');
    expect(filmPresentation('[4K] Dune (2021)').title).toBe('Dune');
  });

  it('keeps a name with no year whole, and says nothing about a year', () => {
    const said = filmPresentation('The Last House 4K');

    expect(said.title).toBeTruthy();
    expect(said.meta).toBeUndefined();
    expect(said.poster).toBeNull();
  });

  it('puts the show above an episode, and its number and title as the title', () => {
    const said = episodePresentation('EN - The Last of Us (2023)', 'S1 E3', 'Long, Long Time');

    expect(said.kind).toBe('episode');
    expect(said.heading).toBe('The Last of Us');
    expect(said.title).toBe('S1 E3 · Long, Long Time');
  });
});

describe('the show by season, for the player’s Episodes', () => {
  it('splits where the season changes, keeping the playing order', () => {
    const show = [
      { id: '11', season: 1, episode_num: 1 },
      { id: '12', season: 1, episode_num: 2 },
      { id: '21', season: 2, episode_num: 1 }
    ];

    expect(bySeason(show)).toEqual([
      { season: 1, episodes: [show[0], show[1]] },
      { season: 2, episodes: [show[2]] }
    ]);
  });

  it('puts a show with no seasons in one', () => {
    const show = [
      { id: '1', season: null, episode_num: 1 },
      { id: '2', season: null, episode_num: 2 }
    ];

    expect(bySeason(show)).toEqual([{ season: null, episodes: show }]);
  });
});
