import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Account } from '@shared/types';
import { AccountService } from './account.service';
import { AccountKeysService } from './account-keys.service';
import { GuideService } from './guide.service';
import { GuideSourcesService, guideAddressProblem, guideName } from './guide-sources.service';
import { setCurrentLanguage, t } from '../utils/i18n';
import { LocalUserDataService } from './local-user-data.service';
import { ProviderAccessService } from './provider-access.service';

/**
 * Guides arriving from the account's other devices, and what happens when one
 * of them cannot be opened.
 *
 * This exists because of a fault found on the real account, on the first
 * device ever to sign in to it fresh. Two guides sat on the service sealed
 * under a key no device had any more -- an account's key changes when it is
 * enrolled, or when its password is -- and nothing noticed for a week, because
 * every device that had them kept its own readable copy and never needed to
 * open the one on the service. The new phone got the hand-made channel
 * mappings, which travel in the clear, and none of the guides they point at.
 */

const ACCOUNT: Account = { id: 1, username: 'AnaMaria', createdAt: '2026-08-30T10:00:00.000Z' };

const FEED = 'https://epgshare01.online/epgshare01/epg_ripper_HR1.xml.gz';

/** What this device holds, in the clear, as the desktop did. */
const held = () =>
  JSON.stringify({
    sources: [
      {
        id: 'src-a',
        label: 'Croatian channels',
        url: FEED,
        enabled: true,
        addedAt: '2026-08-30T10:00:00.000Z',
        updatedAt: '2026-08-30T10:00:00.000Z'
      }
    ],
    mappings: {}
  });

/** A change carrying ciphertext this device's key will not open. */
const unreadable = {
  id: 'src-a',
  payload: 'sb1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA',
  updatedAt: '2026-08-30T11:00:00.000Z'
};

