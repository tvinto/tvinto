import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * Reading the update feed (frontend/scripts/feed.js).
 *
 * A manifest names its file either beside itself (a sync service's bucket) or
 * by its full address (GitHub Releases, where the feed release holds the
 * manifests and each version's files are in a release of their own). Resolving
 * against the feed answers both.
 */
export function feedAddress(feed: string, file: string): string {
  return new URL(file, `${feed}/`).href;
}

/**
 * One manifest out of the feed, or null when there is none.
 *
 * On Android through the native HTTP client rather than `fetch`: GitHub's
 * release downloads send no CORS headers, so the WebView refuses to read
 * them, and the redirect to the file's storage host is followed natively.
 * GitHub also calls a JSON file `application/octet-stream`, so the body may
 * come back as text.
 */
export async function readFeedJson(url: string): Promise<unknown> {
  if (Capacitor.getPlatform() === 'android') {
    const response = await CapacitorHttp.get({ url, headers: { 'Cache-Control': 'no-cache' } });
    if (response.status !== 200) {
      return null;
    }
    return typeof response.data === 'string' ? (JSON.parse(response.data) as unknown) : (response.data as unknown);
  }
  const response = await fetch(url, { cache: 'no-store' });
  return response.ok ? ((await response.json()) as unknown) : null;
}
