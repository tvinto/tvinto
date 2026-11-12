import {
  OpenSubtitlesClient,
  OpenSubtitlesError,
  OpenSubtitlesFetch,
  searchParameters
} from './client';

/**
 * The OpenSubtitles client against a fake of their API, shaped from their
 * documentation (opensubtitles.stoplight.io, read 15 September 2026).
 */

const PASSWORD = 'correct horse battery';
const TOKEN = 'eyJhbGciOi.fake.token';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

const fakeApi = (answer: (sent: Sent) => { status: number; body?: unknown; headers?: Record<string, string> }) => {
  const sent: Sent[] = [];
  const fetch: OpenSubtitlesFetch = async (url, init) => {
    const request = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    sent.push(request);
    const { status, body, headers = {} } = answer(request);
    return {
      status,
      text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }
    };
  };
  return { fetch, sent };
};

const client = (fetch: OpenSubtitlesFetch, apiKey: string | null = 'app-key') =>
  new OpenSubtitlesClient({ apiKey, userAgent: 'Xtream v1.0.33', fetch });

const caught = async (promise: Promise<unknown>): Promise<OpenSubtitlesError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenSubtitlesError);
    return error as OpenSubtitlesError;
  }
  throw new Error('expected a failure');
};

const LOGIN_OK = {
  user: { allowed_downloads: 20, allowed_translations: 1, level: 'Sub leecher', user_id: 66, ext_installed: false, vip: false },
  base_url: 'api.opensubtitles.com',
  token: TOKEN,
  status: 200
};

describe('the parameters OpenSubtitles wants', () => {
  it('sorts them, lowercases them and uses + for spaces', () => {
    expect(searchParameters({ query: 'Ne Diraj  Mi Mamu', year: 2004, languages: ['hr', 'EN'] })).toBe(
      'languages=en,hr&query=ne+diraj+mi+mamu&year=2004'
    );
  });

  it('asks for an episode by its show, season and episode', () => {
    expect(searchParameters({ parentTmdbId: '01668', season: 3, episode: 2, languages: ['hr'] })).toBe(
      'episode_number=2&languages=hr&parent_tmdb_id=1668&season_number=3'
    );
  });

  it('strips tt and leading zeros from ids, and leaves defaults out', () => {
    expect(searchParameters({ imdbId: 'tt0133093', hearingImpaired: 'include', page: 1 })).toBe('imdb_id=133093');
    expect(searchParameters({ tmdbId: 24188, hearingImpaired: 'exclude', page: 2 })).toBe(
      'hearing_impaired=exclude&page=2&tmdb_id=24188'
    );
  });

  it('encodes what would otherwise break the query string', () => {
    expect(searchParameters({ query: 'Tom & Jerry?' })).toBe('query=tom+%26+jerry%3F');
  });
});

describe('signing in', () => {
  it('sends the key and the app name, and returns the session', async () => {
    const api = fakeApi(() => ({ status: 200, body: LOGIN_OK }));

    const session = await client(api.fetch).login('marko.hr', PASSWORD);

    expect(session).toEqual({ token: TOKEN, host: 'api.opensubtitles.com', level: 'Sub leecher', vip: false, allowedDownloads: 20 });
    expect(api.sent[0]).toMatchObject({
      url: 'https://api.opensubtitles.com/api/v1/login',
      method: 'POST',
      body: { username: 'marko.hr', password: PASSWORD }
    });
    expect(api.sent[0].headers).toMatchObject({
      'Api-Key': 'app-key',
      'User-Agent': 'Xtream v1.0.33',
      'X-User-Agent': 'Xtream v1.0.33',
      'Content-Type': 'application/json'
    });
  });

  it('goes on to the host the login named, for a VIP account', async () => {
    const api = fakeApi(sent =>
      sent.url.endsWith('/login')
        ? { status: 200, body: { ...LOGIN_OK, base_url: 'vip-api.opensubtitles.com' } }
        : { status: 200, body: { data: [] } }
    );
    const opensubtitles = client(api.fetch);

    await opensubtitles.login('vip', PASSWORD);
    await opensubtitles.search({ tmdbId: 1 }, TOKEN);

    expect(api.sent[1].url).toBe('https://vip-api.opensubtitles.com/api/v1/subtitles?tmdb_id=1');
  });

  it('will not send a token to a host that is not theirs', async () => {
    const api = fakeApi(sent =>
      sent.url.endsWith('/login')
        ? { status: 200, body: { ...LOGIN_OK, base_url: 'evil.example' } }
        : { status: 200, body: { data: [] } }
    );
    const opensubtitles = client(api.fetch);

    const session = await opensubtitles.login('marko.hr', PASSWORD);
    await opensubtitles.search({ tmdbId: 1 }, TOKEN);

    expect(session.host).toBe('api.opensubtitles.com');
    expect(api.sent[1].url.startsWith('https://api.opensubtitles.com/')).toBe(true);
  });

  it('says a wrong password is wrong, without repeating it', async () => {
    const api = fakeApi(() => ({ status: 401, body: { message: 'Error, invalid username/password', status: 401 } }));

    const error = await caught(client(api.fetch).login('marko.hr', PASSWORD));

    expect(error.problem).toBe('bad-login');
    expect(error.message).not.toContain(PASSWORD);
  });

  it('says so when OpenSubtitles was given an email, which its API refuses with a 400', async () => {
    const api = fakeApi(() => ({
      status: 400,
      body: { message: 'Error, invalid username/password - remember to use your username and not your email to authenticate' }
    }));

    const error = await caught(client(api.fetch).login('marko@example.com', PASSWORD));

    expect(error.problem).toBe('bad-login');
    expect(error.message).toContain('not your email');
  });

  it('does not call anybody when the app has no key', async () => {
    const api = fakeApi(() => ({ status: 200, body: LOGIN_OK }));

    const error = await caught(client(api.fetch, null).login('marko.hr', PASSWORD));

    expect(error.problem).toBe('no-key');
    expect(api.sent).toHaveLength(0);
  });
});

