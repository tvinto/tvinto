import {
  HOURS_BETWEEN_ATTEMPTS,
  RELOAD_WHEN_HOURS_REMAIN,
  decideGuideReload,
  whenRunningOut
} from './guideReload';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-12T19:30:00Z');
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * HOUR).toISOString();

describe('decideGuideReload', () => {
  // The real device this was written for: loaded on 31 August, programmes
  // ending on 6 September, looked at on the 12th.
  it('reloads the guide that had run out on a real device', () => {
    const decision = decideGuideReload(
      {
        loadedAt: '2026-08-31T18:47:19.180Z',
        loadedHereBefore: true,
        runsOutAt: Date.parse('2026-09-06T22:59:50Z'),
        lastAttemptAt: null
      },
      NOW
    );

    expect(decision).toEqual({ reload: true, reason: 'running-out' });
  });

  it('reloads when less than the margin is left', () => {
    const decision = decideGuideReload(
      {
        loadedAt: at(-72),
        loadedHereBefore: true,
        runsOutAt: NOW + (RELOAD_WHEN_HOURS_REMAIN - 1) * HOUR,
        lastAttemptAt: null
      },
      NOW
    );

    expect(decision.reload).toBe(true);
  });

  // The point of not using a timer: a week of schedule is fetched about weekly.
  it('leaves a guide alone while it has plenty left', () => {
    const decision = decideGuideReload(
      { loadedAt: at(-72), loadedHereBefore: true, runsOutAt: NOW + 4 * 24 * HOUR, lastAttemptAt: null },
      NOW
    );

    expect(decision).toEqual({ reload: false, reason: 'enough-left' });
  });

  // The first download is a person's choice, not the app's.
  it('never downloads a guide this device has not loaded before', () => {
    const decision = decideGuideReload(
      { loadedAt: null, loadedHereBefore: false, runsOutAt: null, lastAttemptAt: null },
      NOW
    );

    expect(decision).toEqual({ reload: false, reason: 'never-loaded' });
  });

  // The guard against a retry loop: a failed attempt still counts.
  it('does not try again within a day of the last attempt, even one that failed', () => {
    const decision = decideGuideReload(
      {
        loadedAt: at(-200),
        loadedHereBefore: true,
        runsOutAt: NOW - 100 * HOUR,
        lastAttemptAt: at(-(HOURS_BETWEEN_ATTEMPTS - 1))
      },
      NOW
    );

    expect(decision).toEqual({ reload: false, reason: 'tried-recently' });
  });

  it('tries again once a day has passed since a failed attempt', () => {
    const decision = decideGuideReload(
      {
        loadedAt: at(-200),
        loadedHereBefore: true,
        runsOutAt: NOW - 100 * HOUR,
        lastAttemptAt: at(-(HOURS_BETWEEN_ATTEMPTS + 1))
      },
      NOW
    );

    expect(decision.reload).toBe(true);
  });

  it('counts a load somebody did by hand as recent', () => {
    const decision = decideGuideReload(
      { loadedAt: at(-1), loadedHereBefore: true, runsOutAt: NOW + HOUR, lastAttemptAt: null },
      NOW
    );

    expect(decision).toEqual({ reload: false, reason: 'tried-recently' });
  });

  it('reloads a guide that loaded but holds no programmes', () => {
    const decision = decideGuideReload(
      { loadedAt: at(-48), loadedHereBefore: true, runsOutAt: null, lastAttemptAt: null },
      NOW
    );

    expect(decision).toEqual({ reload: true, reason: 'no-programmes' });
  });

  it('ignores an attempt dated far in the future by a clock that was wrong', () => {
    const decision = decideGuideReload(
      {
        loadedAt: at(-200),
        loadedHereBefore: true,
        runsOutAt: NOW - 100 * HOUR,
        lastAttemptAt: '2027-09-12T00:00:00Z'
      },
      NOW
    );

    expect(decision.reload).toBe(true);
  });

  it('treats an unreadable load time as never loaded', () => {
    const decision = decideGuideReload(
      { loadedAt: 'not a date', loadedHereBefore: false, runsOutAt: null, lastAttemptAt: null },
      NOW
    );

    expect(decision).toEqual({ reload: false, reason: 'never-loaded' });
  });
});

