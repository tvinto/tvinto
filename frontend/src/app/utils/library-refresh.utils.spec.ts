import { BUSY_RETRY_MS, LibraryRefreshOptions, RECHECK_MS, SETTLE_MS, keepLibrariesFresh } from './library-refresh.utils';

/**
 * The libraries downloaded from the start, at a quiet moment, never beside
 * something using the provider's connection, and looked at again after.
 */
describe('keepLibrariesFresh', () => {
  /** `busy` answers in turn, then not busy; `looked` what each refresh says. */
  const run = async (busy: boolean[], rounds: number, looked = [true]) => {
    const events: string[] = [];
    let left = rounds;
    let refreshes = 0;
    const options: LibraryRefreshOptions = {
      quiet: async () => true,
      busy: () => busy.shift() ?? false,
      refresh: async () => {
        events.push('refresh');
        if (refreshes++ === 0) {
          throw new Error('offline');
        }
        return looked.shift() ?? true;
      },
      wait: async ms => void events.push(`wait ${ms}`),
      stopped: () => left-- <= 0
    };
    await keepLibrariesFresh(options);
    return events;
  };

  it('refreshes at the first quiet moment, then looks again later, a failure included', async () => {
    expect(await run([], 2)).toEqual([`wait ${SETTLE_MS}`, 'refresh', `wait ${RECHECK_MS}`, `wait ${SETTLE_MS}`, 'refresh', `wait ${RECHECK_MS}`]);
  });

  it('waits while the connection is busy, and for it to stay free a moment', async () => {
    // Busy, then free for an instant only (a guide starting with the provider), then free.
    expect(await run([true, false, true, false, false], 3)).toEqual([`wait ${BUSY_RETRY_MS}`, `wait ${SETTLE_MS}`, `wait ${SETTLE_MS}`, 'refresh', `wait ${RECHECK_MS}`]);
  });

  it('looks again soon when there was no library to look at yet', async () => {
    expect(await run([], 2, [false])).toEqual([`wait ${SETTLE_MS}`, 'refresh', `wait ${RECHECK_MS}`, `wait ${SETTLE_MS}`, 'refresh', `wait ${BUSY_RETRY_MS}`]);
  });

  it('stops when no quiet moment will come', async () => {
    const events: string[] = [];
    await keepLibrariesFresh({ quiet: async () => false, busy: () => false, refresh: async () => Boolean(events.push('refresh')), wait: async () => undefined, stopped: () => false });
    expect(events).toEqual([]);
  });
});
