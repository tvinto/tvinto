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
      indexIsFresh: async (type: StreamType) => Date.now() - Date.parse(indexed.get(type) ?? '') < 86_400_000,
      index: async (type: StreamType, _timeout?: number, _onFiled?: unknown, pause?: () => Promise<void>) => {
        if (pause) {
          log.push(`${type} pauses`);
        }
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
    return { xtream, log, most: () => most, indexed };
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

  it('does not wait for a guide download: what a page needs never waits on one (card 35)', async () => {
    const { xtream, log } = setup();
    guideLoading = true;
    expect(await xtream.fetchLibraryIfNeverHeld('vod')).toBe(true);
    expect(log).toEqual(['vod']);
    guideLoading = false;
  });

  it('leaves a library held at all to its refresh: a film page does not wait for it (card 35)', async () => {
    const { xtream, log, indexed } = setup();
    indexed.set('vod', '2026-11-20T10:00:00.000Z');
    const refresh = xtream.refreshLibrariesIfStale(['vod']);
    expect(await xtream.fetchLibraryIfNeverHeld('vod')).toBe(false);
    await refresh;
    expect(log).toEqual(['vod']);
  });

  it('pauses a refresh only of a library held already: one never held is what a page waits for (card 38)', async () => {
    const { xtream, log, indexed } = setup();
    indexed.set('vod', '2026-11-20T10:00:00.000Z');
    await xtream.refreshLibrariesIfStale(['vod', 'series'], () => false, async () => undefined);
    expect(log).toEqual(['vod pauses', 'vod', 'series']);
  });
});
