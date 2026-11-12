import { Category } from '@shared/types';
import {
  DEFAULT_IDLE_MINUTES,
  categoriesShown,
  countOf,
  hashPin,
  lockIsDue,
  newSalt,
  noCategories,
  pinIsWellFormed,
  readCategorySets,
  readLockSettings,
  withCategory,
  writeCategorySets
} from './category-lock.utils';

const category = (id: string, name = `C${id}`): Category =>
  ({ category_id: id, category_name: name, parent_id: 0 }) as unknown as Category;

describe('readCategorySets', () => {
  it('reads what was written', () => {
    const sets = withCategory(withCategory(noCategories(), 'live', '12', true), 'series', '7', true);
    expect(readCategorySets(writeCategorySets(sets))).toEqual({ live: ['12'], vod: [], series: ['7'] });
  });

  it('reads nothing chosen from something broken or missing', () => {
    expect(readCategorySets(null)).toEqual(noCategories());
    expect(readCategorySets('not json')).toEqual(noCategories());
    expect(readCategorySets('{"live":"12"}')).toEqual(noCategories());
  });

  it('keeps ids as text, once each', () => {
    expect(readCategorySets('{"vod":[3,"3",4]}').vod).toEqual(['3', '4']);
  });
});

describe('withCategory', () => {
  it('adds once and takes out', () => {
    let sets = withCategory(noCategories(), 'vod', '5', true);
    sets = withCategory(sets, 'vod', '5', true);
    expect(sets.vod).toEqual(['5']);
    expect(withCategory(sets, 'vod', '5', false).vod).toEqual([]);
    expect(countOf(withCategory(sets, 'live', '1', true))).toBe(2);
  });
});

describe('categoriesShown', () => {
  const all = [category('1'), category('2'), category('3')];

  it('leaves out hidden ones always, locked ones only while locked', () => {
    expect(categoriesShown(all, ['1'], ['3'], true).map(c => c.category_id)).toEqual(['2']);
    expect(categoriesShown(all, ['1'], ['3'], false).map(c => c.category_id)).toEqual(['2', '3']);
  });

  it('hands back the same list when nothing is left out', () => {
    expect(categoriesShown(all, [], ['3'], false)).toBe(all);
  });

  it('matches a numeric id from the provider against a stored text one', () => {
    const numeric = [{ ...category('9'), category_id: 9 as unknown as string }];
    expect(categoriesShown(numeric, ['9'], [], false)).toEqual([]);
  });
});

describe('the PIN', () => {
  it('takes four digits and nothing else', () => {
    expect(pinIsWellFormed('0420')).toBe(true);
    expect(pinIsWellFormed('042')).toBe(false);
    expect(pinIsWellFormed('04a0')).toBe(false);
    expect(pinIsWellFormed('04200')).toBe(false);
  });

  it('hashes the same PIN the same way under one salt, and differently under another', async () => {
    const salt = newSalt();
    const first = await hashPin('1234', salt);
    expect(first).toBe(await hashPin('1234', salt));
    expect(first).not.toBe(await hashPin('1235', salt));
    expect(first).not.toBe(await hashPin('1234', newSalt()));
    expect(first).not.toContain('1234');
  });

  it('reads stored settings, and nothing from a broken one', () => {
    expect(readLockSettings('{"salt":"s","hash":"h","idleMinutes":5}')).toEqual({ salt: 's', hash: 'h', idleMinutes: 5 });
    expect(readLockSettings('{"salt":"s","hash":"h"}')?.idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
    expect(readLockSettings('{"salt":"s","hash":""}')).toBeNull();
    expect(readLockSettings('nope')).toBeNull();
    expect(readLockSettings(null)).toBeNull();
  });
});

describe('lockIsDue', () => {
  const base = { unlocked: true, playing: false, idleMinutes: 15, lastActivityMs: 0, nowMs: 15 * 60_000 };

  it('locks once the idle time has passed untouched', () => {
    expect(lockIsDue(base)).toBe(true);
    expect(lockIsDue({ ...base, nowMs: 14 * 60_000 })).toBe(false);
  });

  it('never while something plays, when already locked, or when set to lock only on restart', () => {
    expect(lockIsDue({ ...base, playing: true })).toBe(false);
    expect(lockIsDue({ ...base, unlocked: false })).toBe(false);
    expect(lockIsDue({ ...base, idleMinutes: 0, nowMs: 10 ** 9 })).toBe(false);
  });
});
