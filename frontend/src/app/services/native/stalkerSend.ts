import { CapacitorHttp } from '@capacitor/core';
import { StalkerError, StalkerRequest, StalkerSend } from '@shared/stalker/client';

/**
 * How each platform asks a Stalker portal (shared/stalker/client.ts), which
 * reads the MAC address from a cookie and wants a MAG box's user agent --
 * the two headers a page's fetch is not allowed to set.
 *
 * - Android: the platform's own HTTP, which sets any header.
 * - The desktop: the page's fetch, with the two under names of the app's
 *   own; the main process puts them where the portal looks
 *   (electron/src/setup.ts, setupRequestHeaders).
 * - A browser: nothing can set them, so a portal cannot be used there.
 */
export function stalkerSendFor(platform: 'android' | 'electron' | 'browser' | string): StalkerSend {
  if (platform === 'android') {
    return androidSend;
  }
  if (platform === 'electron') {
    return desktopSend;
  }
  return () => Promise.reject(new StalkerError('A portal works in the app, on a TV, phone or computer, not in a browser.', 'unreachable'));
}

const androidSend: StalkerSend = async (request: StalkerRequest) => {
  const response = await CapacitorHttp.get({
    url: request.url,
    params: request.query,
    headers: request.headers,
    responseType: 'text',
    connectTimeout: request.timeoutMs,
    readTimeout: request.timeoutMs
  });
  return { status: response.status, text: typeof response.data === 'string' ? response.data : JSON.stringify(response.data) };
};

const desktopSend: StalkerSend = async (request: StalkerRequest) => {
  const url = new URL(request.url);
  Object.entries(request.query).forEach(([key, value]) => url.searchParams.set(key, value));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.toLowerCase() === 'cookie') {
      headers['X-Tvinto-Portal-Cookie'] = value;
    } else if (name.toLowerCase() === 'user-agent') {
      headers['X-Tvinto-Portal-Agent'] = value;
    } else {
      headers[name] = value;
    }
  }
  const response = await fetch(url, { headers, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(request.timeoutMs) });
  return { status: response.status, text: await response.text() };
};
