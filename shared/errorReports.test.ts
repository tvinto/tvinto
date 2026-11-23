import {
  abnormalPlayerExit,
  appFile,
  appScreen,
  cleanLogTail,
  cleanReport,
  cleanText,
  foldRepeats,
  NO_LOCATION,
  errorReportsValue,
  isReportAddress,
  mayReport,
  sendsErrorReports
} from './errorReports';

// A made-up provider, account and sync service, as the app would hold them.
const HOST = 'panel.fake-provider.test';
const USER = 'walkuser42';
const PASSWORD = 'Pa55-word!';
const EMAIL = 'someone@example.org';
const SYNC = 'https://sync.fake-sync.test/api';
const TMDB_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const personal = [`http://${HOST}:8789`, USER, PASSWORD, EMAIL, SYNC, 'Somebody'];

/** Everything planted, in the forms the app meets it. */
const planted = [
  `http://${HOST}:8789/live/${USER}/${encodeURIComponent(PASSWORD)}/1234.ts`,
  `${HOST}:8789/${USER}/${PASSWORD}/1234.ts`,
  `http://${HOST}:8789/player_api.php?username=${USER}&password=${PASSWORD}&action=get_live_streams`,
  `tvinto://sign-in?code=ABCD-1234&server=${encodeURIComponent(SYNC)}`,
  `could not sign in as ${USER}`,
  `password=${PASSWORD}`,
  `Authorization: Bearer ${TMDB_KEY}`,
  `api_key=${TMDB_KEY}`,
  `the account ${EMAIL} was refused`,
  `fetch failed for 203.0.113.9:8080/get.php`,
  `ENOENT C:\\Users\\Somebody\\AppData\\Roaming\\Tvinto\\playback.log`,
  `stalker mac 00:1A:79:12:34:56`
];

const secrets = [HOST, USER, PASSWORD, encodeURIComponent(PASSWORD), EMAIL, 'fake-sync.test', TMDB_KEY, '203.0.113.9', 'Somebody', '00:1A:79:12:34:56', 'ABCD-1234'];

const leaks = (text: string): string[] => secrets.filter(secret => text.toLowerCase().includes(secret.toLowerCase()));

describe('cleanText', () => {
  it.each(planted)('takes everything personal out of %s', line => {
    expect(leaks(cleanText(line, personal))).toEqual([]);
  });

  it('finds an address, credentials and a key with no known values at all', () => {
    for (const line of planted.slice(0, 4).concat(planted.slice(6, 8))) {
      expect(leaks(cleanText(line)).filter(found => found !== USER && found !== PASSWORD)).toEqual([]);
    }
  });

  it('keeps the stream number, the scheme and what went wrong', () => {
    expect(cleanText(`mpv: Failed to open http://${HOST}:8789/live/${USER}/x/1234.ts.`, personal)).toBe('mpv: Failed to open http …/[stream].ts.');
    expect(cleanText('TypeError: Cannot read properties of undefined (reading "id")')).toBe('TypeError: Cannot read properties of undefined (reading "id")');
  });

  it('leaves the app\'s own file names in a written-out stack', () => {
    expect(cleanText('at load (main-AB12CD34.js:1:2345)')).toBe('at load (main-AB12CD34.js:1:2345)');
  });

  it('takes an address out whole even when its host is a known value', () => {
    expect(cleanText('127.0.0.1:8789/walk/walk/1001.ts failed for walk', ['http://127.0.0.1:8789', 'walk'])).toBe('[address] failed for [removed]');
  });

  it('takes out what was played', () => {
    expect(cleanText('could not open Planted Channel Name HD', ['Planted Channel Name HD'])).toBe('could not open [removed]');
  });

  it('takes a short password out only where it stands alone', () => {
    expect(cleanText('x9 failed in box9x', ['x9'])).toBe('[removed] failed in box9x');
  });
});

