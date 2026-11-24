import { onRequestGet as android } from '../../functions/android';
import { onRequestGet as windows } from '../../functions/windows';

/** The website's download addresses (functions/), against a stand-in feed. */
describe('the website’s /android and /windows', () => {
  const realFetch = globalThis.fetch;
  const FEED = 'http://feed.test';
  const APK = 'https://github.com/tvinto/tvinto/releases/download/android-1.0.140/tvinto-1.0.140.apk';
  const EXE = 'https://github.com/tvinto/tvinto/releases/download/desktop-1.0.128/Tvinto-Setup-1.0.128.exe';
  let feed: Record<string, string>;
  let asked: string[];

  beforeEach(() => {
    feed = {};
    asked = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      const name = String(url).replace(`${FEED}/`, '');
      return name in feed ? new Response(feed[name]) : new Response('Not Found', { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const location = async (response: Promise<Response>) => {
    const answer = await response;
    expect(answer.status).toBe(302);
    expect(answer.headers.get('Cache-Control')).toContain('max-age=60');
    return answer.headers.get('Location');
  };

  it('sends /android to the APK in android-apk.json', async () => {
    feed['android-apk.json'] = JSON.stringify({ version: '1.0.140', versionCode: 42, file: APK, size: 1 });
    expect(await location(android({ env: { FEED } }))).toBe(APK);
    expect(asked).toEqual([`${FEED}/android-apk.json`]);
  });

  it('sends /windows to the installer in latest.yml', async () => {
    feed['latest.yml'] = `version: 1.0.128\nfiles:\n  - url: ${EXE}\n    size: 1\npath: ${EXE}\n`;
    expect(await location(windows({ env: { FEED } }))).toBe(EXE);
  });

  it('falls back to the releases page when the feed is missing, broken, unreachable or points elsewhere', async () => {
    const RELEASES = 'https://github.com/tvinto/tvinto/releases';
    expect(await location(windows({ env: { FEED } }))).toBe(RELEASES);
    feed['android-apk.json'] = 'not json';
    expect(await location(android({ env: { FEED } }))).toBe(RELEASES);
    feed['android-apk.json'] = JSON.stringify({ version: '1', file: 'https://elsewhere.example/x.apk' });
    expect(await location(android({ env: { FEED } }))).toBe(RELEASES);
    globalThis.fetch = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    expect(await location(android({ env: { FEED } }))).toBe(RELEASES);
  });

  it('reads the project’s own feed when no stand-in is set', async () => {
    await android({ env: {} });
    expect(asked).toEqual(['https://github.com/tvinto/tvinto/releases/download/feed/android-apk.json']);
  });
});
