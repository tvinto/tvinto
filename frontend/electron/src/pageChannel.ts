import { ipcMain, MessagePortMain, WebContents } from 'electron';

/**
 * Messages from the main process to the page, over a MessagePort.
 *
 * Not `webContents.send`. While tvinto-player's frames go to the page
 * (sharedTexture.sendSharedTexture, src/videoFrames.ts), Electron 45 delivers
 * no `webContents.send` message to that frame at all -- not one in fourteen
 * seconds, measured on 13 November -- and no `webContents.postMessage`
 * either, while a MessagePort's messages go on arriving, as do replies to the
 * page's own requests and everything the page sends. So everything the main
 * process tells the page goes this way: the player's events (switching
 * channel inside it, progress), its state, recordings, links, the local API,
 * updates.
 *
 * The page makes the port and hands it over (preload.ts), at every load: a
 * port the main process handed it would itself be a message that does not
 * arrive while a film plays -- a page reloaded mid-film never got one.
 * Until a page has handed one, `webContents.send` as before.
 */

const ports = new WeakMap<WebContents, MessagePortMain>();

/** Takes the ports pages hand over. Called once, at startup. */
export function acceptPageChannels(): void {
  ipcMain.on('xtream:page-channel', event => {
    const port = event.ports[0];
    const contents = event.sender;
    if (!port) {
      return;
    }
    ports.get(contents)?.close();
    ports.set(contents, port);
    port.start();
    contents.once('destroyed', () => {
      if (ports.get(contents) === port) {
        port.close();
        ports.delete(contents);
      }
    });
  });
}

/** Says something to the page, as `webContents.send(channel, ...args)` would. */
export function toPage(contents: WebContents, channel: string, ...args: unknown[]): void {
  if (contents.isDestroyed()) {
    return;
  }
  const port = ports.get(contents);
  if (port) {
    port.postMessage({ channel, args });
  } else {
    contents.send(channel, ...args);
  }
}
