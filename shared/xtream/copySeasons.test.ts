import { CopyEpisodes, findEpisode, hasEpisode, mergeCopySeasons, missingFromCopies, otherCopiesIn } from './copySeasons';

interface Ep {
  id: string;
  season?: number | string | null;
  episode_num?: number | string | null;
}

/** A copy's answer: `seasons` maps a season key to its episode numbers; ids are "<copy>-<season>-<episode>". */
function copy(copyId: string, seasons: Record<string, number[]>): CopyEpisodes<Ep> {
  return {
    copyId,
    episodes: Object.fromEntries(
      Object.entries(seasons).map(([key, numbers]) => [key, numbers.map(n => ({ id: `${copyId}-${key}-${n}`, season: Number(key) || key, episode_num: n }))])
    )
  };
}

/** "season: copy/episode copy/episode", to read a merge at a glance. */
function shape(copies: CopyEpisodes<Ep>[]): string[] {
  return mergeCopySeasons(copies).map(season => `${season.key}: ${season.episodes.map(one => `${one.copyId}${one.episode.episode_num}`).join(' ')}`);
}

describe('mergeCopySeasons', () => {
  it('keeps a lone copy as it is', () => {
    expect(shape([copy('uhd', { '1': [1, 2], '2': [1, 2] })])).toEqual(['1: uhd1 uhd2', '2: uhd1 uhd2']);
  });

  it('takes a season the copy in use lacks from another copy', () => {
    const merged = mergeCopySeasons([copy('uhd', { '1': [1, 2], '2': [1] }), copy('hd', { '1': [1, 2], '2': [1], '3': [1, 2] })]);
    expect(merged.map(season => [season.key, season.copyId])).toEqual([
      ['1', 'uhd'],
      ['2', 'uhd'],
      ['3', 'hd']
    ]);
    expect(merged[2].episodes.map(one => one.episode.id)).toEqual(['hd-3-1', 'hd-3-2']);
  });

  it('takes seasons both have from the copy in use', () => {
    expect(shape([copy('uhd', { '1': [1, 2] }), copy('hd', { '1': [1, 2] })])).toEqual(['1: uhd1 uhd2']);
  });

  it('fills a gap, and episodes newer than the copy has, from another copy', () => {
    expect(shape([copy('uhd', { '3': [1, 3] }), copy('hd', { '3': [1, 2, 3, 4] })])).toEqual(['3: uhd1 hd2 uhd3 hd4']);
  });

  it('takes a season from the first copy in order that has it, and its gaps from the next', () => {
    expect(shape([copy('uhd', { '1': [1] }), copy('hd', { '3': [1, 3] }), copy('de', { '3': [1, 2, 3, 4] })])).toEqual([
      '1: uhd1',
      '3: hd1 de2 hd3 de4'
    ]);
  });

  it('adds nothing from a copy that answered with nothing', () => {
    const empty: CopyEpisodes<Ep>[] = [
      { copyId: 'none', episodes: null },
      { copyId: 'blank', episodes: {} },
      { copyId: 'hollow', episodes: { '3': [] } },
      { copyId: 'odd', episodes: { '3': null } }
    ];
    expect(shape([copy('uhd', { '1': [1] }), ...empty])).toEqual(['1: uhd1']);
    expect(shape(empty)).toEqual([]);
  });

  it('reads "01" and "Season 1" as season 1, keeping the key of the copy in use', () => {
    expect(shape([copy('uhd', { '01': [1] }), copy('hd', { 'Season 1': [1, 2] }), copy('de', { '2': [1] })])).toEqual([
      '01: uhd1 hd2',
      '2: de1'
    ]);
  });

  it('does not mix a copy that numbers a season differently', () => {
    // The HD copy counts season 2 on from season 1 (11, 12...); the 4K one starts again at 1.
    expect(shape([copy('uhd', { '2': [1, 2, 3] }), copy('hd', { '2': [11, 12, 13, 14] })])).toEqual(['2: uhd1 uhd2 uhd3']);
  });

  it('keeps episodes with no number from their own copy only', () => {
    const own: CopyEpisodes<Ep> = { copyId: 'uhd', episodes: { '1': [{ id: 'a', episode_num: 1 }, { id: 'b', episode_num: null }] } };
    const other: CopyEpisodes<Ep> = { copyId: 'hd', episodes: { '1': [{ id: 'c', episode_num: 1 }, { id: 'd', episode_num: '' }] } };
    expect(mergeCopySeasons([own, other])[0].episodes.map(one => one.episode.id)).toEqual(['a', 'b']);
  });

  it('puts seasons in number order, any without a number last', () => {
    expect(mergeCopySeasons([copy('uhd', { Specials: [1], '10': [1], '2': [1] })]).map(season => season.key)).toEqual(['2', '10', 'Specials']);
  });
});

describe('finding an episode across copies', () => {
  const merged = mergeCopySeasons([copy('uhd', { '1': [1, 2], '2': [1] }), copy('hd', { '3': [1, 2] })]);

  it('says which copy has it', () => {
    expect(findEpisode(merged, 3, 2)?.copyId).toBe('hd');
    expect(findEpisode(merged, 1, 2)?.copyId).toBe('uhd');
    expect(hasEpisode(merged, 3, 6)).toBe(false);
    expect(hasEpisode(merged, 4, 1)).toBe(false);
  });
});

describe('otherCopiesIn', () => {
  it('names the copies a season plays from besides the one in use', () => {
    const [one, three] = mergeCopySeasons([copy('uhd', { '1': [1, 3] }), copy('hd', { '1': [1, 2], '3': [1, 2] }), copy('de', { '3': [1, 2, 3] })]);
    expect(otherCopiesIn(one, 'uhd')).toEqual([{ copyId: 'hd', season: false, episodes: [2] }]);
    // Season 3 is the HD copy's, with its gap from the German one.
    expect(otherCopiesIn(three, 'uhd')).toEqual([
      { copyId: 'hd', season: true, episodes: [1, 2] },
      { copyId: 'de', season: false, episodes: [3] }
    ]);
    expect(otherCopiesIn(three, 'hd')).toEqual([{ copyId: 'de', season: false, episodes: [3] }]);
    expect(otherCopiesIn(null, 'uhd')).toEqual([]);
  });
});

describe('missingFromCopies', () => {
  const merged = mergeCopySeasons([copy('uhd', { '1': [1], '2': [1] })]);

  it('names the aired seasons and the newest episode no copy has', () => {
    expect(missingFromCopies(merged, { seasons: 3, latest: { season: 3, episode: 6 } })).toEqual({ seasons: [3], episode: { season: 3, episode: 6 } });
  });

  it('does not count a season that has not started', () => {
    expect(missingFromCopies(merged, { seasons: 3, latest: { season: 2, episode: 1 } })).toEqual({ seasons: [], episode: null });
  });

  it('is satisfied once another copy has them', () => {
    const all = mergeCopySeasons([copy('uhd', { '1': [1], '2': [1] }), copy('hd', { '3': [1, 2, 3, 4, 5, 6] })]);
    expect(missingFromCopies(all, { seasons: 3, latest: { season: 3, episode: 6 } })).toEqual({ seasons: [], episode: null });
  });
});
