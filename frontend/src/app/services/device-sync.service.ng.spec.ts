import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Account } from '@shared/types';
import { emptyChangeSet } from '@shared/sync';
import { fnv1aHex } from '@shared/xtream/guideSourceId';
import { AccountService } from './account.service';
import { API_URL } from './api-url';
import { DeviceSyncService } from './device-sync.service';
import { GuideSourcesService } from './guide-sources.service';
import { LocalUserDataService } from './local-user-data.service';
import { ProviderAccessService } from './provider-access.service';
import { SettingsService } from './settings.service';
import { syncCursorKey } from '../utils/sync-queue.utils';

/**
 * A device's first sync with an account it has just signed in to.
 *
 * 12 November: a new desktop copy showed For You's four day-one doors, and
 * nothing else, for an account with plenty of history -- the page had read
 * the device's empty history before the first sync brought the account's in,
 * and nothing told it that sync was still on its way, or that it had landed.
 */

const API = 'http://sync.test/api';
const ACCOUNT: Account = { id: 1, username: 'AnaMaria', createdAt: '2026-08-30T10:00:00.000Z' };
const CURSOR = syncCursorKey('xtream_sync_cursor', ACCOUNT.username, API, fnv1aHex);

describe('DeviceSyncService, signing in', () => {
  const account = signal<Account | null>(null);
  let guides: { applyIncoming: jest.Mock; loadFirstTimeHere: jest.Mock };
  let http: HttpTestingController;

  const build = (): DeviceSyncService => {
    guides = {
      applyIncoming: jest.fn().mockResolvedValue(undefined),
      loadFirstTimeHere: jest.fn().mockResolvedValue(undefined)
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_URL, useValue: API },
        {
          provide: AccountService,
          useValue: {
            account,
            getToken: () => (account() ? 'token' : null),
            storageName: () => account()?.username,
            profileScope: () => 'full',
            localProfile: { active: () => false }
          }
        },
        { provide: SettingsService, useValue: { applyIncoming: jest.fn(), applyRemoved: jest.fn(), resend: jest.fn(), holding: () => false } },
        // A device with nothing of its own to send, as a new one is.
        {
          provide: LocalUserDataService,
          useValue: { enabled: false, hasPending: () => false, pending: () => emptyChangeSet(), applyIncoming: jest.fn() }
        },
        { provide: GuideSourcesService, useValue: { ...guides, sources: () => [] } },
        { provide: ProviderAccessService, useValue: { offerSubscription: async () => false } }
      ]
    });
    const service = TestBed.inject(DeviceSyncService);
    http = TestBed.inject(HttpTestingController);
    return service;
  };

  const signIn = (service: DeviceSyncService) => {
    account.set(ACCOUNT);
    TestBed.tick();
    return service;
  };

  const answerPull = (moved: Partial<ReturnType<typeof emptyChangeSet>> = {}) =>
    http
      .expectOne(request => request.url === `${API}/devices/changes` && request.method === 'GET')
      .flush({ success: true, data: { ...emptyChangeSet(), ...moved, serverTime: '2026-11-12T10:00:00.000Z' } });

  beforeEach(() => {
    localStorage.clear();
    account.set(null);
  });

  afterEach(() => jest.useRealTimers());

  it('is waiting on the first sync from sign-in until it answers', () => {
    const service = signIn(build());
    expect(service.firstSync()).toBe(true);

    answerPull({ progress: [{ type: 'vod', itemId: '7', positionSeconds: 60, durationSeconds: 600, updatedAt: '2026-11-11T20:00:00.000Z' } as never] });

    expect(service.firstSync()).toBe(false);
    expect(service.remoteChanges()).toBe(1);
  });

  it('downloads the account guides after the first sync', async () => {
    const service = signIn(build());
    answerPull();
    await Promise.resolve();
    await Promise.resolve();

    expect(service.firstSync()).toBe(false);
    expect(guides.loadFirstTimeHere).toHaveBeenCalledTimes(1);
  });

  it('is not waiting, nor downloads guides, on a device that has synced before', async () => {
    localStorage.setItem(CURSOR, '2026-11-11T10:00:00.000Z');
    const service = signIn(build());
    expect(service.firstSync()).toBe(false);

    answerPull();
    await Promise.resolve();
    await Promise.resolve();

    expect(guides.loadFirstTimeHere).not.toHaveBeenCalled();
  });

  it('stops waiting when the first sync fails, rather than for ever', () => {
    const service = signIn(build());

    http
      .expectOne(request => request.method === 'GET')
      .flush('down', { status: 503, statusText: 'Unavailable' });

    expect(service.firstSync()).toBe(false);
  });
});
