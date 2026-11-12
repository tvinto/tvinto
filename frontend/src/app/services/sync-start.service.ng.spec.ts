import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ProviderRecord } from '@shared/providers/providerRecord';
import { AccountService } from './account.service';
import { ProviderAccessService } from './provider-access.service';
import { ProvidersService } from './providers.service';
import { SettingsService } from './settings.service';
import { ConfirmService } from './confirm.service';
import { SyncStartService } from './sync-start.service';

/**
 * Signing in to sync from a device used without an account.
 */

const PLAYLIST: ProviderRecord = { kind: 'm3u', tag: '', enabled: true, label: 'Order test', url: 'http://127.0.0.1:8766/order-test.m3u' };
const THEIRS: ProviderRecord = { kind: 'm3u', tag: 'p8a9', enabled: true, label: 'Free TV', url: 'http://127.0.0.1:8765/fta.m3u' };

const FAVOURITE = JSON.stringify({
  favourites: { 'live:m1': { change: { type: 'live', streamId: 'm1', name: 'Alpha One', updatedAt: 't' }, icon: '' } },
  progress: {},
  arrangements: {},
  tombstones: {}
});

describe('SyncStartService', () => {
  let local: { active: ReturnType<typeof signal<boolean>>; leave: jest.Mock; keptFrom: () => string | null };
  let asked: jest.Mock;
  let access: { storedRecords: jest.Mock; accountRecords: jest.Mock; useRecords: jest.Mock };
  let sent: ProviderRecord[];
  let settingsBrought: jest.Mock;
  let settingsDropped: jest.Mock;

  const build = (account: () => Promise<ProviderRecord[]>, keptFrom: string | null = null, bring = false) => {
    local = { active: signal(true), leave: jest.fn(() => local.active.set(false)), keptFrom: () => keptFrom };
    asked = jest.fn(async () => bring);
    access = { storedRecords: jest.fn(() => [PLAYLIST]), accountRecords: jest.fn(account), useRecords: jest.fn() };
    sent = [];
    settingsBrought = jest.fn();
    settingsDropped = jest.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AccountService,
          useValue: { account: signal({ id: 1, username: 'Ana' }), localProfile: local, hasSubscription: signal(false) }
        },
        { provide: ProviderAccessService, useValue: access },
        { provide: ProvidersService, useValue: { sendToAccount: async (record: ProviderRecord) => void sent.push(record) } },
        { provide: SettingsService, useValue: { get: () => null, set: jest.fn(), bringKept: settingsBrought, dropKept: settingsDropped } },
        { provide: ConfirmService, useValue: { ask: asked } }
      ]
    });
    return TestBed.inject(SyncStartService);
  };

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('xtream_local_data:~local', FAVOURITE);
  });

  it("hands an account with nothing the device's providers and favourites as they are", async () => {
    await build(async () => []).afterSignIn();

    expect(sent).toEqual([PLAYLIST]);
    expect(access.useRecords).toHaveBeenCalledWith([PLAYLIST]);
    expect(localStorage.getItem('xtream_local_data:ana')).toBe(FAVOURITE);
    expect(localStorage.getItem('xtream_local_data:~local')).toBeNull();
    expect(local.leave).toHaveBeenCalled();
  });

  it("files the device's first provider under a tag of its own beside the account's", async () => {
    await build(async () => [THEIRS]).afterSignIn();

    expect(sent).toHaveLength(1);
    const tag = sent[0].tag;
    expect(tag).not.toBe('');
    expect(Object.keys(JSON.parse(localStorage.getItem('xtream_local_data:ana')!).favourites)).toEqual([`live:${tag}~m1`]);
  });

  it('asks before handing what one account kept to another, and starts fresh when told', async () => {
    await build(async () => [THEIRS], 'petar', false).afterSignIn();

    expect(asked).toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(access.useRecords).toHaveBeenCalledWith([THEIRS]);
    // Back under the account it was kept from, for when that person signs in here again.
    expect(localStorage.getItem('xtream_local_data:petar')).toBe(FAVOURITE);
    expect(localStorage.getItem('xtream_local_data:ana')).toBeNull();
    // The kept settings stay out too: the PIN and the locks among them.
    expect(settingsDropped).toHaveBeenCalled();
    expect(settingsBrought).not.toHaveBeenCalled();
    expect(local.leave).toHaveBeenCalled();
  });

  it('brings it all when told to', async () => {
    await build(async () => [], 'petar', true).afterSignIn();

    expect(sent).toEqual([PLAYLIST]);
    expect(localStorage.getItem('xtream_local_data:ana')).toBe(FAVOURITE);
    expect(settingsBrought).toHaveBeenCalled();
  });

  it('does not ask the same person back', async () => {
    await build(async () => [], 'ana').afterSignIn();

    expect(asked).not.toHaveBeenCalled();
    expect(localStorage.getItem('xtream_local_data:ana')).toBe(FAVOURITE);
  });

  it("moves nothing when the account's providers cannot be read", async () => {
    const start = build(async () => {
      throw new Error('unreachable');
    });

    await expect(start.afterSignIn()).rejects.toThrow('unreachable');

    expect(sent).toEqual([]);
    expect(localStorage.getItem('xtream_local_data:~local')).toBe(FAVOURITE);
    expect(local.leave).not.toHaveBeenCalled();
  });

  it('does nothing for a device that already had an account', async () => {
    const start = build(async () => []);
    local.active.set(false);

    await start.afterSignIn();

    expect(access.accountRecords).not.toHaveBeenCalled();
  });
});
