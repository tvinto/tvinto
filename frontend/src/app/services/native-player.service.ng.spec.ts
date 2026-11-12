import { TestBed } from '@angular/core/testing';
import { NativePlayerService, PlaybackCheckpoint } from './native-player.service';
import { PlatformService } from './platform.service';
import { PlayerPreferencesService } from './player-preferences.service';
import { SubtitleLibraryService } from './subtitle-library.service';
import { LocalUserDataService } from './local-user-data.service';
import { NativePlayer, PlaybackProgressEvent } from './native/nativePlayer';
import { PLAYING_KEY } from '../utils/playback-checkpoint.utils';

jest.mock('./native/nativePlayer', () => ({
  NativePlayer: { play: jest.fn(), addListener: jest.fn(), takeUnfinished: jest.fn() }
}));

/**
 * A film's position saved while it plays, and after a player that never
 * closed (PlaybackCheckpoint): the record the page keeps, the positions
 * passed on, and what the next launch saves.
 */
describe('NativePlayerService, saving progress along the way', () => {
  const player = NativePlayer as jest.Mocked<typeof NativePlayer>;
  let service: NativePlayerService;
  let heard: ((event: PlaybackProgressEvent) => void) | null;
  const removed = jest.fn();

  const film = { type: 'vod' as const, itemId: 'f1', name: 'Dune (2021)', icon: null, containerExtension: 'mkv' };

  beforeEach(() => {
    localStorage.clear();
    heard = null;
    removed.mockClear();
    jest.clearAllMocks();
    player.addListener.mockImplementation(((_event: string, listener: (event: PlaybackProgressEvent) => void) => {
      heard = listener;
      return Promise.resolve({ remove: removed });
    }) as never);
    TestBed.configureTestingModule({
      providers: [
        { provide: PlatformService, useValue: { platform: 'android', hasNativePlayer: true } },
        { provide: PlayerPreferencesService, useValue: { preferences: () => ({}) } },
        { provide: SubtitleLibraryService, useValue: { saved: async () => [] } },
        { provide: LocalUserDataService, useValue: { enabled: false } }
      ]
    });
    service = TestBed.inject(NativePlayerService);
  });

  it('keeps what it plays on the device while the player is open, passes positions on, and clears up after', async () => {
    const reached: [string, number, number][] = [];
    const checkpoint: PlaybackCheckpoint = {
      entries: () => ({ f1: film }),
      reached: (...args) => reached.push(args)
    };
    let storedWhilePlaying: string | null = null;
    player.play.mockImplementation(async request => {
      storedWhilePlaying = localStorage.getItem(PLAYING_KEY);
      expect(request.reportProgress).toBe(true);
      expect(request.progressItemId).toBe('f1');
      heard?.({ itemId: 'f1', positionSeconds: 600, durationSeconds: 7200 });
      return { positionSeconds: 900, durationSeconds: 7200, played: true, errorCode: null };
    });

    await service.play({ url: 'http://x/f1.mkv', title: 'Dune', startAtSeconds: 0, item: { type: 'vod', id: 'f1' }, checkpoint });

    expect(JSON.parse(storedWhilePlaying!).entries).toEqual({ f1: film });
    expect(reached).toEqual([['f1', 600, 7200]]);
    expect(removed).toHaveBeenCalled();
    expect(localStorage.getItem(PLAYING_KEY)).toBeNull();
  });

  it('asks for nothing along the way for a play without a checkpoint', async () => {
    player.play.mockResolvedValue({ positionSeconds: 0, durationSeconds: 0, played: true, errorCode: null });

    await service.play({ url: 'http://x/live.ts', title: 'HRT 1', startAtSeconds: 0 });

    expect(player.play.mock.calls[0][0].reportProgress).toBe(false);
    expect(player.addListener).not.toHaveBeenCalledWith('progress', expect.anything());
  });

  it('passes on the positions the desktop player sends, for the item it was asked to play', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PlatformService, useValue: { platform: 'electron', hasNativePlayer: true } },
        { provide: PlayerPreferencesService, useValue: { preferences: () => ({}) } },
        { provide: SubtitleLibraryService, useValue: { saved: async () => [] } },
        { provide: LocalUserDataService, useValue: { enabled: false } }
      ]
    });
    const desktop = TestBed.inject(NativePlayerService);
    let fromMain: ((event: unknown) => void) | null = null;
    const asked: Record<string, unknown>[] = [];
    (window as { xtreamDesktop?: unknown }).xtreamDesktop = {
      player: { onEvent: (listener: (event: unknown) => void) => ((fromMain = listener), () => (fromMain = null)), command: async () => undefined },
      play: async (request: Record<string, unknown>) => {
        asked.push(request);
        fromMain?.({ type: 'progress', positionSeconds: 1800, durationSeconds: 7200 });
        return { positionSeconds: 1830, durationSeconds: 7200, played: true, errorCode: null };
      }
    };
    const reached: [string, number, number][] = [];

    await desktop.play({
      url: 'http://x/f1.mkv',
      title: 'Dune',
      startAtSeconds: 0,
      item: { type: 'vod', id: 'f1' },
      checkpoint: { entries: () => ({ f1: film }), reached: (...args) => reached.push(args) }
    });
    delete (window as { xtreamDesktop?: unknown }).xtreamDesktop;

    expect(asked[0]['reportProgress']).toBe(true);
    expect(reached).toEqual([['f1', 1800, 7200]]);
    expect(fromMain).toBeNull();
  });

  it('saves a viewing whose player never closed, once, at the next launch', async () => {
    localStorage.setItem(PLAYING_KEY, JSON.stringify({ at: 1_000, entries: { f1: film } }));
    player.takeUnfinished.mockResolvedValue({ itemId: 'f1', positionSeconds: 1800, durationSeconds: 7200, at: 2_000 });

    expect(await service.takeUnfinished()).toEqual({ ...film, positionSeconds: 1800, durationSeconds: 7200 });
    expect(localStorage.getItem(PLAYING_KEY)).toBeNull();

    player.takeUnfinished.mockResolvedValue({});
    expect(await service.takeUnfinished()).toBeNull();
  });
});
