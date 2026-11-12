import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DesktopUpdateService } from './desktop-update.service';
import { GuideService } from './guide.service';
import { NativePlayerService } from './native-player.service';

/**
 * The page's half of installing a desktop update.
 *
 * The rule for when the desktop installs by itself is tested beside it, in
 * `electron/src/installWhen.spec.ts`. What is tested here is what the main
 * process cannot see: that the page tells it about a film or a guide download
 * an idle restart would spoil, and that an update downloaded before the page
 * was listening is still offered.
 */
describe('DesktopUpdateService', () => {
  let loading: ReturnType<typeof signal<boolean>>;
  let bridge: {
    ready: jest.Mock;
    onReady: jest.Mock;
    install: jest.Mock;
    setBusy: jest.Mock;
  };

  const build = (withBridge = true): DesktopUpdateService => {
    loading = signal(false);
    bridge = {
      ready: jest.fn().mockResolvedValue(null),
      onReady: jest.fn(),
      install: jest.fn().mockResolvedValue(true),
      setBusy: jest.fn()
    };
    (window as { xtreamDesktop?: unknown }).xtreamDesktop = withBridge ? { updates: bridge } : undefined;

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: GuideService, useValue: { isLoading: loading } },
        { provide: NativePlayerService, useValue: { active: signal(false) } }
      ]
    });
    return TestBed.inject(DesktopUpdateService);
  };

  afterEach(() => {
    delete (window as { xtreamDesktop?: unknown }).xtreamDesktop;
    document.body.innerHTML = '';
    jest.useRealTimers();
  });

  it('offers an update that downloaded before the page was listening', async () => {
    const service = build();
    bridge.ready.mockResolvedValue('1.0.15');

    service.start();
    await Promise.resolve();

    expect(service.ready()).toBe('1.0.15');
  });

  it('offers an update that downloads while the page is open', () => {
    const service = build();
    service.start();

    bridge.onReady.mock.calls[0][0]('1.0.16');

    expect(service.ready()).toBe('1.0.16');
  });

  it('tells the desktop at once when a guide starts loading, and when it stops', () => {
    const service = build();
    service.start();
    expect(bridge.setBusy).toHaveBeenLastCalledWith(null);

    loading.set(true);
    TestBed.tick();
    expect(bridge.setBusy).toHaveBeenLastCalledWith('loading a guide');

    loading.set(false);
    TestBed.tick();
    expect(bridge.setBusy).toHaveBeenLastCalledWith(null);
  });

  // Idle is measured from the last key press, and a paused film is exactly
  // what a machine nobody is using looks like.
  it('counts a paused film in the page player as busy', () => {
    const service = build();
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentSrc', { value: 'blob:film' });
    Object.defineProperty(video, 'ended', { value: false });
    document.body.appendChild(video);

    expect(service.busy()).toBe('something is open to watch');
  });

  it('does not repeat itself to the desktop', () => {
    jest.useFakeTimers();
    const service = build();
    service.start();

    jest.advanceTimersByTime(5 * 60 * 1000);

    expect(bridge.setBusy).toHaveBeenCalledTimes(1);
  });

  it('restarts into the update when asked, once', async () => {
    const service = build();
    service.start();

    await Promise.all([service.restart(), service.restart()]);

    expect(bridge.install).toHaveBeenCalledTimes(1);
    expect(service.installing()).toBe(true);
  });

  it('does nothing outside the desktop app', () => {
    const service = build(false);

    service.start();

    expect(service.ready()).toBeNull();
  });
});
