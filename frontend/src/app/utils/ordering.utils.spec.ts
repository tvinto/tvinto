import { moveToIndex, moveWithinFilteredList, toTargetIndex } from './ordering.utils';

/** Positions of the rows a filter left visible. */
const visible = (...positions: number[]) => positions.map(index => ({ index }));

describe('moveWithinFilteredList', () => {
  const unfiltered = ['a', 'b', 'c', 'd'];
  const allVisible = visible(0, 1, 2, 3);

  it('steps a row down one place when nothing is filtered', () => {
    expect(moveWithinFilteredList(unfiltered, allVisible, 1, 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('steps a row up one place when nothing is filtered', () => {
    expect(moveWithinFilteredList(unfiltered, allVisible, 2, -1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('steps onto the next visible row, not the next hidden one', () => {
    // Only a and d match the filter, so pressing down on a lands it past d
    // rather than nudging it into b, which would look like nothing happened.
    const result = moveWithinFilteredList(unfiltered, visible(0, 3), 0, 1);
    expect(result).toEqual(['b', 'c', 'd', 'a']);
  });

  it('relocates only the row that was moved', () => {
    // The regression: swapping sent the neighbour back across every hidden row.
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const result = moveWithinFilteredList(items, visible(1, 18), 1, 1);

    expect(result[18]).toBe('item-1');
    // item-18 shifts by one, not eighteen.
    expect(result.indexOf('item-18')).toBe(17);
  });

  it('shifts the rows in between by exactly one', () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const result = moveWithinFilteredList(items, visible(1, 18), 1, 1);

    for (let i = 2; i <= 18; i++) {
      expect(result.indexOf(`item-${i}`)).toBe(i - 1);
    }
  });

  it('leaves the list alone at either end', () => {
    expect(moveWithinFilteredList(unfiltered, allVisible, 0, -1)).toEqual(unfiltered);
    expect(moveWithinFilteredList(unfiltered, allVisible, 3, 1)).toEqual(unfiltered);
  });

  it('leaves the list alone for a row that is not visible', () => {
    expect(moveWithinFilteredList(unfiltered, visible(0, 3), 2, 1)).toEqual(unfiltered);
  });

  it('does not mutate the array it is given', () => {
    const items = ['a', 'b', 'c'];
    moveWithinFilteredList(items, visible(0, 1, 2), 0, 1);
    expect(items).toEqual(['a', 'b', 'c']);
  });
});

describe('toTargetIndex', () => {
  it('reads a typed position as the index one lower', () => {
    // Positions are shown starting at 1.
    expect(toTargetIndex('1', 828)).toBe(0);
    expect(toTargetIndex('440', 828)).toBe(439);
    expect(toTargetIndex('828', 828)).toBe(827);
  });

  it('clamps a number past either end', () => {
    // Typing 1 to mean "top" and 9999 to mean "bottom" are both clear enough.
    expect(toTargetIndex('0', 828)).toBe(0);
    expect(toTargetIndex('-5', 828)).toBe(0);
    expect(toTargetIndex('9999', 828)).toBe(827);
  });

  it('ignores surrounding whitespace', () => {
    expect(toTargetIndex('  7  ', 828)).toBe(6);
  });

  it('refuses anything that is not a whole number', () => {
    expect(toTargetIndex('', 828)).toBeNull();
    expect(toTargetIndex('   ', 828)).toBeNull();
    expect(toTargetIndex('abc', 828)).toBeNull();
    expect(toTargetIndex('3.5', 828)).toBeNull();
    expect(toTargetIndex('1e3', 828)).toBe(827);
  });

  it('refuses any position for an empty list', () => {
    expect(toTargetIndex('1', 0)).toBeNull();
  });
});

describe('typing a position then moving', () => {
  it('puts a filtered row at the top and shifts everything down one', () => {
    // The case the arrows could not reach: a match at position 440 of 828
    // would have needed hundreds of presses to get to the front.
    const items = Array.from({ length: 828 }, (_, i) => `item-${i}`);
    const target = toTargetIndex('1', items.length)!;
    const result = moveToIndex(items, 439, target);

    expect(result[0]).toBe('item-439');
    expect(result[1]).toBe('item-0');
    expect(result[440]).toBe('item-440');
    expect(result).toHaveLength(828);
  });

  it('keeps every entry when a row is moved a long way', () => {
    const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const result = moveToIndex(items, 49, toTargetIndex('1', items.length)!);

    expect(new Set(result).size).toBe(50);
    expect(result[0]).toBe('item-49');
  });
});

describe('applying a move twice', () => {
  // Why the commit must run once per edit. Both handlers firing in the same
  // turn re-ran this with the index and typed position the first pass had
  // already made stale, which landed the row one place off -- the "+1" that
  // showed up when typing a position and pressing Enter.
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('lands the row one place late when moving it up', () => {
    const from = 5;
    const target = toTargetIndex('2', items.length)!;

    const once = moveToIndex(items, from, target);
    expect(once.indexOf('f')).toBe(1);

    const twice = moveToIndex(once, from, target);
    expect(twice.indexOf('f')).toBe(2);
  });

  it('lands the row one place early when moving it down', () => {
    const from = 0;
    const target = toTargetIndex('3', items.length)!;

    const once = moveToIndex(items, from, target);
    expect(once.indexOf('a')).toBe(2);

    const twice = moveToIndex(once, from, target);
    expect(twice.indexOf('a')).toBe(1);
  });

  it('is a no-op the second time once the index and position have caught up', () => {
    // What a later blur sees: the row's real index, and a field showing it.
    const moved = moveToIndex(items, 5, toTargetIndex('2', items.length)!);
    const settledIndex = moved.indexOf('f');
    const target = toTargetIndex(String(settledIndex + 1), moved.length)!;

    expect(target).toBe(settledIndex);
    expect(moveToIndex(moved, settledIndex, target)).toEqual(moved);
  });
});

describe('moveToIndex', () => {
  it('moves a row to the position given', () => {
    expect(moveToIndex(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveToIndex(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('leaves the list alone for a no-op or an out-of-range index', () => {
    const items = ['a', 'b', 'c'];
    expect(moveToIndex(items, 1, 1)).toEqual(items);
    expect(moveToIndex(items, -1, 1)).toEqual(items);
    expect(moveToIndex(items, 1, 9)).toEqual(items);
  });

  it('does not mutate the array it is given', () => {
    const items = ['a', 'b', 'c'];
    moveToIndex(items, 0, 2);
    expect(items).toEqual(['a', 'b', 'c']);
  });
});
