import { TestBed } from '@angular/core/testing';
import { AppUpdateService } from './app-update.service';
import { PlatformService } from './platform.service';
import { TvNavigationService } from './tv-navigation.service';
import { WEB_UPDATE_PLUGIN } from './native/webUpdate';

/**
 * Which update notice the shell shows when the app and the web code are both
 * newer: one at a time, the app's first, since installing it throws away a
 * web update already downloaded.
 */
describe('AppUpdateService, beside a web update', () => {
  let service: AppUpdateService;
  const app = { version: '1.0.122', file: 'xtream-1.0.122.apk', sha256: 'a'.repeat(64), size: 1 };

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        { provide: PlatformService, useValue: { platform: 'android' } },
        { provide: WEB_UPDATE_PLUGIN, useValue: {} },
        { provide: TvNavigationService, useValue: {} }
      ]
    });
    service = TestBed.inject(AppUpdateService);
  });

  it('holds the web update back while the newer app is offered, whichever is newer', () => {
    expect(service.holdsBackWebUpdate()).toBe(false);

    service.available.set(app);

    expect(service.holdsBackWebUpdate()).toBe(true);
  });

  it('lets the web update through once the app is put off', () => {
    service.available.set(app);

    service.later();

    expect(service.showing()).toBe(false);
    expect(service.holdsBackWebUpdate()).toBe(false);
  });
});
