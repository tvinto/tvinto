import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Android's guide download, a file at a time rather than a body at a time.
 *
 * The native half is `GuideDownloadPlugin.java`, which says why it exists: the
 * old path held the whole guide in memory several times over, and a small
 * television box does not survive that. This half reads the downloaded file
 * back in chunks and hands them to the shared parser, which was already
 * streaming everything after this point.
 */

export interface GuideDownloadPlugin {
  download(options: {
    url: string;
    connectTimeoutMs?: number;
    idleTimeoutMs?: number;
  }): Promise<DownloadedFile>;
  read(options: { id: string; offset: number; length: number }): Promise<{ data: string; eof: boolean }>;
  discard(options: { id: string }): Promise<void>;
}

/**
 * A download in the device's cache: its handle for reading over the bridge,
 * and -- from APK 1.0.93 -- its path, which a worker can fetch through the
 * WebView's local file address instead. An older APK sends no path.
 */
export interface DownloadedFile {
  id: string;
  bytes: number;
  path?: string;
}

/** Half a megabyte: small against any device's memory, few enough bridge calls. */
export const CHUNK_BYTES = 512 * 1024;

/**
 * The plugin, or null on an APK built before it existed.
 *
 * A web bundle arrives over the air and can be newer than the APK running it,
 * so the absence is ordinary rather than an error: the caller goes back to the
 * old whole-body download, which is worse and still works.
 */
export const guideDownloadPlugin = (): GuideDownloadPlugin | null => {
  if (!Capacitor.isPluginAvailable('GuideDownload')) {
    return null;
  }
  // Registered once: Capacitor warns "already registered" at every second call.
  registered ??= registerPlugin<GuideDownloadPlugin>('GuideDownload');
  return registered;
};

let registered: GuideDownloadPlugin | undefined;

/**
 * Downloads a guide to the device's cache and yields it back a chunk at a time.
 *
 * The file is deleted however this ends -- finished, failed, or abandoned by a
 * reader that stopped early -- because a compressed guide is tens of megabytes
 * of somebody's storage.
 */
export const downloadedGuideBytes = async function* (
  plugin: GuideDownloadPlugin,
  url: string,
  options: { chunkBytes?: number; connectTimeoutMs?: number; idleTimeoutMs?: number } = {}
): AsyncIterable<Uint8Array> {
  const file = await plugin.download({
    url,
    connectTimeoutMs: options.connectTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs
  });
  try {
    yield* downloadedFileBytes(plugin, file, options.chunkBytes);
  } finally {
    await plugin.discard({ id: file.id }).catch(() => undefined);
  }
};

/**
 * A downloaded file read back over the bridge a chunk at a time. Leaves the
 * file where it is: whoever downloaded it discards it.
 */
export const downloadedFileBytes = async function* (
  plugin: GuideDownloadPlugin,
  file: DownloadedFile,
  chunkBytes = CHUNK_BYTES
): AsyncIterable<Uint8Array> {
  for (let offset = 0; ; ) {
    const { data, eof } = await plugin.read({ id: file.id, offset, length: chunkBytes });
    const bytes = base64ToBytes(data);
    // Taken before the chunk is handed over: a reader may move it away,
    // which empties it here.
    const size = bytes.length;

    if (size) {
      offset += size;
      yield bytes;
    }

    // An empty chunk that is not the end would be read again forever.
    if (eof || !size) {
      return;
    }
  }
};

/** Where a worker can fetch a downloaded file from, or null on an APK that does not say. */
export const downloadedFileAddress = (file: DownloadedFile): string | null =>
  file.path ? new URL(Capacitor.convertFileSrc(`file://${file.path}`), location.href).href : null;

/**
 * Base64 to bytes, without going through text.
 *
 * The bridge carries strings, and this may be gzip, which is not text at all.
 */
export const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};