describe('GuideSourcesService', () => {
  const account = signal<Account | null>(ACCOUNT);

  let keys: { open: jest.Mock; seal: jest.Mock };
  let local: { queueGuideSource: jest.Mock; queueChannelMapping: jest.Mock };

  const build = (): GuideSourcesService => {
    keys = {
      // What a key that cannot open something answers: null, not a throw.
      open: jest.fn().mockResolvedValue(null),
      seal: jest.fn().mockResolvedValue('sb1$resealed')
    };

    local = {
      queueGuideSource: jest.fn(),
      queueChannelMapping: jest.fn()
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: AccountService, useValue: { account, storageName: () => account()?.username, localProfile: { active: () => false } } },
        { provide: AccountKeysService, useValue: keys },
        { provide: LocalUserDataService, useValue: local },
        { provide: GuideService, useValue: { missing: async () => [] } },
        { provide: ProviderAccessService, useValue: { direct: async () => null } }
      ]
    });

    return TestBed.inject(GuideSourcesService);
  };

  beforeEach(() => {
    localStorage.clear();
    account.set(ACCOUNT);
  });

  describe('a guide that will not open', () => {
    it('is sent back, sealed under the key this device has now', async () => {
      localStorage.setItem('xtream_guide_sources:anamaria', held());
      const service = build();

      await service.applyIncoming({ guideSources: [unreadable] });

      expect(keys.seal).toHaveBeenCalled();
      expect(local.queueGuideSource).toHaveBeenCalledWith(
        'src-a',
        'sb1$resealed',
        expect.any(String)
      );
    });

    it('is sent back stamped later than the copy it replaces', async () => {
      // Reconciliation is last-write-wins, so a repair carrying the original
      // stamp would lose to the unreadable copy it is meant to mend.
      localStorage.setItem('xtream_guide_sources:anamaria', held());
      const service = build();

      await service.applyIncoming({ guideSources: [unreadable] });

      const [, , stamp] = local.queueGuideSource.mock.calls[0];
      expect(stamp > unreadable.updatedAt).toBe(true);
    });

    it('is mended once, however often it arrives', async () => {
      // A device whose own key is the stale one would otherwise answer every
      // unreadable copy with another unreadable copy, for as long as it ran.
      localStorage.setItem('xtream_guide_sources:anamaria', held());
      const service = build();

      await service.applyIncoming({ guideSources: [unreadable] });
      await service.applyIncoming({ guideSources: [unreadable] });

      expect(local.queueGuideSource).toHaveBeenCalledTimes(1);
    });

    it('is left alone by a device that has not got it', async () => {
      // The ordinary case on a phone signing in for the first time: nothing to
      // mend it with, and sending anything would be inventing a guide.
      const service = build();

      await service.applyIncoming({ guideSources: [unreadable] });

      expect(local.queueGuideSource).not.toHaveBeenCalled();
      expect(service.sources()).toEqual([]);
    });
  });

  describe('looking over what the service holds', () => {
    it('mends one that cannot be opened, without being sent it as a change', async () => {
      // The gap that made the fault survive a fix. A guide sealed under a dead
      // key never changes, so it is never in a window any device asks for --
      // and the only machine that can mend it synced past it long ago.
      localStorage.setItem('xtream_guide_sources:anamaria', held());
      const service = build();

      await service.repairUnreadable([unreadable]);

      expect(local.queueGuideSource).toHaveBeenCalledWith(
        'src-a',
        'sb1$resealed',
        expect.any(String)
      );
    });

    it('leaves alone the ones that open', async () => {
      localStorage.setItem('xtream_guide_sources:anamaria', held());
      const service = build();
      keys.open.mockResolvedValue(JSON.stringify({ label: 'Fine', url: FEED, enabled: true }));

      await service.repairUnreadable([unreadable]);

      expect(local.queueGuideSource).not.toHaveBeenCalled();
    });
  });

  describe('a guide that opens', () => {
    it('is folded in and not sent back', async () => {
      const service = build();
      keys.open.mockResolvedValue(
        JSON.stringify({ label: 'From elsewhere', url: FEED, enabled: true })
      );

      await service.applyIncoming({ guideSources: [{ ...unreadable, id: 'src-b' }] });

      expect(service.sources().map(source => source.label)).toEqual(['From elsewhere']);
      expect(local.queueGuideSource).not.toHaveBeenCalled();
    });
  });

  describe("a provider's own guide, when the provider is added", () => {
    const MAIN = 'http://main.example/xmltv.php?username=u&password=p';
    const SECOND = 'http://second.example/epg.xml';
    const scope = signal<'full' | 'setup'>('full');
    let load: jest.Mock;

    const buildWithProviders = (): GuideSourcesService => {
      load = jest.fn().mockResolvedValue({});
      local = { queueGuideSource: jest.fn(), queueChannelMapping: jest.fn() };
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: AccountService, useValue: { account, profileScope: scope, storageName: () => account()?.username, localProfile: { active: () => false } } },
          { provide: AccountKeysService, useValue: { open: jest.fn(), seal: jest.fn().mockResolvedValue('sb1$sealed') } },
          { provide: LocalUserDataService, useValue: local },
          { provide: GuideService, useValue: { missing: async () => [], load, willLoad: jest.fn(), wontLoad: jest.fn() } },
          {
            provide: ProviderAccessService,
            useValue: {
              direct: async () => ({
                slots: [
                  { tag: '', record: { label: 'Main' }, xtream: { guideUrl: () => MAIN } },
                  { tag: 'p2', record: { label: 'Second' }, m3u: { guideUrls: async () => [SECOND] } }
                ]
              })
            }
          }
        ]
      });
      return TestBed.inject(GuideSourcesService);
    };

    beforeEach(() => scope.set('full'));

    it('is added, and loaded on this device', async () => {
      const service = buildWithProviders();

      expect(await service.addGuidesOf('p2')).toBe(1);
      expect(service.sources().map(source => source.url)).toEqual([SECOND]);
      await Promise.resolve();
      expect(load).toHaveBeenCalledWith(expect.any(String), SECOND);
    });

    it('is not added twice', async () => {
      const service = buildWithProviders();
      await service.addGuidesOf('');

      expect(await service.addGuidesOf('')).toBe(0);
      expect(service.sources()).toHaveLength(1);
    });

    it("is only that provider's: another's removed guide stays removed", async () => {
      const service = buildWithProviders();

      await service.addGuidesOf('p2');
      expect(service.sources().some(source => source.url === MAIN)).toBe(false);
    });

    it("in a family member's setup is added for Save & Close, and not downloaded here", async () => {
      scope.set('setup');
      const service = buildWithProviders();

      expect(await service.addGuidesOf('')).toBe(1);
      await Promise.resolve();
      expect(load).not.toHaveBeenCalled();
    });
  });

  describe("the account's guides, on a device that has just signed in", () => {
    // 12 November: a new desktop had the account's history and favourites,
    // and no guide at all -- the guides were only offered.
    const scope = signal<'full' | 'setup'>('full');
    let load: jest.Mock;
    let willLoad: jest.Mock;
    let wontLoad: jest.Mock;
    let absent: string[];

    const buildNew = (): GuideSourcesService => {
      load = jest.fn().mockImplementation(async (id: string) => {
        absent = absent.filter(one => one !== id);
        return {};
      });
      willLoad = jest.fn();
      wontLoad = jest.fn();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: AccountService, useValue: { account, profileScope: scope, storageName: () => account()?.username, localProfile: { active: () => false } } },
          { provide: AccountKeysService, useValue: { open: jest.fn(), seal: jest.fn() } },
          { provide: LocalUserDataService, useValue: { queueGuideSource: jest.fn(), queueChannelMapping: jest.fn() } },
          { provide: GuideService, useValue: { supported: true, isLoading: () => false, missing: async (ids: string[]) => ids.filter(id => absent.includes(id)), load, willLoad, wontLoad } },
          { provide: ProviderAccessService, useValue: { direct: async () => null } }
        ]
      });
      return TestBed.inject(GuideSourcesService);
    };

    beforeEach(() => {
      scope.set('full');
      absent = ['src-a'];
      localStorage.setItem('xtream_guide_sources:anamaria', held());
    });

    it('are downloaded here', async () => {
      const service = buildNew();

      await service.loadFirstTimeHere();

      expect(load).toHaveBeenCalledWith('src-a', FEED);
      expect(service.missingHere()).toEqual([]);
    });

    it('are queued for the activity notice, and let go once done', async () => {
      await buildNew().loadFirstTimeHere();

      expect(willLoad).toHaveBeenCalledWith(['src-a']);
      expect(wontLoad).toHaveBeenCalledWith(['src-a']);
    });

    it('say one is coming from the end of the first pull until they are done', async () => {
      const service = buildNew();
      let applied!: () => void;
      const ready = new Promise<void>(resolve => (applied = resolve));

      const loading = service.loadFirstTimeHereAfter(ready);
      expect(service.firstLoadsComing()).toBe(true);
      applied();
      await loading;

      expect(load).toHaveBeenCalledWith('src-a', FEED);
      expect(service.firstLoadsComing()).toBe(false);
    });

    it('are not downloaded again when already here', async () => {
      absent = [];
      await buildNew().loadFirstTimeHere();

      expect(load).not.toHaveBeenCalled();
    });

    it('leave one this device had and lost to the reloader', async () => {
      // GuideReloadService's case (guide-loaded-here.ts), with its own limits.
      localStorage.setItem('xtream_guide_loaded_here:src-a', '2026-11-01T00:00:00.000Z');
      await buildNew().loadFirstTimeHere();

      expect(load).not.toHaveBeenCalled();
    });

    it("are not downloaded in a family member's setup", async () => {
      scope.set('setup');
      await buildNew().loadFirstTimeHere();

      expect(load).not.toHaveBeenCalled();
    });
  });
});

describe('guideName', () => {
  afterEach(() => setCurrentLanguage('en'));

  it('still names a guide added under the old Croatian label, in the language in use', () => {
    expect(guideName('EPG Share · Croatia')).toBe('EPG Share · Croatia');
    setCurrentLanguage('hr');
    expect(guideName('EPG Share · Croatia')).toBe('EPG Share · Hrvatska');
  });

  it("names any country's EPG Share guide in the language in use", () => {
    setCurrentLanguage('de');
    expect(guideName('EPG Share · United Kingdom')).toBe('EPG Share · Vereinigtes Königreich');
  });

  it('shows a name somebody typed as typed', () => {
    setCurrentLanguage('de');
    expect(guideName('EPG Share')).toBe('EPG Share');
    expect(guideName('EPG Share · Atlantis')).toBe('EPG Share · Atlantis');
  });
});

describe('guideAddressProblem', () => {
  it('asks for an address, and refuses one that is not a web address, in the Guides page words', () => {
    expect(guideAddressProblem('  ')).toBe(t('guides.enterAddress'));
    expect(guideAddressProblem('epg.xml')).toBe(t('guides.notAnAddress'));
    expect(guideAddressProblem(' https://example.com/epg.xml.gz ')).toBeNull();
  });
});
