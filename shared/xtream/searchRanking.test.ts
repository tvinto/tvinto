import { Stream } from '../types';
import { byCloseness, matchRank } from './searchRanking';

/**
 * Closeness, against the names this provider actually uses. The list below is
 * what "x-men" returned on the real account, trimmed to the interesting ones.
 */

const film = (name: string): Stream => ({ stream_id: name, name }) as unknown as Stream;

const names = (results: Stream[]): string[] => results.map(result => result.name ?? '');

describe('how closely a name answers what was typed', () => {
  it('puts the film itself first, whatever packaging its name carries', () => {
    expect(matchRank('EN - X-Men 4K', 'x-men').rank).toBe(0);
    expect(matchRank('X-Men (2000)', 'x-men').rank).toBe(0);
    expect(matchRank('X-Men 2000', 'x-men').rank).toBe(0);
    expect(matchRank('|EN| X-MEN ᴴᴰ', 'x-men').rank).toBe(0);
  });

  it('keeps a sequel number, which is part of the film and not packaging', () => {
    expect(matchRank('X-Men 2', 'x-men').rank).toBe(1);
    expect(matchRank('X-Men: Apocalypse', 'x-men').rank).toBe(1);
  });

  it('treats a word somebody has not finished typing as that word', () => {
    expect(matchRank('EN - X-Men: Apocalypse (2016)', 'x-men apoca').rank).toBe(0);
    expect(matchRank('EN - X-Men (2000)', 'x-men apoca').rank).toBe(3);
  });

  it('ranks a title that merely contains the words below one that starts with them', () => {
    expect(matchRank('The X-Men Story', 'x-men').rank).toBe(2);
    expect(matchRank('Men of X', 'x men').rank).toBe(3);
  });

  it('orders a real set of results the way somebody reads them', () => {
    const results = [
      film('EN - X-Men: Apocalypse (2016)'),
      film('EN - X-Men 4K'),
      film('EN - X-Men Origins: Wolverine (2009)'),
      film('EN - X-Men 2'),
      film('EN - X-Men (2000)'),
      film('EN - Deadpool 2 4K')
    ];

    expect(names(byCloseness(results, 'x-men'))).toEqual([
      // The film, twice, since two categories carry it.
      'EN - X-Men (2000)',
      'EN - X-Men 4K',
      // Then what carries straight on, fewest extra words first.
      'EN - X-Men 2',
      'EN - X-Men: Apocalypse (2016)',
      'EN - X-Men Origins: Wolverine (2009)',
      // Then what only matched because search is looser than this sort.
      'EN - Deadpool 2 4K'
    ]);
  });

  it('is the same order every time, so a repeated search does not shuffle', () => {
    const results = [film('X-Men: Apocalypse'), film('X-Men: First Class'), film('X-Men: Dark Phoenix')];

    expect(names(byCloseness(results, 'x-men'))).toEqual(names(byCloseness([...results].reverse(), 'x-men')));
  });

  it('leaves the list alone rather than inventing an order for a query of noise', () => {
    const results = [film('B 4K'), film('A 4K')];

    // "4k" says nothing about which film this is, so nothing is closer than
    // anything else and the names decide.
    expect(names(byCloseness(results, '4k'))).toEqual(['A 4K', 'B 4K']);
  });

  it('does not reorder the caller’s list', () => {
    const results = [film('X-Men: Apocalypse'), film('X-Men')];
    byCloseness(results, 'x-men');

    expect(names(results)).toEqual(['X-Men: Apocalypse', 'X-Men']);
  });
});
