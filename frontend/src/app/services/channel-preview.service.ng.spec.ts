import { TestBed } from '@angular/core/testing';
import { Observable, of } from 'rxjs';
import { Stream } from '@shared/types';

/**
 * The channel preview, TiviMate's way: OK plays a channel in it, and it goes
 * on playing; another channel lets the last one go first -- the provider
 * allows one connection.
 */
const mockNative = { show: jest.fn(async (_options: unknown) => undefined), hide: jest.fn(async () => undefined), move: jest.fn(async (_options: unknown) => undefined), addListener: jest.fn(async (_heard: (event: { state: string; detail: string }) => void) => ({ remove: async () => undefined })) };

jest.mock('@capacitor/core', () => {
  const actual = jest.requireActual('@capacitor/core');
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => true, isPluginAvailable: (name: string) => name === 'ChannelPreview' },
    registerPlugin: (name: string, ...rest: unknown[]) =>
      name === 'ChannelPreview'
        ? { show: (o: unknown) => mockNative.show(o), hide: () => mockNative.hide(), move: (o: unknown) => mockNative.move(o), addListener: (_event: string, heard: (event: { state: string; detail: string }) => void) => mockNative.addListener(heard) }
        : actual.registerPlugin(name, ...rest)
  };
});

import { ChannelPreviewService } from './channel-preview.service';
import { SettingsService } from './settings.service';
import { XtreamService } from './xtream.service';

describe('ChannelPreviewService', () => {
  const stream = (id: number) => ({ stream_id: String(id), name: `Channel ${id}` }) as unknown as Stream;
  const box = () => ({ left: 10, top: 20, width: 320, height: 180 }) as DOMRect;
  let asked: string[];

  const setup = (preview = 'on') => {
    asked = [];
    mockNative.show.mockClear();
    mockNative.hide.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsService, useValue: { get: () => preview, all: () => ({}), loaded: () => false } },
        {
          provide: XtreamService,
          useValue: {
            getPlaybackUrl: (_type: string, id: string) => {
              asked.push(id);
              return of(`http://provider/live/${id}.ts`);
            }
          }
        }
      ]
    });
    const made = TestBed.inject(ChannelPreviewService);
    // Made, it closes any preview a page before it left behind; not counted below.
    mockNative.hide.mockClear();
    return made;
  };

  it('plays the channel OK was pressed on, at once, in the box given', async () => {
    const preview = setup();
    await preview.start(stream(3), box);
    expect(asked).toEqual(['3']);
    expect(mockNative.show).toHaveBeenCalledTimes(1);
    expect(mockNative.show.mock.calls[0][0]).toEqual(expect.objectContaining({ url: 'http://provider/live/3.ts', width: 320, height: 180 }));
    expect(preview.showing(3)).toBe(true);
  });

  it('lets one channel go before the next plays, and opens the same one only once', async () => {
    const preview = setup();
    await preview.start(stream(1), box);
    await preview.start(stream(1), box);
    expect(mockNative.show).toHaveBeenCalledTimes(1);
    await preview.start(stream(2), box);
    expect(mockNative.hide).toHaveBeenCalledTimes(1);
    expect(mockNative.hide.mock.invocationCallOrder[0]).toBeLessThan(mockNative.show.mock.invocationCallOrder[1]);
    await preview.stop();
    expect(mockNative.hide).toHaveBeenCalledTimes(2);
    expect(preview.state()).toBe('idle');
  });

  it('plays on, on the channel it ended on, when the full player hands the stream back', async () => {
    mockNative.addListener.mockClear();
    const preview = setup();
    const heard = mockNative.addListener.mock.calls[0][0];
    preview.host();
    await preview.start(stream(1), box);
    heard({ state: 'taken', detail: '' });
    expect(preview.state()).toBe('idle');
    heard({ state: 'returned', detail: '4' });
    expect(preview.state()).toBe('playing');
    expect(preview.showing(4)).toBe(true);
    await preview.stop();
    expect(mockNative.hide).toHaveBeenCalledTimes(1);
  });

  // A user's TV, 22 October: the stream came back over For You and played on.
  it('lets a stream handed back go when no guide is showing the preview', async () => {
    mockNative.addListener.mockClear();
    const preview = setup();
    const heard = mockNative.addListener.mock.calls[0][0];
    const leave = preview.host();
    await preview.start(stream(1), box);
    heard({ state: 'taken', detail: '' });
    leave();
    heard({ state: 'returned', detail: '1' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(preview.state()).toBe('idle');
    expect(mockNative.hide).toHaveBeenCalled();
  });

  // A user's TV, 24 October: OK twice quickly opened the channel full
  // screen and the preview's copy behind it, which paused the full player.
  it('says a channel is only asked for until its stream reaches the window', async () => {
    const preview = setup();
    let answer!: (url: string) => void;
    TestBed.inject(XtreamService).getPlaybackUrl = () => new Observable<string>(seen => { answer = url => { seen.next(url); seen.complete(); }; });

    const started = preview.start(stream(5), box);
    await Promise.resolve();
    expect(preview.pending(5)).toBe(true);

    answer('http://provider/live/5.ts');
    await started;
    expect(preview.pending(5)).toBe(false);
    expect(preview.showing(5)).toBe(true);
  });

  // 23 November: a dead channel kept the preview black for ever, and OK only restarted it.
  it('says a channel that gave up has failed, and does not open it again here', async () => {
    mockNative.addListener.mockClear();
    const preview = setup();
    const heard = mockNative.addListener.mock.calls[0][0];
    await preview.start(stream(6), box);
    heard({ state: 'failed', detail: 'no picture in 20 s' });
    expect(preview.failed(6)).toBe(true);
    expect(preview.failed(7)).toBe(false);
    expect(preview.showing(6)).toBe(false);
    // The window has already let go; stopping asks nothing more of it.
    await preview.stop();
    expect(mockNative.hide).not.toHaveBeenCalled();
  });

  describe('when the box moves', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    // A user's TV, 24 October: the category list opened, the box moved
    // right, and the picture stayed where it had been, over the menu.
    it('moves the window with it, and plays on', async () => {
      const preview = setup();
      mockNative.move.mockClear();
      let where = { left: 10, top: 20, width: 320, height: 180 } as DOMRect;
      await preview.start(stream(1), () => where);

      where = { left: 500, top: 20, width: 320, height: 180 } as DOMRect;
      await jest.advanceTimersByTimeAsync(300);

      expect(mockNative.move).toHaveBeenCalledWith(expect.objectContaining({ x: 500, y: 20, width: 320, height: 180 }));
      expect(mockNative.hide).not.toHaveBeenCalled();
      await preview.stop();
    });

    it('lets the preview go when the box is gone, or the window cannot move', async () => {
      const preview = setup();
      let where: DOMRect | null = { left: 10, top: 20, width: 320, height: 180 } as DOMRect;
      await preview.start(stream(1), () => where);
      where = null;
      await jest.advanceTimersByTimeAsync(300);
      expect(preview.state()).toBe('idle');

      mockNative.hide.mockClear();
      mockNative.move.mockRejectedValueOnce(new Error('not implemented'));
      where = { left: 10, top: 20, width: 320, height: 180 } as DOMRect;
      await preview.start(stream(2), () => where);
      where = { left: 600, top: 20, width: 320, height: 180 } as DOMRect;
      await jest.advanceTimersByTimeAsync(300);
      expect(preview.state()).toBe('idle');
      expect(mockNative.hide).toHaveBeenCalled();
    });
  });

  it('does nothing when switched off on Account', async () => {
    const preview = setup('off');
    await preview.start(stream(1), box);
    expect(mockNative.show).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });
});
