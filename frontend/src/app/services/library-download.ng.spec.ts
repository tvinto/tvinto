import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { StreamType } from '@shared/types';
import { AccountService } from './account.service';
import { SettingsService } from './settings.service';
import { API_URL } from './api-url';
import { ProviderAccessService } from './provider-access.service';
import { GuideService } from './guide.service';
import { GuideSourcesService } from './guide-sources.service';
import { ServiceKindService } from './service-kind.service';
import { LocalUserDataService } from './local-user-data.service';
import { NativePlayerService } from './native-player.service';
import { ParentalLockService } from './parental-lock.service';
import { XtreamService } from './xtream.service';

/**
 * The film and show libraries downloaded one at a time, however many ask at
 * once (25 November): the start-up download, a TMDB page and a search all
 * wanted the same library, and a provider usually allows one connection.
 */
describe('XtreamService library downloads', () => {
  let guideLoading = false;

  const setup = () => {
    const indexed = new Map<StreamType, string>();
    const log: string[] = [];
    let open = 0;
    let most = 0;
    const catalogue = {
      indexedAt: async (type: StreamType) => indexed.get(type) ?? null,
      indexIsFresh: async (type: StreamType) => indexed.has(type),
      index: async (type: StreamType) => {
        open++;
        most = Math.max(most, open);
        log.push(type);
        await new Promise(resolve => setTimeout(resolve, 5));
        indexed.set(type, new Date().toISOString());
        open--;
        return 10;
      }
    };
    const direct = { slots: [{ tag: '', xtream: null, catalogue }], catalogue, providerUsername: 'walk' };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: HttpClient, useValue: {} },
        { provide: API_URL, useValue: '' },
        { provide: AccountService, useValue: {} },
        { provide: SettingsService, useValue: {} },
        { provide: ProviderAccessService, useValue: { direct: async () => direct } },
        { provide: GuideService, useValue: { isLoading: () => guideLoading } },
        { provide: GuideSourcesService, useValue: {} },
        { provide: ServiceKindService, useValue: {} },
        { provide: LocalUserDataService, useValue: {} },
        { provide: NativePlayerService, useValue: { active: signal(false) } },
        { provide: ParentalLockService, useValue: {} }
      ]
    });
    const xtream = TestBed.inject(XtreamService);
    xtream.guideSettleMs = 1;
    return { xtream, log, most: () => most };
  };

  it('downloads each library once and never two at once, whoever asks', async () => {
    const { xtream, log, most } = setup();
    const [refreshed, films, shows] = await Promise.all([
      xtream.refreshLibrariesIfStale(['vod', 'series']),
      xtream.fetchLibraryIfNeverHeld('vod'),
      xtream.fetchLibraryIfNeverHeld('series')
    ]);
    expect([refreshed, films, shows]).toEqual([true, true, true]);
    expect(log.sort()).toEqual(['series', 'vod']);
    expect(most()).toBe(1);
    expect(await xtream.libraryAt('vod')).toEqual(expect.any(String));
  });

  it('waits for a guide download to end first: the provider allows one connection', async () => {
    const { xtream, log } = setup();
    guideLoading = true;
    const films = xtream.fetchLibraryIfNeverHeld('vod');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(log).toEqual([]);
    guideLoading = false;
    expect(await films).toBe(true);
    expect(log).toEqual(['vod']);
  });
});
