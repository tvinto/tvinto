import { MessageChannelMain, MessagePortMain, WebContents } from 'electron';

/**
 * Messages from the main process to the page, over a MessagePort.
 *
 * Not `webContents.send`. While tvinto-player's frames go to the page
 * (sharedTexture.sendSharedTexture, src/videoFrames.ts), Electron 45 delivers
 * no `webContents.send` message to that frame at all -- not one in fourteen
 * seconds, measured on 13 November -- while a MessagePort's go on arriving,
 * as do replies to the page's own requests. So everything the main process
 * tells the page goes this way: the player's events (switching channel
 * inside it, progress), recordings, links, the local API, updates.
 *
 * A port per page load: a reload makes a new page, which is handed a new one.
 * Until it has one, `webContents.send` as before.
 */

const ports = new WeakMap<WebContents, MessagePortMain>();

/** Hands the page a port at every load. Called once per window. */
export function openPageChannel(contents: WebContents): void {
  contents.on('did-finish-load', () => {
    const { port1, port2 } = new MessageChannelMain();
    ports.get(contents)?.close();
    ports.set(contents, port1);
    port1.start();
    contents.postMessage('xtream:page-channel', null, [port2]);
  });
  contents.once('destroyed', () => {
    ports.get(contents)?.close();
    ports.delete(contents);
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