describe('decideGuideReload, for a guide the store has lost', () => {
  // The desktop that prompted this: still signed in, guides deleted from
  // IndexedDB underneath it, both reading "Not loaded on this device yet".
  it('fetches back a guide this device loaded before and no longer has', () => {
    const decision = decideGuideReload(
      { loadedAt: null, loadedHereBefore: true, runsOutAt: null, lastAttemptAt: null },
      NOW
    );

    expect(decision).toEqual({ reload: true, reason: 'lost' });
  });

  it('still refuses a guide this device never loaded', () => {
    const decision = decideGuideReload(
      { loadedAt: null, loadedHereBefore: false, runsOutAt: null, lastAttemptAt: null },
      NOW
    );

    expect(decision).toEqual({ reload: false, reason: 'never-loaded' });
  });

  // A store that keeps losing the guide must not turn into a download every
  // three hours.
  it('keeps to the daily floor for a lost guide as well', () => {
    const decision = decideGuideReload(
      {
        loadedAt: null,
        loadedHereBefore: true,
        runsOutAt: null,
        lastAttemptAt: at(-(HOURS_BETWEEN_ATTEMPTS - 1))
      },
      NOW
    );

    expect(decision).toEqual({ reload: false, reason: 'tried-recently' });
  });

  it('tries a lost guide again once a day has passed', () => {
    const decision = decideGuideReload(
      {
        loadedAt: null,
        loadedHereBefore: true,
        runsOutAt: null,
        lastAttemptAt: at(-(HOURS_BETWEEN_ATTEMPTS + 1))
      },
      NOW
    );

    expect(decision).toEqual({ reload: true, reason: 'lost' });
  });
});

describe('whenRunningOut', () => {
  const LOADED = NOW - 4 * HOUR;
  // Ten channels: one described for 7 hours more, nine for two days or more.
  const uneven = [7, 31, 40, 48, 50, 52, 54, 54, 55, 55].map(hours => NOW + hours * HOUR);

  it('is when a tenth of the channels run out, not the last programme of all', () => {
    // The development desktop's guide on 6 October, in miniature: by its last
    // programme it had 55 hours left and waited two days for a reload, while
    // its shortest channels drew empty rows.
    expect(whenRunningOut(uneven, LOADED)).toBe(NOW + 31 * HOUR);
    expect(whenRunningOut([NOW + 7 * HOUR, ...uneven.slice(1)].concat(uneven), LOADED)).toBe(NOW + 31 * HOUR);
  });

  it('makes a guide whose short channels are nearly out one to reload', () => {
    const stops = [2, 3, 30, 40, 48, 50, 52, 54, 55, 55].map(hours => NOW + hours * HOUR);
    const decision = decideGuideReload(
      { loadedAt: new Date(LOADED - 24 * HOUR).toISOString(), loadedHereBefore: true, runsOutAt: whenRunningOut(stops, LOADED - 24 * HOUR), lastAttemptAt: null },
      NOW
    );
    expect(decision).toEqual({ reload: true, reason: 'running-out' });
  });

  it('leaves out channels the feed had already stopped describing when it was loaded', () => {
    // Three dead channels would otherwise make this guide due every day for ever.
    const dead = [LOADED - 48 * HOUR, LOADED - 30 * HOUR, LOADED - HOUR];
    expect(whenRunningOut([...dead, ...uneven], LOADED)).toBe(NOW + 31 * HOUR);
  });

  it('counts every channel when the load time is not known', () => {
    expect(whenRunningOut([NOW - HOUR, ...uneven], null)).toBe(NOW + 7 * HOUR);
  });

  it('falls back to the last programme when every channel was already over', () => {
    expect(whenRunningOut([LOADED - 3 * HOUR, LOADED - HOUR], LOADED)).toBe(LOADED - HOUR);
  });

  it('is nothing for a guide with no programmes', () => {
    expect(whenRunningOut([], LOADED)).toBeNull();
  });
});
