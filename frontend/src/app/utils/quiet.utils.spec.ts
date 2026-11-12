import { QuietOptions, whenQuiet } from './quiet.utils';

/**
 * Waiting for a quiet moment before the daily library refresh: not before a
 * minute has passed, not while somebody is pressing keys, never after the
 * screen has gone.
 */
describe('whenQuiet', () => {
  /** A clock that moves on each wait, with presses at the given times. */
  const run = (presses: number[], stopAt = Infinity) => {
    let now = 0;
    const options: QuietOptions = {
      afterStartMs: 60_000,
      idleMs: 15_000,
      checkEveryMs: 5_000,
      now: () => now,
      lastInput: () => Math.max(0, ...presses.filter(at => at <= now)),
      stopped: () => now >= stopAt,
      wait: async ms => {
        now += ms;
      }
    };
    return whenQuiet(options).then(quiet => ({ quiet, at: now }));
  };

  it('waits a minute after start when nothing is pressed', async () => {
    expect(await run([])).toEqual({ quiet: true, at: 60_000 });
  });

  it('waits fifteen seconds past the last press', async () => {
    expect(await run([58_000])).toEqual({ quiet: true, at: 75_000 });
    expect(await run([58_000, 70_000, 84_000])).toEqual({ quiet: true, at: 100_000 });
  });

  it('gives up when the screen goes first', async () => {
    expect(await run([], 30_000)).toEqual({ quiet: false, at: 30_000 });
  });
});
