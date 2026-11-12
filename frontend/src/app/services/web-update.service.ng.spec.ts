import { TestBed } from '@angular/core/testing';
import { API_URL } from './api-url';
import { PlatformService } from './platform.service';
import { WEB_UPDATE_PLUGIN, WebBundleState, WebUpdatePlugin } from './native/webUpdate';
import { WebUpdateService } from './web-update.service';
import { NativePlayerService } from './native-player.service';
import { signal } from '@angular/core';
import { App } from '@capacitor/app';

jest.mock('@capacitor/app', () => ({
  App: {
    exitApp: jest.fn().mockResolvedValue(undefined),
    addListener: jest.fn().mockResolvedValue({ remove: jest.fn() })
  }
}));

/**
 * The phone deciding whether to replace its own code.
 *
 * The rules themselves are tested in `utils/web-update.utils.spec.ts`. What is
 * tested here is the wiring around them, which is where this app's silent
 * faults have always been: a service that is never constructed, a plugin that
 * is absent from a build, a failure that is reported as a success because
 * something adjacent moved.
 */

// The build's own server, as config.js names it; the account is on another,
// somebody's own, which has no builds to give.
const API = 'https://sync.example/api';
const OWN_SERVER = 'https://my-own.example/api';

const STATE: WebBundleState = {
  version: '1.0.0',
  app: '1.0.0',
  downloaded: false,
  refused: null
};

const MANIFEST = {
  version: '1.1.0',
  file: 'xtream-web-1.1.0.zip',
  sha256: 'a'.repeat(64),
  minNative: '1.0.0'
};