describe('searching', () => {
  const RESULTS = {
    total_pages: 1,
    total_count: 3,
    per_page: 60,
    page: 1,
    data: [
      {
        id: '9000',
        type: 'subtitle',
        attributes: {
          subtitle_id: '9000',
          language: 'hr',
          download_count: 4812,
          hearing_impaired: false,
          hd: true,
          fps: 23.976,
          votes: 5,
          ratings: 9.4,
          from_trusted: true,
          ai_translated: false,
          machine_translated: false,
          upload_date: '2024-01-12T10:00:00Z',
          release: 'Ne.diraj.mi.mamu.2004.1080p.WEB-DL.x264',
          uploader: { uploader_id: 1, name: 'kiki', rank: 'trusted' },
          feature_details: { feature_type: 'Movie', year: 2004, title: 'Ne diraj mi mamu', tmdb_id: 24188 },
          files: [{ file_id: 7001, cd_number: 1, file_name: 'Ne.diraj.mi.mamu.srt' }]
        }
      },
      {
        id: '9001',
        type: 'subtitle',
        attributes: {
          subtitle_id: '9001',
          language: 'hr',
          download_count: 1044,
          hearing_impaired: true,
          fps: 0,
          release: 'Ne.diraj.mi.mamu.DVDRip.XviD',
          uploader: { name: null, rank: null },
          files: [{ file_id: 7002, file_name: 'x.srt' }]
        }
      },
      { id: '9002', type: 'subtitle', attributes: { language: 'hr', release: 'no files at all', files: [] } }
    ]
  };

  it('turns their results into rows a screen can show, skipping any without a file', async () => {
    const api = fakeApi(() => ({ status: 200, body: RESULTS }));

    const search = await client(api.fetch).search({ tmdbId: 24188, languages: ['hr'] });

    expect(api.sent[0].url).toBe('https://api.opensubtitles.com/api/v1/subtitles?languages=hr&tmdb_id=24188');
    expect(api.sent[0].headers).not.toHaveProperty('Authorization');
    expect(search.totalCount).toBe(3);
    expect(search.results).toHaveLength(2);
    expect(search.results[0]).toEqual({
      subtitleId: '9000',
      fileId: 7001,
      fileName: 'Ne.diraj.mi.mamu.srt',
      language: 'hr',
      release: 'Ne.diraj.mi.mamu.2004.1080p.WEB-DL.x264',
      downloads: 4812,
      hearingImpaired: false,
      hd: true,
      fps: 23.976,
      rating: 9.4,
      votes: 5,
      fromTrusted: true,
      aiTranslated: false,
      machineTranslated: false,
      uploadedAt: '2024-01-12T10:00:00Z',
      uploader: 'kiki',
      uploaderRank: 'trusted',
      title: 'Ne diraj mi mamu',
      year: 2004,
      season: null,
      episode: null
    });
    expect(search.results[1]).toMatchObject({ fileId: 7002, hearingImpaired: true, fps: null, uploader: null, rating: 0 });
  });

  it('says when they are down, and when they want us to slow down', async () => {
    const down = fakeApi(() => ({ status: 503, body: '<html>Error 503</html>' }));
    expect((await caught(client(down.fetch).search({ query: 'x' }))).problem).toBe('unavailable');

    const busy = fakeApi(() => ({ status: 429, body: { message: 'API rate limit exceeded' }, headers: { 'ratelimit-reset': '1' } }));
    const error = await caught(client(busy.fetch).search({ query: 'x' }));
    expect(error.problem).toBe('rate-limited');
    expect(error.retryAfterSeconds).toBe(1);

    const unreachable: OpenSubtitlesFetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect((await caught(client(unreachable).search({ query: 'x' }))).problem).toBe('unavailable');
  });

  it('says the key was refused', async () => {
    const api = fakeApi(() => ({ status: 403, body: { message: 'You cannot consume this service' } }));

    expect((await caught(client(api.fetch).search({ query: 'x' }))).problem).toBe('no-key');
  });
});

