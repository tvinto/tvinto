require('./rt/electron-rt');
//////////////////////////////
// User Defined Preload scripts below

const { contextBridge, ipcRenderer, webFrame } = require('electron');

/**
 * What the main process says, by channel: over the port it hands each page
 * (src/pageChannel.ts), or over plain IPC before it has. The listener gets
 * the arguments without IPC's event.
 */
type FromMain = (...args: never[]) => void;
const fromMain = new Map<string, Set<FromMain>>();
const onMain = (channel: string, listener: FromMain): (() => void) => {
  if (!fromMain.has(channel)) {
    fromMain.set(channel, new Set());
    ipcRenderer.on(channel, (_event: unknown, ...args: unknown[]) => fromMain.get(channel)?.forEach(one => one(...(args as never[]))));
  }
  fromMain.get(channel)!.add(listener);
  return () => fromMain.get(channel)?.delete(listener);
};
// The port the main process talks over (src/pageChannel.ts), made here and
// handed over: one it handed to a page reloaded mid-film never arrived.
{
  const channel = new MessageChannel();
  channel.port1.onmessage = (message: MessageEvent<{ channel: string; args: unknown[] }>) =>
    fromMain.get(message.data.channel)?.forEach(one => one(...(message.data.args as never[])));
  channel.port1.start();
  ipcRenderer.postMessage('xtream:page-channel', null, [channel.port2]);
}

/** Takes the picture away (the video surface, below). Replaced once it exists. */
let videoClosed: () => void = () => undefined;

/**
 * The one thing the desktop app can do that a browser cannot: play anything.
 *
 * Exposed through the context bridge rather than by opening Node to the page.
 * The renderer gets a single function that takes a request and resolves with a
 * position -- it cannot reach the file system, spawn anything, or name the
 * player. Everything about how playback happens stays in the main process.
 */
contextBridge.exposeInMainWorld('xtreamDesktop', {
  // The picture goes when the play ends, whatever else is said (videoClosed).
  play: (request: unknown) => ipcRenderer.invoke('xtream:play', request).finally(() => videoClosed()),

  /** The country the computer is set to ('HR'), or '' when it says none or the main process is older. */
  region: (() => {
    try {
      return String(ipcRenderer.sendSync('xtream:region') ?? '');
    } catch {
      return '';
    }
  })(),

  /**
   * Changing channel inside mpv: what the
   * player says while it plays, and what the page answers. Absent from a main
   * process older than this preload, which the page reads as "close to change
   * channel".
   */
  player: {
    onEvent: (listener: (event: unknown) => void) => {
      return onMain('xtream:player-event', (payload: unknown) => listener(payload));
    },
    command: (command: unknown) => ipcRenderer.invoke('xtream:player-command', command)
  },

  /**
   * The player the page draws while tvinto-player plays (src/videoState.ts):
   * its state a few times a second, and the controls' commands back.
   */
  video: {
    onState: (listener: (state: unknown) => void) => onMain('xtream:video-state', (state: unknown) => listener(state)),
    command: (command: unknown) => ipcRenderer.send('xtream:video-command', command)
  },

  /**
   * Fetching a subtitle file, which the page may not do itself: the link
   * OpenSubtitles hands back is on a host that allows no cross-origin request.
   */
  subtitles: {
    fetchText: (url: string, userAgent: string): Promise<string> =>
      ipcRenderer.invoke('xtream:fetch-subtitle', url, userAgent)
  },

  /**
   * A downloaded update, as far as the page needs to know about one: which
   * version is waiting, a way to restart into it, and a way for the page to
   * say it is in the middle of something an automatic restart would spoil.
   * Nothing here can choose what gets installed.
   */
  /**
   * The display size chosen on Account: the page's zoom, as Ctrl and plus
   * would set it, so fixed-pixel layout grows with the text.
   */
  display: {
    setZoom: (factor: number) => webFrame.setZoomFactor(Math.min(2, Math.max(0.5, Number(factor) || 1)))
  },

  /**
   * tvinto:// links the app was opened on (src/deepLinks.ts): `take` returns
   * those that came before the page was ready, `on` the ones after.
   */
  /** The project's own pages, in the person's browser (src/projectLinks.ts). */
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('xtream:open-external', url),

  deepLinks: {
    take:(): Promise<string[]> => ipcRenderer.invoke('xtream:deep-links'),
    on: (listener: (link: string) => void) => {
      onMain('xtream:deep-link', (link: string) => listener(link));
    }
  },

  /**
   * tvinto with no account (src/localApi.ts): requests to the app's local
   * address, for the page to answer.
   */
  localApi: {
    onRequest: (handler: (id: number, request: unknown) => void) => {
      onMain('xtream:local-api', (id: number, request: unknown) => handler(id, request));
    },
    reply: (id: number, response: unknown) => ipcRenderer.invoke('xtream:local-api-reply', id, response)
  },

  /**
   * Recording live channels (src/recorder.ts): the same calls as Android's
   * RecorderPlugin. The page hands an address to record and gets back only
   * descriptions -- never an address it did not give.
   */
  recorder: {
    start: (options: unknown) => ipcRenderer.invoke('xtream:recorder-start', options),
    stop: (options: unknown) => ipcRenderer.invoke('xtream:recorder-stop', options),
    watchAddress: (options: unknown) => ipcRenderer.invoke('xtream:recorder-watch', options),
    list: () => ipcRenderer.invoke('xtream:recorder-list'),
    remove: (options: unknown) => ipcRenderer.invoke('xtream:recorder-remove', options),
    book: (options: unknown) => ipcRenderer.invoke('xtream:recorder-book', options),
    cancelBooking: (options: unknown) => ipcRenderer.invoke('xtream:recorder-cancel', options),
    bookings: () => ipcRenderer.invoke('xtream:recorder-bookings'),
    onChanged: (listener: (id: string) => void) => {
      return onMain('xtream:recorder-changed', (id: string) => listener(id));
    }
  },

  updates: {
    ready: (): Promise<string | null> => ipcRenderer.invoke('xtream:update-ready'),
    onReady: (listener: (version: string) => void) => {
      onMain('xtream:update-ready', (version: string) => listener(version));
    },
    install: (): Promise<boolean> => ipcRenderer.invoke('xtream:update-install'),
    setBusy: (reason: string | null) => ipcRenderer.send('xtream:page-busy', reason)
  }
});

