import { CapacitorHttp } from '@capacitor/core';
import { safeToLog } from '../../utils/stream.utils';

/**
 * Getting the bytes of a guide, which is the one part that differs by platform.
 *
 * Everything after this is shared: `guideTextFromBytes` decompresses and
 * decodes, `readXmltv` finds the elements, `loadGuide` writes them down. All
 * that varies is how the request can be made at all, and the difference is the
 * same one that gave the provider two transports.
 */

/** How long to wait for a guide server to start answering. */
const GUIDE_TIMEOUT_MS = 120_000;

/**
 * How long the desktop waits with no bytes arriving before giving up.
 *
 * Silence, not duration. The first version gave the whole download two
 * minutes, and the provider's guide -- six thousand channels, streamed slowly,
 * and parsed and written to the database as it arrives -- took longer than
 * that while arriving perfectly steadily. It was cut off mid-way on every
 * attempt. A guide that is still flowing is not stuck however long it takes;
 * one that has sent nothing for a minute is.
 */
const GUIDE_IDLE_TIMEOUT_MS = 60_000;

/**
 * The desktop: plain fetch, streamed.
 *
 * Electron runs with web security off, so the request a browser would refuse
 * to make -- cross-origin, and often to an HTTP-only host -- is simply made.
 * The body is a real stream, so the guide never exists as one object: it goes
 * from the socket to the parser a piece at a time.
 */
export const fetchGuideBytes = async function* (url: string): AsyncIterable<Uint8Array> {
  const abort = new AbortController();
  let expiry = setTimeout(() => abort.abort(), GUIDE_TIMEOUT_MS);
  const stillArriving = () => {
    clearTimeout(expiry);
    expiry = setTimeout(() => abort.abort(), GUIDE_IDLE_TIMEOUT_MS);
  };

  try {
    const response = await fetch(url, {
      signal: abort.signal,
      headers: { Accept: 'application/xml, text/xml, */*' }
    });

    if (!response.ok) {
      throw new Error(`Guide server answered ${response.status} for ${safeToLog(url)}`);
    }

    if (!response.body) {
      // No stream to read: take it whole rather than fail.
      yield new Uint8Array(await response.arrayBuffer());
      return;
    }

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        stillArriving();
        if (value) {
          yield value;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(expiry);
  }
};

/**
 * Android, on an APK without `GuideDownloadPlugin`: through the platform, and
 * therefore all at once. Kept only as the fallback for such an APK -- see
 * `guideDownload.ts` for the path that does not hold the guide whole.
 *
 * A request from the WebView is a browser request, subject to the same-origin
 * policy the guide server has no reason to relax, so it has to be handed to
 * the platform underneath -- exactly as CapacitorTransport does for the
 * provider. The cost is that the plugin has no notion of a stream and hands
 * back the whole body.
 *
 * So on a phone the decompressed guide does exist in one piece, briefly. The
 * reader still bounds the parse, which is the larger cost by far, and this is
 * the seam where a file-backed download would go if the whole-body step turns
 * out to be too much for a small device: nothing above here would change.
 */
export const capacitorGuideBytes = async function* (url: string): AsyncIterable<Uint8Array> {
  const response = await CapacitorHttp.get({
    url,
    // Base64 rather than text: a gzipped guide is not text, and asking for it
    // as text is how it arrives corrupted.
    responseType: 'arraybuffer',
    connectTimeout: GUIDE_TIMEOUT_MS,
    readTimeout: GUIDE_TIMEOUT_MS,
    headers: { Accept: 'application/xml, text/xml, */*' }
  });

  if (response.status >= 400) {
    throw new Error(`Guide server answered ${response.status} for ${safeToLog(url)}`);
  }

  const data = response.data;

  if (typeof data === 'string') {
    yield base64ToBytes(data);
    return;
  }

  if (data instanceof ArrayBuffer) {
    yield new Uint8Array(data);
    return;
  }

  throw new Error('Guide server returned something that was not a document');
};

/**
 * Base64 to bytes.
 *
 * The plugin hands an arraybuffer response across the bridge as Base64,
 * because the bridge carries strings. Straight to bytes rather than through
 * text: this may be gzip, which is not text at all.
 */
const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};
