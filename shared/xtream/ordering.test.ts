import { Category, Stream } from '../types';
import {
  applyManualOrder,
  categoryScope,
  compareNames,
  readSortChoice,
  sortToUse,
  sortCategories,
  sortStreams,
  streamScope
} from './ordering';

const category = (id: string, name: string): Category => ({
  category_id: id,
  category_name: name,
  parent_id: '0'
});

const stream = (id: string, name: string, extra: Record<string, unknown> = {}): Stream =>
  ({ stream_id: id, name, icon: '', ...extra }) as unknown as Stream;

const names = (items: Array<{ name: string }>): string[] => items.map(i => i.name);
const ids = (items: Array<{ stream_id: string }>): string[] => items.map(i => i.stream_id);

describe('scope keys', () => {
  // These strings are how an arrangement is found again. A change here would
  // not fail anything -- it would silently orphan every arrangement already
  // saved, and the lists would quietly go back to alphabetical.
  it('names a category arrangement by its stream type', () => {
    expect(categoryScope('live')).toBe('category:live');
    expect(categoryScope('series')).toBe('category:series');
  });

  it('names a stream arrangement by type and category', () => {
    expect(streamScope('vod', '42')).toBe('stream:vod:42');
  });
});

describe('compareNames', () => {
  it('puts "Channel 2" before "Channel 10"', () => {
    expect(compareNames('Channel 2', 'Channel 10')).toBeLessThan(0);
  });

  it('ignores case', () => {
    expect(compareNames('bbc one', 'BBC One')).toBe(0);
  });

  it('treats a missing name as empty rather than throwing', () => {
    expect(compareNames(undefined, 'A')).toBeLessThan(0);
    expect(compareNames(null, null)).toBe(0);
  });
});

describe('sortCategories', () => {
  const unsorted = [category('1', 'Sport'), category('2', 'Documentary'), category('3', 'News')];

  it('orders by name ascending by default', () => {
    expect(sortCategories(unsorted, 'name_asc').map(c => c.category_name)).toEqual([
      'Documentary',
      'News',
      'Sport'
    ]);
  });

  it('orders by name descending', () => {
    expect(sortCategories(unsorted, 'name_desc').map(c => c.category_name)).toEqual([
      'Sport',
      'News',
      'Documentary'
    ]);
  });

  it('follows a saved arrangement', () => {
    const arranged = sortCategories(unsorted, 'manual', ['3', '1', '2']);
    expect(arranged.map(c => c.category_id)).toEqual(['3', '1', '2']);
  });

  it('leaves the input array alone', () => {
    const original = [...unsorted];
    sortCategories(unsorted, 'name_desc');
    expect(unsorted).toEqual(original);
  });

  it('falls back to the provider order when a manual sort has no arrangement', () => {
    // Not name order: an arrangement that has not been made yet is different
    // from one that has been emptied, and reordering here would look like the
    // list rearranged itself.
    expect(sortCategories(unsorted, 'manual', []).map(c => c.category_id)).toEqual(['1', '2', '3']);
  });
});

describe('sortStreams', () => {
  it('sinks channels with no number to the bottom, in name order', () => {
    const streams = [
      stream('a', 'Zeta'),
      stream('b', 'Two', { num: 2 }),
      stream('c', 'Alpha'),
      stream('d', 'Ten', { num: 10 })
    ];

    expect(names(sortStreams(streams, 'number'))).toEqual(['Two', 'Ten', 'Alpha', 'Zeta']);
  });

  it('reads a channel number that arrived as a string', () => {
    // Xtream sends numbers as strings often enough that comparing them as
    // strings would put channel 10 before channel 2.
    const streams = [stream('a', 'Ten', { num: '10' }), stream('b', 'Two', { num: '2' })];
    expect(names(sortStreams(streams, 'number'))).toEqual(['Two', 'Ten']);
  });

  it('orders by when the provider added them', () => {
    const streams = [
      stream('old', 'Old', { added: '1000' }),
      stream('new', 'New', { added: '3000' }),
      stream('mid', 'Mid', { added: '2000' })
    ];

    expect(ids(sortStreams(streams, 'added_desc'))).toEqual(['new', 'mid', 'old']);
    expect(ids(sortStreams(streams, 'added_asc'))).toEqual(['old', 'mid', 'new']);
  });

  it('treats an unparseable added date as the beginning of time', () => {
    const streams = [stream('a', 'A', { added: 'yesterday' }), stream('b', 'B', { added: '500' })];
    expect(ids(sortStreams(streams, 'added_desc'))).toEqual(['b', 'a']);
  });

  it('falls back to name order for a manual sort with nothing arranged', () => {
    // Unlike categories: this is the favourites and search case, where there is
    // no arrangement to have and alphabetical is the sensible answer.
    const streams = [stream('a', 'Zeta'), stream('b', 'Alpha')];
    expect(names(sortStreams(streams, 'manual', []))).toEqual(['Alpha', 'Zeta']);
  });

  it('follows a saved arrangement', () => {
    const streams = [stream('1', 'One'), stream('2', 'Two'), stream('3', 'Three')];
    expect(ids(sortStreams(streams, 'manual', ['3', '1', '2']))).toEqual(['3', '1', '2']);
  });
});