/**
 * The picture, when tvinto-player draws it (src/videoFrames.ts).
 *
 * Each frame arrives here as a GPU texture and is drawn into the page's video
 * canvas -- `<canvas data-tvinto-video>`, placed by the page under its own
 * controls. Drawn from here rather than handed to the page: a VideoFrame does
 * not cross the context bridge, and the page needs nothing of it but the
 * picture. Without such a canvas (a page older than this preload), one is put
 * over the whole window for as long as the player is open.
 */
(() => {
  const { sharedTexture } = require('electron');
  if (!sharedTexture?.setSharedTextureReceiver) {
    return;
  }

  type Imported = { getVideoFrame(): VideoFrame; release(): void };
  let latest: { frame: VideoFrame; texture: Imported } | null = null;
  let drawing = false;
  let fallback: HTMLCanvasElement | null = null;
  let observed: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let sized: ResizeObserver | null = null;
  let open = false;

  const let_go = (one: { frame: VideoFrame; texture: Imported } | null) => {
    if (one) {
      one.frame.close();
      one.texture.release();
    }
  };

  const canvas = (): HTMLCanvasElement | null => {
    const placed = document.querySelector<HTMLCanvasElement>('canvas[data-tvinto-video]');
    if (placed) {
      fallback?.remove();
      fallback = null;
      return placed;
    }
    if (!open) {
      return null;
    }
    if (!fallback?.isConnected) {
      // Also when something took it out of the page: a detached canvas would
      // be drawn into with nobody seeing it.
      fallback = document.createElement('canvas');
      fallback.setAttribute('data-tvinto-fallback', '');
      fallback.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483000;background:#000';
      document.body.appendChild(fallback);
    }
    return fallback;
  };

  /** Tells the main process the size the picture is seen at, in device pixels. */
  const follow = (target: HTMLCanvasElement) => {
    if (observed === target) {
      return;
    }
    sized?.disconnect();
    observed = target;
    context = target.getContext('2d', { alpha: false, desynchronized: true });
    sized = new ResizeObserver(entries => {
      const box = entries[0]?.devicePixelContentBoxSize?.[0];
      const width = box ? box.inlineSize : target.clientWidth * devicePixelRatio;
      const height = box ? box.blockSize : target.clientHeight * devicePixelRatio;
      ipcRenderer.send('xtream:video-size', Math.round(width), Math.round(height));
    });
    sized.observe(target, { box: 'device-pixel-content-box' });
  };

  const draw = () => {
    drawing = false;
    const target = canvas();
    const one = latest;
    latest = null;
    if (!target || !one) {
      let_go(one);
      return;
    }
    follow(target);
    if (target.width !== one.frame.codedWidth || target.height !== one.frame.codedHeight) {
      target.width = one.frame.codedWidth;
      target.height = one.frame.codedHeight;
    }
    context?.drawImage(one.frame, 0, 0);
    let_go(one);
  };

  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }: { importedSharedTexture: Imported }) => {
    // The newest frame wins; one the page had no time to draw is let go.
    let_go(latest);
    latest = { frame: importedSharedTexture.getVideoFrame(), texture: importedSharedTexture };
    if (!drawing) {
      drawing = true;
      requestAnimationFrame(draw);
    }
  });

  /**
   * Keys, while the picture covers a page that does not place it: mpv binds
   * them (its input.conf), so each is pressed in mpv by name.
   */
  const MPV_KEYS: Record<string, string> = {
    Escape: 'ESC', Backspace: 'BS', Enter: 'ENTER', ' ': 'SPACE', PageUp: 'PGUP', PageDown: 'PGDWN',
    ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ArrowUp: 'UP', ArrowDown: 'DOWN', End: 'END', Home: 'HOME',
    MediaRewind: 'REWIND', MediaFastForward: 'FORWARD', MediaPlayPause: 'PLAYPAUSE'
  };
  window.addEventListener(
    'keydown',
    event => {
      if (!open || !fallback) {
        return;
      }
      const name = MPV_KEYS[event.key] ?? (event.key.length === 1 ? event.key : null);
      event.preventDefault();
      event.stopImmediatePropagation();
      if (name) {
        ipcRenderer.send('xtream:video-key', name);
      }
    },
    true
  );

  const close = () => {
    open = false;
    let_go(latest);
    latest = null;
    fallback?.remove();
    fallback = null;
    sized?.disconnect();
    sized = null;
    observed = null;
  };
  videoClosed = close;

  onMain('xtream:video-open', (isOpen: boolean) => {
    if (!isOpen) {
      close();
    } else {
      open = true;
      // The size before the first frame, so the first is drawn at it.
      const target = canvas();
      if (target) {
        follow(target);
      }
    }
  });
})();
