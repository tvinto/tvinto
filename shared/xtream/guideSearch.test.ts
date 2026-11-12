import { foldText, likePattern, titleMatches } from './guideSearch';
import { MemoryGuideStore } from './memoryGuideStore';

describe('finding a programme by its title', () => {
  it('ignores case and accents, and the Croatian đ', () => {
    expect(titleMatches('Dnevnik HRT', 'dnevnik')).toBe(true);
    expect(titleMatches('Šport', 'sport')).toBe(true);
    expect(titleMatches('Đir po Hrvatskoj', 'dir po')).toBe(true);
    expect(titleMatches('Sport', 'šport')).toBe(true);
  });

  it('needs three letters, since two match half the guide', () => {
    expect(titleMatches('Dnevnik', 'dn')).toBe(false);
  });

  it('folds spaces too', () => {
    expect(foldText('  Liga   Prvaka ')).toBe('liga prvaka');
  });

  it('gives SQLite a pattern that lets every such title through', () => {
    const pattern = likePattern('šport');
    // What SQLite's LIKE does, for ASCII: case-blind, _ is one character.
    const like = (title: string): boolean =>
      new RegExp(
        '^' +
          pattern
            .replace(/[.*+?^${}()|[\]]/g, '\\$&')
            .replace(/%/g, '.*')
            .replace(/_/g, '.') +
          '$',
        'is'
      ).test(title);
    expect(like('Šport uživo')).toBe(true);
    expect(like('Sport')).toBe(true);
    expect(like('Vijesti')).toBe(false);
  });

  it('keeps a literal percent or underscore literal', () => {
    expect(likePattern('100%')).toBe('%100\\%%');
  });
});

describe('searching a guide held in memory', () => {
  it('finds titles across sources, soonest first, within the window and the limit', async () => {
    const store = new MemoryGuideStore();
    const hour = 3_600_000;
    const programme = (channel: string, start: number, title: string) => ({
      channel,
      start,
      stop: start + hour,
      title,
      description: '',
      category: ''
    });
    await store.beginLoad('a');
    await store.writeProgrammes('a', [programme('hrt1.hr', 2 * hour, 'Dnevnik'), programme('hrt1.hr', 9 * hour, 'Dnevnik 3')]);
    await store.finishLoad('a', 'now');
    await store.beginLoad('b');
    await store.writeProgrammes('b', [programme('rtl.hr', 1 * hour, 'RTL Danas'), programme('n1.hr', 3 * hour, 'Dnevnik N1')]);
    await store.finishLoad('b', 'now');

    const found = await store.searchProgrammes('dnevnik', 0, 8 * hour, 10);
    expect(found.map(hit => [hit.sourceId, hit.title])).toEqual([
      ['a', 'Dnevnik'],
      ['b', 'Dnevnik N1']
    ]);
    expect(await store.searchProgrammes('dnevnik', 0, 24 * hour, 1)).toHaveLength(1);
  });
});
