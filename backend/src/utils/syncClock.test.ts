import { observeTime, resetSyncClock, syncNow } from './syncClock';

beforeEach(() => {
  resetSyncClock();
});

describe('syncNow', () => {
  it('never returns the same moment twice, however fast it is called', () => {
    // The failure this exists to prevent: two of these being equal means a
    // change stamped with one is invisible to a cursor holding the other.
    const stamps = Array.from({ length: 500 }, () => syncNow());

    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it('always moves forward', () => {
    const stamps = Array.from({ length: 100 }, () => syncNow());
    const sorted = [...stamps].sort();

    expect(stamps).toEqual(sorted);
  });

  it('stays a valid ISO timestamp', () => {
    expect(syncNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('stays close to real time, since it is also what "5 minutes ago" is read from', () => {
    for (let i = 0; i < 200; i++) {
      syncNow();
    }

    // 200 calls can push it at most 200ms ahead, and only if they all landed
    // inside the same millisecond.
    expect(Math.abs(Date.parse(syncNow()) - Date.now())).toBeLessThan(1000);
  });
});

describe('observeTime', () => {
  it('will not issue a time already used before a restart', () => {
    const future = new Date(Date.now() + 60_000).toISOString();

    observeTime(future);

    expect(Date.parse(syncNow())).toBeGreaterThan(Date.parse(future));
  });

  it('ignores a time that has already passed', () => {
    const before = syncNow();

    observeTime(new Date(Date.now() - 60_000).toISOString());

    expect(Date.parse(syncNow())).toBeGreaterThan(Date.parse(before));
  });

  it('shrugs off nothing and nonsense, since it reads whatever is in the table', () => {
    expect(() => {
      observeTime(null);
      observeTime(undefined);
      observeTime('');
      observeTime('not a timestamp');
    }).not.toThrow();

    expect(syncNow()).toMatch(/^\d{4}-/);
  });
});