describe('applyManualOrder', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const idOf = (item: { id: string }) => item.id;

  it('puts items the user never placed after the ones they did', () => {
    // The case a later sync creates: new channels appear, and dropping them
    // would make an arrangement quietly hide everything added since.
    const ordered = applyManualOrder(items, ['c'], idOf);
    expect(ordered.map(idOf)).toEqual(['c', 'a', 'b']);
  });

  it('keeps unplaced items in the order they arrived', () => {
    const ordered = applyManualOrder([{ id: 'z' }, { id: 'y' }, { id: 'm' }], ['m'], idOf);
    expect(ordered.map(idOf)).toEqual(['m', 'z', 'y']);
  });

  it('ignores arranged ids that no longer exist', () => {
    // A favourite outlives the row it points at; so does an arrangement.
    const ordered = applyManualOrder(items, ['gone', 'b', 'also-gone', 'a'], idOf);
    expect(ordered.map(idOf)).toEqual(['b', 'a', 'c']);
  });

  it('returns the items untouched when nothing is arranged', () => {
    expect(applyManualOrder(items, [], idOf)).toBe(items);
  });
});

describe('sortToUse', () => {
  const arranged = '2026-10-08T18:00:00.000Z';

  it('follows the arrangement on a device that never chose a sort', () => {
    // A family member's television, arranged from the admin's desktop.
    expect(sortToUse({ sort: null, at: null }, arranged, 'name_asc')).toBe('manual');
  });

  it('follows the arrangement made after the device chose a sort', () => {
    expect(sortToUse({ sort: 'name_asc', at: '2026-10-08T17:00:00.000Z' }, arranged, 'name_asc')).toBe('manual');
  });

  it('keeps a sort chosen after the list was last arranged', () => {
    expect(sortToUse({ sort: 'number', at: '2026-10-08T19:00:00.000Z' }, arranged, 'name_asc')).toBe('number');
  });

  it('keeps a sort chosen before choices were timed, rather than moving a settled device', () => {
    expect(sortToUse({ sort: 'number', at: null }, arranged, 'name_asc')).toBe('number');
  });

  it('uses the choice, or the fallback, when nothing is arranged', () => {
    expect(sortToUse({ sort: 'name_desc', at: null }, null, 'name_asc')).toBe('name_desc');
    expect(sortToUse({ sort: null, at: null }, null, 'name_asc')).toBe('name_asc');
  });

  describe('with a sort chosen in their setup', () => {
    const setUp = { sort: 'number' as const, at: '2026-10-09T10:00:00.000Z' };

    it('reaches a device that never chose one', () => {
      // 9 October: "Channel number" picked for a member, their television sorting by name.
      expect(sortToUse({ sort: null, at: null }, null, 'name_asc', setUp)).toBe('number');
    });

    it('wins over an arrangement made before it', () => {
      expect(sortToUse({ sort: null, at: null }, arranged, 'name_asc', setUp)).toBe('number');
    });

    it('gives way to an arrangement made after it', () => {
      expect(sortToUse({ sort: null, at: null }, '2026-10-09T11:00:00.000Z', 'name_asc', setUp)).toBe('manual');
    });

    it('gives way to a sort the device chose after it', () => {
      expect(sortToUse({ sort: 'name_desc', at: '2026-10-09T12:00:00.000Z' }, null, 'name_asc', setUp)).toBe('name_desc');
    });

    it('moves a device whose own choice is older', () => {
      expect(sortToUse({ sort: 'name_desc', at: '2026-10-09T09:00:00.000Z' }, null, 'name_asc', setUp)).toBe('number');
    });
  });
});

describe('readSortChoice', () => {
  const sorts = ['name_asc', 'number'] as const;

  it('reads a kept choice', () => {
    expect(readSortChoice('{"sort":"number","at":"2026-10-09T10:00:00.000Z"}', sorts)).toEqual({
      sort: 'number',
      at: '2026-10-09T10:00:00.000Z'
    });
  });

  it('is no choice when missing, unknown or unreadable', () => {
    for (const text of [null, '{"sort":"sideways","at":"2026-10-09T10:00:00.000Z"}', '{"sort":"number"}', 'not json']) {
      expect(readSortChoice(text, sorts)).toEqual({ sort: null, at: null });
    }
  });
});
