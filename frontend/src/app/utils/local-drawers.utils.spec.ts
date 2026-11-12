import { broughtKey, holdsWork, moveDrawers, takeBrought } from './local-drawers.utils';

/** A Storage over a map, as the tests of the vault use. */
const storage = (entries: Record<string, string> = {}): Storage => {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear()
  };
};

const work = JSON.stringify({ favourites: { 'live:1': {} }, pending: {} });
const shell = JSON.stringify({ favourites: {}, progress: {}, pending: { favourites: [{}] } });

describe('holdsWork', () => {
  it('counts what somebody did, not a queue in an empty drawer', () => {
    expect(holdsWork(work)).toBe(true);
    expect(holdsWork(shell)).toBe(false);
    expect(holdsWork('[]')).toBe(false);
    expect(holdsWork(null)).toBe(false);
  });
});

describe('moveDrawers', () => {
  it("moves the device's drawers to the account's name", () => {
    const store = storage({ 'xtream_local_data:~local': work, 'xtream_reminders:~local': '[{"streamId":"1"}]' });

    expect(moveDrawers(store, '~local', 'ana')).toEqual([]);

    expect(store.getItem('xtream_local_data:ana')).toBe(work);
    expect(store.getItem('xtream_reminders:ana')).toBe('[{"streamId":"1"}]');
    expect(store.getItem('xtream_local_data:~local')).toBeNull();
  });

  it('leaves it beside an account that already has its own here, for its owner to merge', () => {
    const theirs = JSON.stringify({ favourites: { 'live:2': {} } });
    const store = storage({ 'xtream_local_data:~local': work, 'xtream_local_data:ana': theirs });

    expect(moveDrawers(store, '~local', 'ana')).toEqual(['xtream_local_data']);

    expect(store.getItem('xtream_local_data:ana')).toBe(theirs);
    expect(takeBrought(store, 'xtream_local_data', 'ana')).toBe(work);
    expect(store.getItem(broughtKey('xtream_local_data', 'ana'))).toBeNull();
  });

  it("takes the place of an empty drawer under the account's name", () => {
    const store = storage({ 'xtream_local_data:~local': work, 'xtream_local_data:ana': shell });

    moveDrawers(store, '~local', 'ana');

    expect(store.getItem('xtream_local_data:ana')).toBe(work);
  });

  it('throws an empty device drawer away rather than moving it', () => {
    const store = storage({ 'xtream_local_data:~local': shell });

    moveDrawers(store, '~local', 'ana');

    expect(store.getItem('xtream_local_data:ana')).toBeNull();
    expect(store.getItem('xtream_local_data:~local')).toBeNull();
  });
});
