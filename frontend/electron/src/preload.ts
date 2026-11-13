require('./rt/electron-rt');
//////////////////////////////
// User Defined Preload scripts below

const { contextBridge, ipcRenderer, webFrame } = require('electron');

/**
 * The one thing the desktop app can do that a browser cannot: play anything.
 *
 * Exposed through the context bridge rather than by opening Node to the page.
 * The renderer gets a single function that takes a request and resolves with a
 * position -- it cannot reach the file system, spawn anything, or name the
 * player. Everything about how playback happens stays in the main process.
 */
contextBridge.exposeInMainWorld('xtreamDesktop', {
  play: (request: unknown) => ipcRenderer.invoke('xtream:play', request),

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
      const forward = (_event: unknown, payload: unknown) => listener(payload);
      ipcRenderer.on('xtream:player-event', forward);
      return () => ipcRenderer.removeListener('xtream:player-event', forward);
    },
    command: (command: unknown) => ipcRenderer.invoke('xtream:player-command', command)
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
      ipcRenderer.on('xtream:deep-link', (_event: unknown, link: string) => listener(link));
    }
  },

  /**
   * tvinto with no account (src/localApi.ts): requests to the app's local
   * address, for the page to answer.
   */
  localApi: {
    onRequest: (handler: (id: number, request: unknown) => void) => {
      ipcRenderer.on('xtream:local-api', (_event: unknown, id: number, request: unknown) => handler(id, request));
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
      const forward = (_event: unknown, id: string) => listener(id);
      ipcRenderer.on('xtream:recorder-changed', forward);
      return () => ipcRenderer.removeListener('xtream:recorder-changed', forward);
    }
  },

  updates: {
    ready: (): Promise<string | null> => ipcRenderer.invoke('xtream:update-ready'),
    onReady: (listener: (version: string) => void) => {
      ipcRenderer.on('xtream:update-ready', (_event: unknown, version: string) => listener(version));
    },
    install: (): Promise<boolean> => ipcRenderer.invoke('xtream:update-install'),
    setBusy: (reason: string | null) => ipcRenderer.send('xtream:page-busy', reason)
  }
});
