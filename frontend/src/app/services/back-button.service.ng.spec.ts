import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { App } from '@capacitor/app';
import { BackButtonService } from './back-button.service';

/**
 * Android's Back, once nothing is open: where it goes, and when it leaves.
 *
 * The phone walk found Back on For You stepping back through whichever tabs had
 * been visited instead of leaving the app, which is what Back on an app's first
 * screen does everywhere else.
 */

let pressBack: (event: { canGoBack: boolean }) => void = () => undefined;

jest.mock('@capacitor/app', () => ({
  App: {
    addListener: jest.fn((_name: string, handler: (event: { canGoBack: boolean }) => void) => {
      pressBack = handler;
      return Promise.resolve({ remove: () => undefined });
    }),
    exitApp: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: (): boolean => true }
}));

describe('BackButtonService', () => {
  let location: { path: jest.Mock; back: jest.Mock; getState: jest.Mock };

  const at = (path: string, navigationId = 1): BackButtonService => {
    location = { path: jest.fn().mockReturnValue(path), back: jest.fn(), getState: jest.fn().mockReturnValue({ navigationId }) };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: Location, useValue: location }] });
    const service = TestBed.inject(BackButtonService);
    service.install();
    return service;
  };

  beforeEach(() => (App.exitApp as jest.Mock).mockClear());

  it('leaves the app from For You, whatever was visited before it', () => {
    at('/for-you');

    pressBack({ canGoBack: true });

    expect(App.exitApp).toHaveBeenCalled();
    expect(location.back).not.toHaveBeenCalled();
  });

  it('goes back a screen from anywhere else', () => {
    at('/movies');

    pressBack({ canGoBack: true });

    expect(location.back).toHaveBeenCalled();
    expect(App.exitApp).not.toHaveBeenCalled();
  });

  // After a film played from its page, by way of Movies, the WebView said
  // there was no going back and Back on the film's page closed the app
  // (29 October).
  it('goes back when the app opened a page before this one, whatever the WebView says', () => {
    at('/film/s2000', 4);

    pressBack({ canGoBack: false });

    expect(location.back).toHaveBeenCalled();
    expect(App.exitApp).not.toHaveBeenCalled();
  });

  it('leaves from a page the app opened first, with nothing before it', () => {
    at('/movies', 1);

    pressBack({ canGoBack: false });

    expect(App.exitApp).toHaveBeenCalled();
  });

  it('closes what is open before anything else, on For You too', () => {
    const service = at('/for-you');
    const close = jest.fn();
    service.whileOpen(close);

    pressBack({ canGoBack: true });

    expect(close).toHaveBeenCalled();
    expect(App.exitApp).not.toHaveBeenCalled();
  });
});
