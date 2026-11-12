import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * Whether an IPC call came from the app's own page.
 *
 * The preload's bridge (preload.ts) is in every page that loads it, and the
 * main process acts on what it is sent: starting mpv, installing an update,
 * answering the local API. Only the app, served on its own scheme, may ask --
 * not a frame inside it, not a window something else opened.
 */
export const APP_SCHEME = 'capacitor-electron';

export const isAppPage = (url: string | undefined | null): boolean =>
  typeof url === 'string' && url.startsWith(`${APP_SCHEME}://`);

/** The same, for an IPC event: its sending frame, which must be the top one. */
export const fromAppPage = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
  const frame = event.senderFrame;
  return Boolean(frame) && frame.parent === null && isAppPage(frame.url);
};
