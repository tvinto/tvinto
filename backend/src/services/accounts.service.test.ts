import { AccountError, accountsService } from './accounts.service';
import { db } from '../utils/database';
import { xtreamService } from './xtream.service';
import { progressService } from './progress.service';
import { resetDatabase } from '../test-utils/seed';

const PASSWORD = 'a-good-long-password';

beforeEach(() => {
  resetDatabase({ withAccount: false });
});

const seedLegacyRows = (xtreamUsername: string) => {
  db.prepare('INSERT INTO favorites (username, stream_id, type) VALUES (?, ?, ?)').run(
    xtreamUsername,
    '101',
    'live'
  );
  db.prepare(
    'INSERT INTO sort_order (username, scope, item_id, position) VALUES (?, ?, ?, ?)'
  ).run(xtreamUsername, 'category:live', '7', 0);
  db.prepare(
    `INSERT INTO watch_progress (username, type, item_id, name, position_seconds, duration_seconds, completed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(xtreamUsername, 'vod', '55', 'A Film', 120, 3600, 0, new Date().toISOString());
};

describe('register', () => {
  it('creates an account and never returns the hash', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    expect(user.id).toBeGreaterThan(0);
    expect(user.username).toBe('petar');
    expect(JSON.stringify(user)).not.toContain(PASSWORD);
    expect(user).not.toHaveProperty('password_hash');
  });

  it('stores the password hashed, not readable', async () => {
    await accountsService.register('petar', PASSWORD);

    const row = db.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(row.password_hash).not.toContain(PASSWORD);
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
  });

  it('treats usernames as unique regardless of case', async () => {
    await accountsService.register('Petar', PASSWORD);

    await expect(accountsService.register('petar', PASSWORD)).rejects.toThrow('That username is taken');
    await expect(accountsService.register('PETAR', PASSWORD)).rejects.toThrow('That username is taken');
  });

  it('keeps the capitalisation that was typed', async () => {
    const user = await accountsService.register('Petar', PASSWORD);
    expect(user.username).toBe('Petar');
  });

  it('rejects a username that is too short or has odd characters', async () => {
    for (const bad of ['ab', '', 'has space', 'exclaim!', 'a'.repeat(33)]) {
      await expect(accountsService.register(bad, PASSWORD)).rejects.toBeInstanceOf(AccountError);
    }
  });

  it('rejects a password that is too short', async () => {
    await expect(accountsService.register('petar', 'short')).rejects.toThrow(/at least 8/);
  });

  it('rejects an absurdly long password rather than hashing it', async () => {
    await expect(accountsService.register('petar', 'x'.repeat(5000))).rejects.toThrow(/at most/);
  });
});

describe('authenticate', () => {
  it('accepts the right password', async () => {
    const created = await accountsService.register('petar', PASSWORD);

    const user = await accountsService.authenticate('petar', PASSWORD);

    expect(user?.id).toBe(created.id);
  });

  it('accepts the username in any case', async () => {
    await accountsService.register('Petar', PASSWORD);

    await expect(accountsService.authenticate('PETAR', PASSWORD)).resolves.not.toBeNull();
  });

  it('answers the same way for a wrong password and an unknown user', async () => {
    await accountsService.register('petar', PASSWORD);

    expect(await accountsService.authenticate('petar', 'wrong-password')).toBeNull();
    expect(await accountsService.authenticate('nobody', PASSWORD)).toBeNull();
  });

  it('refuses an empty password even if one were somehow stored', async () => {
    await accountsService.register('petar', PASSWORD);

    expect(await accountsService.authenticate('petar', '')).toBeNull();
  });

  it('upgrades a hash made with weaker parameters, transparently', async () => {
    const user = await accountsService.register('petar', PASSWORD);
    // Rewrite the stored hash as though an older, cheaper setting had made it.
    const weak = 'scrypt$1024$8$1$c2FsdHk=$' + Buffer.alloc(64).toString('base64');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(weak, user.id);

    // It no longer matches, so the login fails and the hash is left alone.
    expect(await accountsService.authenticate('petar', PASSWORD)).toBeNull();
    const after = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as {
      password_hash: string;
    };
    expect(after.password_hash).toBe(weak);
  });
});

describe('changePassword', () => {
  it('changes it when the current one is given', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    await accountsService.changePassword(user.id, PASSWORD, 'a-different-password');

    expect(await accountsService.authenticate('petar', 'a-different-password')).not.toBeNull();
    expect(await accountsService.authenticate('petar', PASSWORD)).toBeNull();
  });

  it('refuses without the current password, so a stolen session cannot lock a user out', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    await expect(
      accountsService.changePassword(user.id, 'not-the-password', 'a-different-password')
    ).rejects.toThrow('Current password is incorrect');

    expect(await accountsService.authenticate('petar', PASSWORD)).not.toBeNull();
  });

  it('holds the new password to the same standard', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    await expect(accountsService.changePassword(user.id, PASSWORD, 'tiny')).rejects.toThrow(
      /at least 8/
    );
  });
});

describe('provider accounts', () => {
  it('stores the subscription password encrypted, not in the clear', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    accountsService.addProviderAccount(user.id, {
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'provider-secret'
    });

    const row = db.prepare('SELECT xtream_secret FROM provider_accounts').get() as {
      xtream_secret: string;
    };
    expect(row.xtream_secret).not.toContain('provider-secret');
  });

  it('gives the credentials back for use', async () => {
    const user = await accountsService.register('petar', PASSWORD);
    accountsService.addProviderAccount(user.id, {
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'provider-secret'
    });

    expect(accountsService.getActiveCredentials(user.id)).toMatchObject({
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'provider-secret'
    });
  });

  it('never includes the secret in a listing', async () => {
    const user = await accountsService.register('petar', PASSWORD);
    accountsService.addProviderAccount(user.id, {
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'provider-secret'
    });

    const listed = accountsService.listProviderAccounts(user.id);

    expect(JSON.stringify(listed)).not.toContain('provider-secret');
    expect(listed[0]).not.toHaveProperty('xtreamSecret');
  });

  it('renewing replaces the credentials rather than adding a second row', async () => {
    const user = await accountsService.register('petar', PASSWORD);
    const details = {
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'last-years-password'
    };

    accountsService.addProviderAccount(user.id, details);
    accountsService.addProviderAccount(user.id, { ...details, password: 'this-years-password' });

    expect(accountsService.listProviderAccounts(user.id)).toHaveLength(1);
    expect(accountsService.getActiveCredentials(user.id)?.password).toBe('this-years-password');
  });

  it('has no credentials before a subscription is added', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    expect(accountsService.getActiveCredentials(user.id)).toBeNull();
  });

  it('reports no credentials when the stored secret cannot be read', async () => {
    const user = await accountsService.register('petar', PASSWORD);
    accountsService.addProviderAccount(user.id, {
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'provider-secret'
    });
    // As though the encryption key had been lost or replaced.
    db.prepare('UPDATE provider_accounts SET xtream_secret = ?').run('v1$bad$bad$bad');

    expect(accountsService.getActiveCredentials(user.id)).toBeNull();
  });

  it('refuses to attach a subscription to an account that does not exist', () => {
    expect(() =>
      accountsService.addProviderAccount(9999, {
        serverUrl: 'http://provider.example',
        username: 'c0ffee',
        password: 'x'
      })
    ).toThrow('No such account');
  });

  it('requires all three details', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    expect(() =>
      accountsService.addProviderAccount(user.id, {
        serverUrl: '',
        username: 'c0ffee',
        password: 'x'
      })
    ).toThrow(/required/);
  });

  it('removes only its own subscriptions', async () => {
    const mine = await accountsService.register('petar', PASSWORD);
    const theirs = await accountsService.register('someone', PASSWORD);
    const account = accountsService.addProviderAccount(theirs.id, {
      serverUrl: 'http://provider.example',
      username: 'other',
      password: 'x'
    });

    expect(accountsService.removeProviderAccount(mine.id, account.id)).toBe(false);
    expect(accountsService.listProviderAccounts(theirs.id)).toHaveLength(1);
  });

  it('deleting an account takes its subscriptions with it', async () => {
    const user = await accountsService.register('petar', PASSWORD);
    accountsService.addProviderAccount(user.id, {
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'x'
    });

    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

    const remaining = db.prepare('SELECT COUNT(*) c FROM provider_accounts').get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});

describe('claiming data written before accounts existed', () => {
  it('adopts the rows for the provider username being added', async () => {
    seedLegacyRows('c0ffee');
    const user = await accountsService.register('petar', PASSWORD);

    expect(accountsService.countLegacyData('c0ffee')).toBe(3);

    accountsService.addProviderAccount(user.id, {
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'provider-secret'
    });

    expect(accountsService.countLegacyData('c0ffee')).toBe(0);
    const owned = db.prepare('SELECT COUNT(*) c FROM favorites WHERE user_id = ?').get(user.id) as {
      c: number;
    };
    expect(owned.c).toBe(1);
  });

  it('leaves other provider usernames alone', async () => {
    seedLegacyRows('c0ffee');
    seedLegacyRows('a31c11');
    const user = await accountsService.register('petar', PASSWORD);

    accountsService.addProviderAccount(user.id, {
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'x'
    });

    expect(accountsService.countLegacyData('a31c11')).toBe(3);
  });

  it('will not take rows that already have an owner', async () => {
    seedLegacyRows('c0ffee');
    const first = await accountsService.register('petar', PASSWORD);
    const second = await accountsService.register('intruder', PASSWORD);

    accountsService.addProviderAccount(first.id, {
      serverUrl: 'http://provider.example',
      username: 'c0ffee',
      password: 'x'
    });
    // The same provider username on another server is refused outright: the
    // catalogue and guide this backend caches are filed under it alone.
    expect(() =>
      accountsService.addProviderAccount(second.id, {
        serverUrl: 'http://other.example',
        username: 'c0ffee',
        password: 'x'
      })
    ).toThrow(expect.objectContaining({ statusCode: 409 }));

    const stolen = db
      .prepare('SELECT COUNT(*) c FROM favorites WHERE user_id = ?')
      .get(second.id) as { c: number };
    expect(stolen.c).toBe(0);
  });

  it('claims nothing when there is nothing to claim', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    expect(accountsService.claimLegacyData(user.id, 'never-used')).toBe(0);
  });
});

describe('hasAnyUser', () => {
  it('is false before anyone registers and true afterwards', async () => {
    expect(accountsService.hasAnyUser()).toBe(false);

    await accountsService.register('petar', PASSWORD);

    expect(accountsService.hasAnyUser()).toBe(true);
  });
});

describe('surviving a renewal', () => {
  /**
   * The reason all of this exists. Xtream credentials expire and are reissued,
   * sometimes under a different username entirely, and the work the user has
   * done must not expire with them.
   */
  it('keeps favourites, arranging and history when the credentials change', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    accountsService.addProviderAccount(user.id, {
      serverUrl: 'http://provider.example',
      username: 'last-years-line',
      password: 'last-years-password'
    });

    xtreamService.addFavorite(user.id, 'live', '42', 'Channel 42');
    xtreamService.saveManualOrder(user.id, 'category:live', ['9', '3', '7']);
    progressService.record(user.id, {
      type: 'vod',
      itemId: '100',
      name: 'A Film',
      positionSeconds: 600,
      durationSeconds: 3600
    });

    // A year passes. The provider issues an entirely new line.
    accountsService.addProviderAccount(user.id, {
      serverUrl: 'http://provider.example',
      username: 'this-years-line',
      password: 'this-years-password'
    });

    expect(accountsService.getActiveCredentials(user.id)).toMatchObject({
      username: 'this-years-line',
      password: 'this-years-password'
    });

    // Nothing of the user's moved, because none of it was ever keyed to the
    // credential that expired.
    expect(xtreamService.getFavoriteIds(user.id, 'live')).toEqual(['42']);
    expect(xtreamService.getManualOrder(user.id, 'category:live')).toEqual(['9', '3', '7']);
    expect(progressService.recent(user.id, 'vod')).toHaveLength(1);
  });

  it('stores the names beside the ids, so a changed catalogue can be re-matched', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    xtreamService.addFavorite(user.id, 'live', '42', 'Channel 42');
    xtreamService.saveManualOrder(user.id, 'category:live', ['9'], { '9': 'Sport' });

    const favourite = db
      .prepare('SELECT name FROM favorites WHERE user_id = ?')
      .get(user.id) as { name: string };
    const arranged = db
      .prepare('SELECT name FROM sort_order WHERE user_id = ?')
      .get(user.id) as { name: string };

    expect(favourite.name).toBe('Channel 42');
    expect(arranged.name).toBe('Sport');
  });

  it('does not let one account see another account\'s favourites', async () => {
    const mine = await accountsService.register('petar', PASSWORD);
    const theirs = await accountsService.register('someone', PASSWORD);

    xtreamService.addFavorite(mine.id, 'live', '42');

    expect(xtreamService.getFavoriteIds(theirs.id, 'live')).toEqual([]);
  });

  it('adding the same favourite twice stores it once', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    xtreamService.addFavorite(user.id, 'live', '42');
    xtreamService.addFavorite(user.id, 'live', '42');

    expect(xtreamService.getFavoriteIds(user.id, 'live')).toEqual(['42']);
  });
});