describe('WebUpdateService', () => {
  let plugin: jest.Mocked<WebUpdatePlugin>;
  let fetched: jest.Mock;
  const playing = signal(false);

  const build = (platform = 'android', state: WebBundleState = STATE): WebUpdateService => {
    plugin = {
      state: jest.fn().mockResolvedValue(state),
      download: jest.fn().mockResolvedValue({ version: MANIFEST.version }),
      confirm: jest.fn().mockResolvedValue(undefined),
      forget: jest.fn().mockResolvedValue(undefined),
      restart: jest.fn().mockResolvedValue(undefined)
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PlatformService, useValue: { platform } },
        { provide: API_URL, useValue: () => OWN_SERVER },
        { provide: WEB_UPDATE_PLUGIN, useValue: plugin },
        { provide: NativePlayerService, useValue: { active: playing } }
      ]
    });

    return TestBed.inject(WebUpdateService);
  };

  const publishes = (body: unknown, ok = true) => {
    fetched = jest.fn().mockResolvedValue({ ok, json: async () => body });
    globalThis.fetch = fetched as unknown as typeof fetch;
  };

  beforeEach(() => {
    (window as { __XTREAM_API_URL__?: string }).__XTREAM_API_URL__ = API;
    publishes(MANIFEST);
  });
  afterEach(() => delete (window as { __XTREAM_API_URL__?: string }).__XTREAM_API_URL__);

  describe('the feed config.js names', () => {
    afterEach(() => delete (window as { __TVINTO_UPDATES_URL__?: string }).__TVINTO_UPDATES_URL__);

    it('is asked instead of the server, and a file named by its address is fetched from there', async () => {
      (window as { __TVINTO_UPDATES_URL__?: string }).__TVINTO_UPDATES_URL__ = 'https://github.com/tvinto/tvinto/releases/download/feed';
      const address = 'https://github.com/tvinto/tvinto/releases/download/web-1.1.0/tvinto-web-1.1.0.zip';
      publishes({ ...MANIFEST, file: address });
      const service = build();

      await service.check();

      expect(fetched).toHaveBeenCalledWith('https://github.com/tvinto/tvinto/releases/download/feed/android-latest.json', expect.anything());
      expect(plugin.download).toHaveBeenCalledWith({ url: address, version: '1.1.0', sha256: MANIFEST.sha256 });
    });
  });

  describe('taking a bundle', () => {
    it('downloads a newer one from the build’s own server, not the one the account is on', async () => {
      const service = build();

      await service.check();

      expect(fetched).toHaveBeenCalledWith(
        'https://sync.example/updates/android-latest.json',
        expect.anything()
      );
      expect(plugin.download).toHaveBeenCalledWith({
        url: 'https://sync.example/updates/xtream-web-1.1.0.zip',
        version: '1.1.0',
        sha256: MANIFEST.sha256
      });
    });

    it('says which version is waiting, and does not pretend it is running', async () => {
      // Unpacked, not in use. Nothing is swapped underneath an open app.
      const service = build();

      await service.check();

      expect(service.waiting()).toBe('1.1.0');
      expect(service.state()?.version).toBe('1.0.0');
    });

    it('leaves a bundle that is not newer alone', async () => {
      const service = build('android', { ...STATE, version: '1.1.0' });

      await service.check();

      expect(plugin.download).not.toHaveBeenCalled();
    });

    it('refuses one that needs an APK this phone has not got', async () => {
      publishes({ ...MANIFEST, minNative: '2.0.0' });
      const service = build();

      await service.check();

      expect(plugin.download).not.toHaveBeenCalled();
    });

    it('refuses a manifest that is not one', async () => {
      // What a captive portal answers with, and what a hand-edited file looks
      // like after a bad edit.
      publishes({ version: 'latest' });
      const service = build();

      await service.check();

      expect(plugin.download).not.toHaveBeenCalled();
    });
  });

  describe('when things are not there', () => {
    it('does nothing whatever in a browser', async () => {
      const service = build('browser');

      service.start();
      await service.check();

      // Not "does not download" -- does not ask. A browser has no plugin, and
      // calling one would reject in the console on every launch.
      expect(plugin.state).not.toHaveBeenCalled();
    });

    it('survives an APK built before the plugin existed', async () => {
      const service = build();
      plugin.state.mockRejectedValue(new Error('no such plugin'));

      await expect(service.check()).resolves.toBeUndefined();
      expect(plugin.download).not.toHaveBeenCalled();
    });

    it('survives having nowhere to ask', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
      const service = build();

      await expect(service.check()).resolves.toBeUndefined();
      expect(plugin.download).not.toHaveBeenCalled();
    });

    it('survives a download that fails, and does not claim one is waiting', async () => {
      const service = build();
      plugin.download.mockRejectedValue(new Error('the network went away'));

      await service.check();

      expect(service.waiting()).toBeNull();
    });
  });

  describe('showing an update and restarting into it', () => {
    it('says which version is downloading while it downloads, and nothing after', async () => {
      const service = build();
      let during: string | null = null;
      plugin.download.mockImplementation(async () => {
        during = service.downloading();
        return { version: MANIFEST.version };
      });

      await service.check();

      expect(during).toBe('1.1.0');
      expect(service.downloading()).toBeNull();
    });

    it('treats a bundle downloaded on an earlier run as waiting', async () => {
      publishes({ ...MANIFEST, version: '1.0.0' });
      const service = build('android', { ...STATE, pending: '1.0.9' });

      await service.check();

      expect(service.waiting()).toBe('1.0.9');
    });

    it('restarts in place where the APK can', async () => {
      const service = build();

      await service.restart();

      expect(plugin.restart).toHaveBeenCalled();
      expect(App.exitApp).not.toHaveBeenCalled();
    });

    it('closes the app where the APK cannot restart it', async () => {
      const service = build();
      plugin.restart.mockRejectedValue(new Error('not implemented'));

      await service.restart();

      expect(App.exitApp).toHaveBeenCalled();
    });
  });

  describe('a television that never closes the app', () => {
    /** The listener the service gave Capacitor for the app going and coming back. */
    const appState = () =>
      (App.addListener as jest.Mock).mock.calls.filter(([event]) => event === 'appStateChange').pop()?.[1] as (
        state: { isActive: boolean }
      ) => Promise<void>;

    beforeEach(() => {
      jest.useFakeTimers();
      playing.set(false);
      (App.addListener as jest.Mock).mockClear();
    });
    afterEach(() => jest.useRealTimers());

    it('takes a waiting update on coming back after a while away', async () => {
      const service = build('android', { ...STATE, pending: '1.1.0' });
      service.start();
      await service.check();

      await appState()({ isActive: false });
      jest.advanceTimersByTime(20 * 60 * 1000);
      await appState()({ isActive: true });

      expect(plugin.restart).toHaveBeenCalled();
    });

    it('does not restart when it was only the app\'s own player that had the screen', async () => {
      const service = build('android', { ...STATE, pending: '1.1.0' });
      service.start();
      await service.check();

      playing.set(true);
      await appState()({ isActive: false });
      playing.set(false);
      jest.advanceTimersByTime(20 * 60 * 1000);
      // Pressed something since the player closed, so it is in use, not idle.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      await appState()({ isActive: true });

      expect(plugin.restart).not.toHaveBeenCalled();
    });

    it('asks often, not every six hours', async () => {
      const service = build();
      service.start();
      fetched.mockClear();

      jest.advanceTimersByTime(31 * 60 * 1000);
      await Promise.resolve();

      expect(fetched).toHaveBeenCalled();
    });
  });

  describe('saying that a bundle started', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('waits before confirming, because loading is not working', async () => {
      const service = build();

      service.start();
      expect(plugin.confirm).not.toHaveBeenCalled();

      jest.advanceTimersByTime(20_000);
      await Promise.resolve();

      expect(plugin.confirm).toHaveBeenCalled();
    });

    it('starts once however often it is asked', () => {
      const service = build();

      service.start();
      service.start();
      jest.advanceTimersByTime(20_000);

      expect(plugin.confirm).toHaveBeenCalledTimes(1);
    });
  });
});