describe('downloading', () => {
  it('asks for WebVTT with the token, and gives back the link and what is left', async () => {
    const api = fakeApi(() => ({
      status: 200,
      body: {
        link: 'https://www.opensubtitles.com/download/ABC/subfile/Ne.diraj.mi.mamu.vtt',
        file_name: 'Ne.diraj.mi.mamu.vtt',
        requests: 7,
        remaining: 13,
        message: 'Your quota will be renewed in 04 hours',
        reset_time: '04 hours and 23 minutes',
        reset_time_utc: '2026-09-16T00:00:00.000Z'
      }
    }));

    const download = await client(api.fetch).download(7001, TOKEN);

    expect(api.sent[0]).toMatchObject({
      url: 'https://api.opensubtitles.com/api/v1/download',
      method: 'POST',
      body: { file_id: 7001, sub_format: 'webvtt' }
    });
    expect(api.sent[0].headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(download).toEqual({
      link: 'https://www.opensubtitles.com/download/ABC/subfile/Ne.diraj.mi.mamu.vtt',
      fileName: 'Ne.diraj.mi.mamu.vtt',
      remaining: 13,
      resetTimeUtc: '2026-09-16T00:00:00.000Z'
    });
  });

  it('says the allowance is used up, and when it comes back', async () => {
    const api = fakeApi(() => ({
      status: 406,
      body: {
        requests: 21,
        remaining: -1,
        message: 'You have downloaded your allowed 20 subtitles for 24h.',
        reset_time_utc: '2026-09-16T00:00:00.000Z'
      }
    }));

    const error = await caught(client(api.fetch).download(7001, TOKEN));

    expect(error.problem).toBe('allowance-used');
    expect(error.resetTimeUtc).toBe('2026-09-16T00:00:00.000Z');
  });

  it('treats a negative allowance as used up even when it comes with a 200', async () => {
    const api = fakeApi(() => ({ status: 200, body: { remaining: -1, reset_time_utc: '2026-09-16T00:00:00.000Z' } }));

    expect((await caught(client(api.fetch).download(7001, TOKEN))).problem).toBe('allowance-used');
  });

  it('asks for a sign-in rather than downloading anonymously', async () => {
    const api = fakeApi(() => ({ status: 200, body: {} }));

    expect((await caught(client(api.fetch).download(7001, ''))).problem).toBe('signed-out');
    expect(api.sent).toHaveLength(0);
  });

  it('reads an expired token as signed out, which comes back as a 500', async () => {
    const api = fakeApi(() => ({ status: 500, body: { message: 'invalid token' } }));

    const error = await caught(client(api.fetch).download(7001, TOKEN));

    expect(error.problem).toBe('signed-out');
    expect(error.message).not.toContain(TOKEN);
  });

  it('refuses a link that is not https', async () => {
    const api = fakeApi(() => ({ status: 200, body: { link: 'http://plain.example/file.vtt', remaining: 5 } }));

    expect((await caught(client(api.fetch).download(7001, TOKEN))).problem).toBe('failed');
  });
});

describe('the allowance', () => {
  it('reads what is left today', async () => {
    const api = fakeApi(() => ({
      status: 200,
      body: { data: { allowed_downloads: 20, level: 'Sub leecher', user_id: 66, vip: false, downloads_count: 6, remaining_downloads: 14 } }
    }));

    expect(await client(api.fetch).user(TOKEN)).toEqual({
      level: 'Sub leecher',
      vip: false,
      allowedDownloads: 20,
      remainingDownloads: 14,
      downloadsCount: 6
    });
    expect(api.sent[0]).toMatchObject({ url: 'https://api.opensubtitles.com/api/v1/infos/user', method: 'GET' });
  });

  it('logs out quietly, whatever the answer', async () => {
    const api = fakeApi(() => ({ status: 500, body: {} }));

    await expect(client(api.fetch).logout(TOKEN)).resolves.toBeUndefined();
    expect(api.sent[0].method).toBe('DELETE');
  });
});
