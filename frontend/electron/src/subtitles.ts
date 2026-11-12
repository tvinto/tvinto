import { fromAppPage } from './appPage';
import { ipcMain } from 'electron';
import { get } from 'https';

/**
 * Fetching a subtitle file for the page.
 *
 * The page cannot. OpenSubtitles' API allows cross-origin requests, but the
 * temporary link it hands back points at www.opensubtitles.com, which sends no
 * such header -- so a `fetch` from the renderer is refused by Chromium with
 * nothing anybody can do from inside it. Android has the same problem and the
 * same answer: ask the platform underneath, where the rule does not apply.
 *
 * Only their hosts, and only text. This is a hole in the page's sandbox by
 * definition, so it is a hole the size of one job: no arbitrary URL, no
 * arbitrary size, nothing returned but a string.
 */

const ALLOWED_HOSTS = new Set([
  'www.opensubtitles.com',
  'opensubtitles.com',
  'dl.opensubtitles.org',
  'www.opensubtitles.org'
]);

/** Comfortably more than a long film's subtitles, far less than a download. */
const MAX_BYTES = 2 * 1024 * 1024;

const MAX_REDIRECTS = 3;

const fetchText = (url: string, userAgent: string, redirectsLeft: number): Promise<string> =>
  new Promise((resolve, reject) => {
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      reject(new Error('That is not a link'));
      return;
    }
    if (address.protocol !== 'https:' || !ALLOWED_HOSTS.has(address.hostname.toLowerCase())) {
      reject(new Error('Only OpenSubtitles files can be fetched'));
      return;
    }

    const request = get(
      address,
      { headers: { 'User-Agent': userAgent, Accept: 'text/plain, */*' }, timeout: 20_000 },
      response => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          resolve(fetchText(new URL(location, address).toString(), userAgent, redirectsLeft - 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`The file could not be fetched (${status})`));
          return;
        }

        let text = '';
        let bytes = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk, 'utf8');
          if (bytes > MAX_BYTES) {
            request.destroy();
            reject(new Error('That file is too big to be subtitles'));
            return;
          }
          text += chunk;
        });
        response.on('end', () => resolve(text));
      }
    );

    request.on('timeout', () => request.destroy(new Error('The file took too long')));
    request.on('error', error => reject(error));
  });

export function registerSubtitleFetch(): void {
  ipcMain.handle('xtream:fetch-subtitle', (event, url: unknown, userAgent: unknown) =>
    !fromAppPage(event) ? Promise.reject(new Error('Not the app')) :
    fetchText(String(url ?? ''), typeof userAgent === 'string' && userAgent ? userAgent : 'Tvinto', MAX_REDIRECTS)
  );
}
