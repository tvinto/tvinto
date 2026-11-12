import { mostOpened, retaggedOpens, withOpening } from './category-opens.utils';

describe('category opens', () => {
  it('puts the most opened first', () => {
    let raw: string | null = null;
    raw = withOpening(raw, 'a', 1);
    raw = withOpening(raw, 'b', 2);
    raw = withOpening(raw, 'b', 3);
    expect(mostOpened(raw)).toEqual(['b', 'a']);
  });

  it('breaks a tie by the one opened last', () => {
    const raw = withOpening(withOpening(null, 'a', 1), 'b', 2);
    expect(mostOpened(raw)).toEqual(['b', 'a']);
  });

  it('reads nothing from a missing or broken record', () => {
    expect(mostOpened(null)).toEqual([]);
    expect(mostOpened('not json')).toEqual([]);
    expect(mostOpened('{"a":"x"}')).toEqual([]);
  });

  it('keeps two hundred, dropping the least opened', () => {
    let raw = withOpening(null, 'kept', 0);
    raw = withOpening(raw, 'kept', 0);
    for (let i = 0; i < 205; i++) {
      raw = withOpening(raw, `c${i}`, i + 1);
    }
    const ids = mostOpened(raw);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('kept');
    expect(ids).not.toContain('c0');
  });

  it('adds up two ids renamed to one', () => {
    const raw = withOpening(withOpening(withOpening(null, 'x', 1), 'y', 5), 'z', 2);
    const moved = retaggedOpens(raw, id => (id === 'z' ? 'z' : 'xy'));
    expect(JSON.parse(moved)).toEqual({ xy: [2, 5], z: [1, 2] });
  });
});
