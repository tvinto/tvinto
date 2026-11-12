import {
  VAULT_KEY,
  activate,
  forgetProfile,
  homeVault,
  readVault,
  shouldAskWhoIsWatching,
  stashActive,
  storageNameOf,
  writeVault
} from './profile-vault.utils';

/** localStorage, as far as these functions use it. */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  dump(): Record<string, string> {
    return Object.fromEntries(this.items);
  }
}

const petarSignedIn = (): MemoryStorage => {
  const storage = new MemoryStorage();
  storage.setItem('xtream_session_token', 'petar-token');
  storage.setItem('xtream_account_enc', 'petar-enc');
  storage.setItem('xtream_provider_records', '[petar]');
  storage.setItem('xtream_last_category_live', '12');
  // Already named after the account: stays where it is through a switch.
  storage.setItem('xtream_local_data:petar', '{favourites}');
  // The device's own, which no profile owns.
  storage.setItem('xtream.language', 'hr');
  return storage;
};

describe('switching profiles', () => {
  it("moves one account's fixed-name keys aside and leaves the device's own", () => {
    const storage = petarSignedIn();

    const vault = stashActive(storage, homeVault('Petar'));

    expect(vault.stash['petar']).toEqual({
      xtream_session_token: 'petar-token',
      xtream_account_enc: 'petar-enc',
      xtream_provider_records: '[petar]',
      xtream_last_category_live: '12'
    });
    expect(storage.dump()).toEqual({ 'xtream_local_data:petar': '{favourites}', 'xtream.language': 'hr' });
  });

  it('starts a new profile from what it is given, and brings the old one back whole', () => {
    const storage = petarSignedIn();

    let vault = stashActive(storage, homeVault('petar'));
    vault = activate(storage, vault, 'ana', 'full', { xtream_session_token: 'ana-token', xtream_account_enc: 'ana-enc' });
    expect(storage.getItem('xtream_session_token')).toBe('ana-token');
    expect(storage.getItem('xtream_provider_records')).toBeNull();
    expect(vault).toMatchObject({ active: 'ana', scope: 'full' });

    // Ana's records arrive while she is in use.
    storage.setItem('xtream_provider_records', '[ana]');

    vault = stashActive(storage, vault);
    vault = activate(storage, vault, 'petar', 'full');
    expect(storage.getItem('xtream_session_token')).toBe('petar-token');
    expect(storage.getItem('xtream_provider_records')).toBe('[petar]');
    expect(vault.stash['ana']).toEqual({
      xtream_session_token: 'ana-token',
      xtream_account_enc: 'ana-enc',
      xtream_provider_records: '[ana]'
    });
    expect(vault.stash['petar']).toBeUndefined();
  });

  it('keeps setting somebody up apart from that person as a profile', () => {
    expect(storageNameOf('Ana', 'setup')).toBe('ana~setup');
    expect(storageNameOf('Ana', 'full')).toBe('ana');
  });

  it('forgets everything a profile had on this device, and nothing of anybody else', () => {
    const storage = petarSignedIn();
    storage.setItem('xtream_local_data:ana~setup', '{x}');
    storage.setItem('xtream_guide_sources:ana~setup', '[x]');
    storage.setItem('xtream_sync_cursor:ana~setup:abc123', 'cursor');
    storage.setItem('xtream_local_data:ana', '{hers}');

    let vault = stashActive(storage, homeVault('petar'));
    vault = activate(storage, vault, 'ana~setup', 'setup', { xtream_session_token: 'setup-token' });
    vault = stashActive(storage, vault);
    vault = forgetProfile(storage, vault, 'ana~setup');

    expect(vault.stash['ana~setup']).toBeUndefined();
    expect(storage.getItem('xtream_local_data:ana~setup')).toBeNull();
    expect(storage.getItem('xtream_guide_sources:ana~setup')).toBeNull();
    expect(storage.getItem('xtream_sync_cursor:ana~setup:abc123')).toBeNull();
    expect(storage.getItem('xtream_local_data:ana')).toBe('{hers}');
    expect(storage.getItem('xtream_local_data:petar')).toBe('{favourites}');
  });

  it('survives being written and read back, and reads nonsense as no vault', () => {
    const storage = new MemoryStorage();
    writeVault(storage, { ...homeVault('petar'), household: [{ id: 2, username: 'ana', role: 'member' }] });

    expect(readVault(storage)?.household).toEqual([{ id: 2, username: 'ana', role: 'member' }]);

    storage.setItem(VAULT_KEY, '{not json');
    expect(readVault(storage)).toBeNull();
  });
});

describe("asking who's watching", () => {
  const withHousehold = { ...homeVault('petar'), household: [{ id: 2, username: 'ana', role: 'member' }] };

  it('asks only where there is somebody to choose between', () => {
    expect(shouldAskWhoIsWatching(homeVault('petar'))).toBe(false);
    expect(shouldAskWhoIsWatching(withHousehold)).toBe(true);
    expect(shouldAskWhoIsWatching(null)).toBe(false);
  });

  it('asks at every start, however recently the device was used', () => {
    expect(shouldAskWhoIsWatching({ ...withHousehold, lastSeenAt: '2026-10-01T17:30:00.000Z' })).toBe(true);
  });

  it('never asks in the middle of setting somebody up', () => {
    expect(shouldAskWhoIsWatching({ ...withHousehold, scope: 'setup' })).toBe(false);
  });
});