describe('cleanReport', () => {
  const event = {
    event_id: '0123456789abcdef0123456789abcdef',
    timestamp: 1763900000,
    platform: 'javascript',
    level: 'error',
    release: 'tvinto-desktop@1.0.127',
    message: `Stream ${planted[0]} failed`,
    exception: {
      values: [
        {
          type: 'Error',
          value: `Could not load ${planted[2]}`,
          stacktrace: {
            frames: [
              { filename: `capacitor-electron://-/main-AB12.js?u=${USER}`, function: 'load', lineno: 1, colno: 2 },
              { filename: 'C:\\Users\\Somebody\\AppData\\Local\\Programs\\Tvinto\\resources\\app.asar\\build\\src\\player.js', abs_path: '/home/somebody/x.js', function: 'play' }
            ]
          }
        }
      ]
    },
    extra: { provider: { host: HOST, username: USER, password: PASSWORD }, log: [`2026-11-23 app: opens ${planted[0]}`, `sync to ${SYNC} failed`] },
    tags: { route: `/live/${USER}` },
    user: { id: '7', email: EMAIL, ip_address: '{{auto}}' },
    breadcrumbs: [{ category: 'ui.click', message: 'Channel One HD' }],
    server_name: 'SOMEBODYS-PC',
    request: { url: `capacitor-electron://-/#/live/12/345?u=${USER}`, headers: { Cookie: 'session=1', Referer: `http://${HOST}/`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0' } },
    contexts: {
      device: { name: 'SOMEBODYS-PC', model: 'Surface', arch: 'x64' },
      os: { name: 'Windows', version: '10.0.26200' },
      app: { app_name: 'Tvinto', app_version: '1.0.127', device_app_hash: 'x' },
      profile: { account: EMAIL }
    },
    sdk: { name: 'sentry.javascript.angular', version: '11.16.0' }
  };
  const cleaned = cleanReport(event, personal);
  const text = JSON.stringify(cleaned);

  it('carries nothing personal, anywhere', () => {
    expect(leaks(text)).toEqual([]);
    expect(text).not.toContain('Channel One');
    expect(text).not.toContain('SOMEBODYS-PC');
  });

  it('sends no user, no IP address, no breadcrumbs, no headers', () => {
    // No one's: only a location that says none was sent (NO_LOCATION).
    expect(cleaned['user']).toEqual({ geo: { region: NO_LOCATION } });
    expect(cleaned).not.toHaveProperty('breadcrumbs');
    expect(cleaned).not.toHaveProperty('server_name');
    expect(cleaned.request).toEqual({ url: 'app:///live', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0' } });
    expect(cleaned.sdk).toEqual({ name: 'sentry.javascript.angular', version: '11.16.0', settings: { infer_ip: 'never' } });
  });

  it('keeps what makes a report useful', () => {
    expect(cleaned.event_id).toBe(event.event_id);
    expect(cleaned.release).toBe('tvinto-desktop@1.0.127');
    expect(cleaned.contexts).toEqual({ device: { model: 'Surface', arch: 'x64' }, os: { name: 'Windows', version: '10.0.26200' }, app: { app_name: 'Tvinto', app_version: '1.0.127' } });
    const frames = (cleaned.exception as typeof event.exception).values[0]!.stacktrace.frames;
    expect(frames.map(frame => frame.filename)).toEqual(['app:///main-AB12.js', 'app:///player.js']);
    expect(frames[0]!.function).toBe('load');
  });

  it('leaves the event it was given alone', () => {
    expect(event.user.email).toBe(EMAIL);
  });
});

describe('cleanLogTail', () => {
  it('keeps the last lines, cleaned', () => {
    const log = Array.from({ length: 80 }, (_, i) => `line ${i} ${USER} http://${HOST}/x`).join('\n');
    const tail = cleanLogTail(log, personal);
    expect(tail).toHaveLength(50);
    expect(tail[49]).toBe('line 79 [removed] http …');
    expect(leaks(tail.join('\n'))).toEqual([]);
  });
});

describe('the switch', () => {
  const dsn = 'https://0123abcd@o1.ingest.example.test/42';

  it('is on unless turned off', () => {
    expect(sendsErrorReports(null)).toBe(true);
    expect(sendsErrorReports('on')).toBe(true);
    expect(sendsErrorReports(errorReportsValue(false))).toBe(false);
  });

  it('sends only with an address, the switch shown, and on', () => {
    expect(mayReport({ dsn, setting: null, shown: true })).toBe(true);
    expect(mayReport({ dsn, setting: null, shown: false })).toBe(false);
    expect(mayReport({ dsn, setting: 'off', shown: true })).toBe(false);
    expect(mayReport({ dsn: null, setting: 'on', shown: true })).toBe(false);
    expect(mayReport({ dsn: '', setting: 'on', shown: true })).toBe(false);
  });

  it('knows a report address', () => {
    expect(isReportAddress(dsn)).toBe(true);
    expect(isReportAddress('http://key@127.0.0.1:8790/1')).toBe(true);
    expect(isReportAddress('https://o1.ingest.example.test/42')).toBe(false);
    expect(isReportAddress("x'; alert(1)//")).toBe(false);
  });
});

describe('helpers', () => {
  it('names the screen without ids', () => {
    expect(appScreen('capacitor-electron://-/#/movies/123')).toBe('app:///movies');
    expect(appScreen('http://localhost/for-you?x=1')).toBe('app:///for-you');
  });

  it('keeps a file name only', () => {
    expect(appFile('/home/me/app/build/src/index.js')).toBe('app:///index.js');
    expect(appFile('app.tvinto.device.ErrorReportsPlugin$$ExternalSyntheticLambda0')).toBe('app:///app.tvinto.device.ErrorReportsPlugin$$ExternalSyntheticLambda0');
  });

  it('reports a player that crashed, not one closed or refused', () => {
    expect([0, 2, 4, 10, 11].map(code => abnormalPlayerExit(code, null))).toEqual([false, false, false, false, false]);
    expect(abnormalPlayerExit(1, null)).toBe(true);
    expect(abnormalPlayerExit(3221225477, null)).toBe(true);
    expect(abnormalPlayerExit(null, 'SIGSEGV')).toBe(true);
    expect(abnormalPlayerExit(null, null)).toBe(false);
  });
});

describe('what leaves the device about a stream', () => {
  it('names no stream by its number, in an address or a log line already shortened', () => {
    expect(cleanText('app: opens a film http …/478781.mkv in tvinto-player')).toBe('app: opens a film http …/[stream].mkv in tvinto-player');
    expect(cleanText('opening http://203.0.113.9:8080/movie/u/p/478781.mkv')).toBe('opening http …/[stream].mkv');
    expect(cleanText('live http …/1234 dropped')).toBe('live http …/[stream] dropped');
    expect(cleanLogTail('2026-11-23T12:41:26.729Z app: opens http …/975975.mkv')).toEqual(['2026-11-23T12:41:26.729Z app: opens http …/[stream].mkv']);
  });

  it('carries a location that says none was sent, so Sentry works none out', () => {
    const cleaned = cleanReport({ user: { ip_address: '203.0.113.9', geo: { city: 'Zagreb' } } }) as Record<string, unknown>;
    expect(cleaned['user']).toEqual({ geo: { region: NO_LOCATION } });
  });
});

describe('foldRepeats', () => {
  it('folds lines that say the same thing in a row, whatever their time', () => {
    const lines = [
      '2026-11-23T12:47:45.250Z app: opens a live channel',
      '2026-11-23T12:47:50.413Z tvinto-player: stats sent=1 waited=0',
      '2026-11-23T12:47:55.438Z tvinto-player: stats sent=1 waited=0',
      '2026-11-23T12:48:00.473Z tvinto-player: stats sent=1 waited=0',
      '2026-11-23T12:48:05.000Z app: no picture in 20 s',
      '2026-11-23T12:48:06.000Z tvinto-player: stats sent=1 waited=0'
    ];
    expect(foldRepeats(lines)).toEqual([
      '2026-11-23T12:47:45.250Z app: opens a live channel',
      '2026-11-23T12:47:50.413Z tvinto-player: stats sent=1 waited=0 (3 times in a row)',
      '2026-11-23T12:48:05.000Z app: no picture in 20 s',
      '2026-11-23T12:48:06.000Z tvinto-player: stats sent=1 waited=0'
    ]);
  });

  it('gives the folded tail room for what happened before the repeats', () => {
    const log = ['2026-11-23T12:47:45.250Z app: opens a live channel', ...Array.from({ length: 60 }, (_, i) => `2026-11-23T12:48:${String(i).padStart(2, '0')}.000Z stats sent=1`)].join('\n');
    expect(cleanLogTail(log)).toHaveLength(2);
  });
});
