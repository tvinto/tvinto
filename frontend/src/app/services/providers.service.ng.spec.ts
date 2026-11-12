import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { ProviderRecord, recordId } from '@shared/providers/providerRecord';
import { API_URL } from './api-url';
import { AccountKeysService } from './account-keys.service';
import { AccountService } from './account.service';
import { CarryOverService } from './carry-over.service';
import { GuideSourcesService } from './guide-sources.service';
import { ProviderAccessService } from './provider-access.service';
import { ProvidersService } from './providers.service';

/**
 * Every provider alike (9 October): the one added first can be removed like
 * any other, and the account keeps a subscription while it has a provider.
 */

const FREE: ProviderRecord = { kind: 'm3u', tag: '', enabled: true, label: 'Free', url: 'https://free.example/list.m3u' };
const PAID: ProviderRecord = {
  kind: 'xtream',
  tag: 'b',
  enabled: true,
  label: 'Paid',
  serverUrl: 'http://paid.example',
  username: 'someone',
  password: 'not-a-real-one'
};

describe('ProvidersService', () => {
  let http: { post: jest.Mock; delete: jest.Mock };
  let records: ReturnType<typeof signal<ProviderRecord[]>>;
  let hasSubscription: ReturnType<typeof signal<boolean>>;

  const build = (start: ProviderRecord[], local = false) => {
    http = {
      post: jest.fn(() => of({ success: true })),
      delete: jest.fn(() => of({ success: true }))
    };
    records = signal(start);
    hasSubscription = signal(start.length > 0);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: HttpClient, useValue: http },
        { provide: API_URL, useValue: 'https://sync.example/api' },
        { provide: AccountKeysService, useValue: { seal: async (text: string) => `sealed:${text.length}` } },
        {
          provide: ProviderAccessService,
          useValue: { records, useRecords: (next: ProviderRecord[]) => records.set(next), supported: true, loadedRecords: async () => records() }
        },
        { provide: CarryOverService, useValue: {} },
        { provide: GuideSourcesService, useValue: { addGuidesOf: async () => 0 } },
        { provide: AccountService, useValue: { hasSubscription, localProfile: { active: () => local } } }
      ]
    });
    return TestBed.inject(ProvidersService);
  };

  it('removes the provider added first, and hands the subscription flag to the one left', async () => {
    const providers = build([FREE, PAID]);

    await providers.remove(FREE);

    expect(http.delete).toHaveBeenCalledWith(`https://sync.example/api/accounts/providers/${encodeURIComponent(recordId(FREE))}`);
    expect(records()).toEqual([PAID]);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post.mock.calls[0][1]).toMatchObject({ id: recordId(PAID), active: true });
    expect(hasSubscription()).toBe(true);
  });

  it('leaves the flag where it is when another provider goes', async () => {
    const providers = build([FREE, PAID]);

    await providers.remove(PAID);

    expect(records()).toEqual([FREE]);
    expect(http.post).not.toHaveBeenCalled();
    expect(hasSubscription()).toBe(true);
  });

  it('has no subscription once the last provider goes', async () => {
    const providers = build([PAID]);

    await providers.remove(PAID);

    expect(records()).toEqual([]);
    expect(hasSubscription()).toBe(false);
  });

  it('gives a newcomer a tag of its own, not the one a removed first provider left', async () => {
    const providers = build([PAID]);

    await providers.add({ kind: 'm3u', label: 'Another', url: 'https://another.example/list.m3u' });

    const added = records()[1];
    expect(added.tag).not.toBe('');
    expect(added.tag).not.toBe('b');
    expect(http.post.mock.calls[0][1]).toMatchObject({ active: false });
  });

  describe('without an account', () => {
    it('keeps a provider on the device and sends nothing', async () => {
      const providers = build([], true);

      await providers.add({ kind: 'm3u', label: 'Free', url: 'https://free.example/list.m3u' });

      expect(records()).toHaveLength(1);
      expect(http.post).not.toHaveBeenCalled();
      expect(hasSubscription()).toBe(true);
    });

    it('removes one from the device alone', async () => {
      const providers = build([FREE, PAID], true);

      await providers.remove(FREE);

      expect(records()).toEqual([PAID]);
      expect(http.delete).not.toHaveBeenCalled();
      expect(http.post).not.toHaveBeenCalled();
    });
  });

  it('makes the very first provider the subscription', async () => {
    const providers = build([]);

    await providers.add({ kind: 'm3u', label: 'Free', url: 'https://free.example/list.m3u' });

    expect(records()[0].tag).toBe('');
    expect(http.post.mock.calls[0][1]).toMatchObject({ active: true });
    expect(hasSubscription()).toBe(true);
  });
});
