import { sessionStore } from './sessions';
import { db } from './database';
import { accountsService } from '../services/accounts.service';
import { resetDatabase } from '../test-utils/seed';

let userId: number;

beforeEach(async () => {
  resetDatabase({ withAccount: false });
  userId = (await accountsService.register('petar', 'a-good-long-password')).id;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('sessionStore', () => {
  it('resolves a token to the account it names', () => {
    const token = sessionStore.createForUser(userId);

    expect(sessionStore.resolve(token)).toEqual({ userId });
    expect(sessionStore.resolveUserId(token)).toBe(userId);
  });

  it('issues an unguessable token that reveals nothing about the account', () => {
    const token = sessionStore.createForUser(userId);

    // 256 bits of randomness, and no part of the account encoded in it. Not
    // asserted against the numeric id: any 64-character hex string contains a
    // given digit by chance, so that check would pass or fail at random.
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain('petar');
  });

  it('issues a different token every time, so sessions cannot collide', () => {
    const tokens = new Set([
      sessionStore.createForUser(userId),
      sessionStore.createForUser(userId),
      sessionStore.createForUser(userId)
    ]);

    expect(tokens.size).toBe(3);
  });

  it('returns null for a token it never issued', () => {
    expect(sessionStore.resolve('not-a-token')).toBeNull();
    expect(sessionStore.resolveUserId('not-a-token')).toBeNull();
  });

  it('destroys a session, after which the token is worthless', () => {
    const token = sessionStore.createForUser(userId);

    expect(sessionStore.destroy(token)).toBe(true);
    expect(sessionStore.resolve(token)).toBeNull();
    expect(sessionStore.destroy(token)).toBe(false);
  });

  it('expires a session left idle past the TTL', () => {
    jest.useFakeTimers();
    const token = sessionStore.createForUser(userId);

    jest.advanceTimersByTime(13 * 60 * 60 * 1000);

    expect(sessionStore.resolve(token)).toBeNull();
  });

  it('keeps a session alive while it is being used', () => {
    jest.useFakeTimers();
    const token = sessionStore.createForUser(userId);

    // Eleven hours of idling, a use, then eleven more: never idle for twelve.
    jest.advanceTimersByTime(11 * 60 * 60 * 1000);
    expect(sessionStore.resolve(token)).toEqual({ userId });

    jest.advanceTimersByTime(11 * 60 * 60 * 1000);
    expect(sessionStore.resolve(token)).toEqual({ userId });
  });

  it('ends every session belonging to one user and leaves others alone', async () => {
    const other = (await accountsService.register('someone', 'a-good-long-password')).id;
    const mine = [sessionStore.createForUser(userId), sessionStore.createForUser(userId)];
    const theirs = sessionStore.createForUser(other);

    expect(sessionStore.destroyForUser(userId)).toBe(2);

    for (const token of mine) {
      expect(sessionStore.resolve(token)).toBeNull();
    }
    expect(sessionStore.resolve(theirs)).not.toBeNull();
  });

  it('sweeps expired sessions out of memory without being asked', async () => {
    // The store is re-imported under fake timers so its own sweep interval,
    // created at construction, is one this test can advance.
    jest.useFakeTimers();
    let store!: typeof sessionStore;
    await jest.isolateModulesAsync(async () => {
      ({ sessionStore: store } = await import('./sessions'));
    });

    const token = store.createForUser(userId);
    jest.advanceTimersByTime(13 * 60 * 60 * 1000);

    // Resolve would delete it on read; the count proves the sweep already did.
    expect((store as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    expect(store.resolve(token)).toBeNull();
  });
});

describe('surviving a restart', () => {
  /**
   * A fresh store with an empty map, standing in for the process coming back
   * up. The database is the only thing carried across, which is the point.
   */
  const afterRestart = async () => {
    let store!: typeof sessionStore;
    await jest.isolateModulesAsync(async () => {
      ({ sessionStore: store } = await import('./sessions'));
    });
    return store;
  };

  it('signs an account back in from disk', async () => {
    const token = sessionStore.createForUser(userId);

    const restarted = await afterRestart();

    expect(restarted.resolve(token)).toEqual({ userId });
  });

  it('stores the token hashed, so a copy of the database is not a set of keys', () => {
    const token = sessionStore.createForUser(userId);

    const rows = db.prepare('SELECT token_hash FROM sessions').all() as Array<{
      token_hash: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a signed-out token does not come back from the dead', async () => {
    const token = sessionStore.createForUser(userId);
    sessionStore.destroy(token);

    const restarted = await afterRestart();

    expect(restarted.resolve(token)).toBeNull();
  });

  it('a password change reaches devices this process has never seen', async () => {
    const token = sessionStore.createForUser(userId);
    const restarted = await afterRestart();

    // Ended without ever having been resolved into the new process's memory.
    expect(restarted.destroyForUser(userId)).toBe(1);
    expect(restarted.resolve(token)).toBeNull();
  });

  it('will not revive a session that sat idle past its life', async () => {
    const token = sessionStore.createForUser(userId);
    const longAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE sessions SET last_used_at = ?').run(longAgo);

    const restarted = await afterRestart();

    expect(restarted.resolve(token)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c).toBe(0);
  });

  it('deleting an account takes its sessions with it', () => {
    sessionStore.createForUser(userId);

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    expect((db.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c).toBe(0);
  });
});
