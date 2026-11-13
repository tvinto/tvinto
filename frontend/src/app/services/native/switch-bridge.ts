import { ChannelDirectory, NativePlayer, SwitchStreamRequest } from './nativePlayer';
import { ChannelBanner } from '../../utils/player-banner.utils';
import { osdBanner, osdGaveUp, osdSwitching } from '../../utils/mpv-osd.utils';

/**
 * How the service talks to a player that changes channel inside itself.
 *
 * Two players answer to it: Android's, which draws its own panels from the
 * fields it is given (ChannelSession.java), and mpv on the desktop, which can
 * only show text -- so its bridge writes the lines (PL-D-1) and hands mpv
 * those. What to do is decided above both, in `nextSwitch`.
 */
export interface SwitchBridge {
  listen(handlers: SwitchHandlers): Promise<() => void>;
  switchStream(request: SwitchStreamRequest): Promise<void>;
  updateBanner(options: { itemId: string; banner: ChannelBanner }): Promise<void>;
  giveUp(options: { backTo: string }): Promise<void>;
  closePlayer(): Promise<void>;
  /** For number entry and the mini guide; mpv has neither. */
  setChannels(directory: ChannelDirectory): Promise<void>;
}

export interface SwitchHandlers {
  requested(event: { step: 'next' | 'previous' | 'last' | 'cancel' | 'jump'; to?: string; itemId: string; started: boolean }): void;
  started(): void;
  failed(event: { errorCode: string }): void;
}

export const androidBridge: SwitchBridge = {
  async listen(handlers) {
    const handles = await Promise.all([
      NativePlayer.addListener('channelRequested', event => handlers.requested(event)),
      NativePlayer.addListener('channelStarted', () => handlers.started()),
      NativePlayer.addListener('switchFailed', event => handlers.failed(event))
    ]);
    return () => handles.forEach(handle => void handle.remove());
  },
  switchStream: request => NativePlayer.switchStream(request),
  updateBanner: options => NativePlayer.updateBanner(options),
  giveUp: options => NativePlayer.giveUp(options),
  closePlayer: () => NativePlayer.closePlayer(),
  setChannels: directory => NativePlayer.setChannels(directory)
};

/** What the Electron preload offers for this (electron/src/preload.ts). */
export interface DesktopPlayerBridge {
  onEvent(listener: (event: DesktopPlayerEvent) => void): () => void;
  command(command: Record<string, unknown>): Promise<void>;
}

type DesktopPlayerEvent =
  | { type: 'channelRequested'; step: 'next' | 'previous' | 'last' | 'cancel'; itemId: string; started: boolean }
  | { type: 'channelStarted'; itemId: string }
  | { type: 'switchFailed'; itemId: string; errorCode: string }
  | { type: 'bannerRequested'; itemId: string }
  | { type: 'progress'; positionSeconds: number; durationSeconds: number };

/** How long the banner stays on mpv's screen, as on a television. */
const BANNER_MS = 4000;

/**
 * mpv's bridge. It remembers what it last said about the channel on screen, so
 * that the picture arriving, or `i`, can say it again with the time as it is
 * then -- "23 min left" is only true for a minute.
 */
export const desktopBridge = (
  player: DesktopPlayerBridge,
  first: { itemId: string; number: string; name: string; banner?: ChannelBanner },
  /**
   * The page's own banner (PX-TV-6), when the page draws the player
   * (tvinto-player): true when it showed it, and mpv is then told nothing.
   */
  inPage?: (channel: { number: string; name: string; banner: ChannelBanner | null }) => boolean
): SwitchBridge => {
  let current = { ...first, banner: first.banner ?? null };
  let lastSwitch: SwitchStreamRequest | null = null;

  const showBanner = async () => {
    if (inPage?.(current)) {
      return;
    }
    await player.command({ kind: 'text', text: osdBanner(current, current.banner, Date.now()), ms: BANNER_MS });
  };

  return {
    async listen(handlers) {
      return player.onEvent(event => {
        switch (event.type) {
          case 'channelRequested':
            handlers.requested(event);
            return;
          case 'channelStarted':
            void showBanner();
            handlers.started();
            return;
          case 'switchFailed':
            handlers.failed(event);
            return;
          case 'bannerRequested':
            void showBanner();
            return;
        }
      });
    },
    async switchStream(request) {
      lastSwitch = request;
      current = { itemId: request.itemId, number: request.channelNumber, name: request.channelName, banner: request.banner };
      await player.command({
        kind: 'switch',
        url: request.url,
        itemId: request.itemId,
        waitMs: request.waitMs,
        text: osdSwitching(current, request.attempt === 1 ? request.from : request.back, request.attempt)
      });
    },
    async updateBanner(options) {
      if (options.itemId === current.itemId) {
        current = { ...current, banner: options.banner };
      }
    },
    async giveUp(options) {
      await player.command({ kind: 'giveUp', text: osdGaveUp(lastSwitch ? current : first, options.backTo) });
    },
    closePlayer: () => player.command({ kind: 'close' }),
    setChannels: async () => undefined
  };
};
