/**
 * A conversation with OpenSubtitles' REST API, for one app and one person.
 *
 * Devices call OpenSubtitles themselves: the person's
 * password goes from their device to OpenSubtitles and nowhere else, and each
 * home is its own IP against the per-IP limits. The sync service only hands out
 * the application's key and keeps the files an account added.
 *
 * What their documentation asks of a client, and where it is done here:
 *
 * - `Api-Key` on every request, and the app's name and version as a
 *   User-Agent. A browser cannot set User-Agent, so `X-User-Agent` is sent too,
 *   which they accept in its place.
 * - Parameters sorted, lowercase, without defaults, `+` for spaces and no
 *   leading zeros in ids, or the API answers with a redirect first (`query`).
 * - After signing in, requests go to the `base_url` the login returned, which
 *   is a different host for VIP accounts. Only their two hosts are accepted.
 * - A 401 at login means stop: logging in again with the same password is what
 *   gets clients limited to 30 an hour.
 * - A download is counted when the link is asked for, not when the file is
 *   fetched, so `download` gives back the link and the allowance together and
 *   fetching the file is a separate step that can be retried.
 *
 * Nothing here logs, and no error message carries a password, token or key.
 */

export const DEFAULT_HOST = 'api.opensubtitles.com';
const HOSTS = new Set([DEFAULT_HOST, 'vip-api.opensubtitles.com']);

/** How a request is made: `fetch` on a device, a fake in a test. */
export type OpenSubtitlesFetch = (
  url: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; headers: Record<string, string>; body?: string }
) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

export type OpenSubtitlesProblem =
  /** The app has no key yet, or OpenSubtitles refused it. */
  | 'no-key'
  /** Wrong username or password. Do not try the same ones again. */
  | 'bad-login'
  /** No token, or it expired (they last 24 hours). Log in again. */
  | 'signed-out'
  /** The day's downloads are spent; `resetTimeUtc` says when they come back. */
  | 'allowance-used'
  /** Too many requests too fast; `retryAfterSeconds` when known. */
  | 'rate-limited'
  /** OpenSubtitles is down or unreachable. Try later. */
  | 'unavailable'
  | 'failed';

export class OpenSubtitlesError extends Error {
  constructor(
    readonly problem: OpenSubtitlesProblem,
    message: string,
    readonly status: number | null = null,
    readonly resetTimeUtc: string | null = null,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = 'OpenSubtitlesError';
  }
}

export interface OpenSubtitlesSession {
  token: string;
  /** Where this person's requests go from now on. */
  host: string;
  level: string;
  vip: boolean;
  allowedDownloads: number;
}

export interface SubtitleQuery {
  /** A film, or one episode if its own id is known. */
  tmdbId?: number | string;
  imdbId?: number | string;
  /** A show, with `season` and `episode`. */
  parentTmdbId?: number | string;
  parentImdbId?: number | string;
  season?: number;
  episode?: number;
  /** Free text, when there is no id. */
  query?: string;
  year?: number;
  type?: 'movie' | 'episode';
  /** Codes such as `hr`, `en`, `pt-br`. */
  languages?: string[];
  hearingImpaired?: 'include' | 'exclude' | 'only';
  page?: number;
}

export interface SubtitleResult {
  subtitleId: string;
  /** What `download` takes. */
  fileId: number;
  fileName: string;
  language: string;
  release: string;
  downloads: number;
  hearingImpaired: boolean;
  hd: boolean;
  fps: number | null;
  /** 0 to 10, meaningful only with votes. */
  rating: number;
  votes: number;
  fromTrusted: boolean;
  aiTranslated: boolean;
  machineTranslated: boolean;
  uploadedAt: string | null;
  uploader: string | null;
  /** A word, such as "trusted" or "gold member", not a score. */
  uploaderRank: string | null;
  title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
}

export interface SubtitleSearch {
  results: SubtitleResult[];
  page: number;
  totalPages: number;
  totalCount: number;
}

export interface SubtitleDownload {
  /** Temporary: usable for about three hours. Fetch it now, not later. */
  link: string;
  fileName: string;
  /** Downloads left today, after this one. */
  remaining: number;
  resetTimeUtc: string | null;
}

export interface OpenSubtitlesUser {
  level: string;
  vip: boolean;
  allowedDownloads: number;
  remainingDownloads: number;
  downloadsCount: number;
}

/**
 * The parameters as OpenSubtitles wants them, and the string they make.
 *
 * Sorted, lowercase, `+` for spaces, ids without leading zeros or `tt`, and
 * nothing that is merely a default. Getting this wrong still works -- through
 * a redirect -- which is why it is easy to get wrong and worth testing.
 */
export const searchParameters = (search: SubtitleQuery): string => {
  const parameters: [string, string][] = [];
  const add = (name: string, value: string | number | undefined | null) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    parameters.push([name, String(value).toLowerCase()]);
  };
  const id = (value: number | string | undefined) =>
    value === undefined || value === null ? undefined : String(value).replace(/^tt/i, '').replace(/^0+(?=\d)/, '');

  add('tmdb_id', id(search.tmdbId));
  add('imdb_id', id(search.imdbId));
  add('parent_tmdb_id', id(search.parentTmdbId));
  add('parent_imdb_id', id(search.parentImdbId));
  add('season_number', search.season);
  add('episode_number', search.episode);
  add('query', search.query?.trim().replace(/\s+/g, ' '));
  add('year', search.year);
  add('type', search.type);
  if (search.languages?.length) {
    add('languages', [...new Set(search.languages.map(code => code.trim().toLowerCase()).filter(Boolean))].sort().join(','));
  }
  if (search.hearingImpaired && search.hearingImpaired !== 'include') {
    add('hearing_impaired', search.hearingImpaired);
  }
  if (search.page && search.page > 1) {
    add('page', search.page);
  }

  return parameters
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${encodeURIComponent(value).replace(/%20/g, '+').replace(/%2C/g, ',')}`)
    .join('&');
};

export class OpenSubtitlesClient {
  private host = DEFAULT_HOST;

  constructor(
    private readonly options: {
      apiKey: string | null;
      /** `Xtream v1.0.33`. */
      userAgent: string;
      fetch: OpenSubtitlesFetch;
    }
  ) {}

  /**
   * Signs a person in. The password is sent to OpenSubtitles and kept nowhere
   * by this object; what comes back is a token for 24 hours.
   */
  async login(username: string, password: string): Promise<OpenSubtitlesSession> {
    const body = await this.call('POST', '/login', { body: { username, password }, login: true });
    const user = record(body['user']);
    const host = String(body['base_url'] ?? DEFAULT_HOST).toLowerCase();

    // Followed only to their own hosts. A response that named any other would
    // be sending the person's token somewhere it does not belong.
    this.host = HOSTS.has(host) ? host : DEFAULT_HOST;

    const token = typeof body['token'] === 'string' ? body['token'] : '';
    if (!token) {
      throw new OpenSubtitlesError('failed', 'OpenSubtitles did not return a session.');
    }

    return {
      token,
      host: this.host,
      level: String(user['level'] ?? ''),
      vip: user['vip'] === true,
      allowedDownloads: numberOr(user['allowed_downloads'], 0)
    };
  }

  /** Carries on a session made earlier, on another launch or another device. */
  resume(session: Pick<OpenSubtitlesSession, 'host'>): void {
    this.host = HOSTS.has(session.host) ? session.host : DEFAULT_HOST;
  }

  async logout(token: string): Promise<void> {
    try {
      await this.call('DELETE', '/logout', { token });
    } catch {
      // Freeing their resources is a courtesy; a failure changes nothing here.
    }
  }

  /** Searching costs nothing against the allowance. A token is optional. */
  async search(query: SubtitleQuery, token?: string): Promise<SubtitleSearch> {
    const body = await this.call('GET', `/subtitles?${searchParameters(query)}`, { token });
    const data = Array.isArray(body['data']) ? body['data'] : [];

    return {
      results: data.map(entry => toResult(record(entry))).filter((result): result is SubtitleResult => !!result),
      page: numberOr(body['page'], 1),
      totalPages: numberOr(body['total_pages'], 1),
      totalCount: numberOr(body['total_count'], data.length)
    };
  }

  /**
   * Spends one of today's downloads and returns the link to the file.
   *
   * WebVTT is asked for directly (`sub_format`), so a device has nothing to
   * convert. The link lasts about three hours and can be fetched more than
   * once, so a failed fetch can be retried without spending another.
   */
  async download(fileId: number, token: string, format: 'webvtt' | 'srt' = 'webvtt'): Promise<SubtitleDownload> {
    if (!token) {
      throw new OpenSubtitlesError('signed-out', 'Link an OpenSubtitles account to download subtitles.');
    }
    const body = await this.call('POST', '/download', { token, body: { file_id: fileId, sub_format: format } });

    if (numberOr(body['remaining'], 0) < 0) {
      // Over the allowance, said with a 200 rather than a 406 by some of their hosts.
      throw problemFor(406, body, false);
    }

    const link = typeof body['link'] === 'string' ? body['link'] : '';
    if (!/^https:\/\//.test(link)) {
      throw new OpenSubtitlesError('failed', 'OpenSubtitles did not return a file.');
    }

    return {
      link,
      fileName: String(body['file_name'] ?? ''),
      remaining: numberOr(body['remaining'], 0),
      resetTimeUtc: textOr(body['reset_time_utc'])
    };
  }

  /** The person's allowance, for the Account page. */
  async user(token: string): Promise<OpenSubtitlesUser> {
    const body = await this.call('GET', '/infos/user', { token });
    const data = record(body['data']);

    return {
      level: String(data['level'] ?? ''),
      vip: data['vip'] === true,
      allowedDownloads: numberOr(data['allowed_downloads'], 0),
      remainingDownloads: numberOr(data['remaining_downloads'], 0),
      downloadsCount: numberOr(data['downloads_count'], 0)
    };
  }

  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { token?: string; body?: unknown; login?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    if (!this.options.apiKey) {
      throw new OpenSubtitlesError('no-key', 'Subtitles are not set up on this service yet.');
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Api-Key': this.options.apiKey,
      'User-Agent': this.options.userAgent,
      'X-User-Agent': this.options.userAgent
    };
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Awaited<ReturnType<OpenSubtitlesFetch>>;
    let raw: string;
    try {
      response = await this.options.fetch(`https://${this.host}/api/v1${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
      raw = await response.text();
    } catch {
      throw new OpenSubtitlesError('unavailable', 'OpenSubtitles could not be reached. Try again later.');
    }

    let body: Record<string, unknown> = {};
    try {
      body = raw ? record(JSON.parse(raw)) : {};
    } catch {
      // An HTML error page from their edge, typically; judged by status alone.
    }

    if (response.status >= 200 && response.status < 300) {
      return body;
    }
    throw problemFor(response.status, body, !!options.login, response.headers?.get('ratelimit-reset') ?? null);
  }
}

/** A failure, in the few kinds a screen has something different to say about. */
export const problemFor = (
  status: number,
  body: Record<string, unknown>,
  atLogin: boolean,
  rateLimitReset: string | null = null
): OpenSubtitlesError => {
  const message = String(body['message'] ?? body['error'] ?? '');

  if ((status === 401 || status === 400) && atLogin && /username|password/i.test(message)) {
    return new OpenSubtitlesError(
      'bad-login',
      /email/i.test(message)
        ? 'OpenSubtitles wants your username here, not your email.'
        : 'OpenSubtitles did not accept that username and password.',
      status
    );
  }
  if (status === 401 && atLogin) {
    return new OpenSubtitlesError('bad-login', 'OpenSubtitles did not accept that username and password.', status);
  }
  if (status === 401) {
    return new OpenSubtitlesError('signed-out', 'Sign in to OpenSubtitles again.', status);
  }
  if (status === 403) {
    return new OpenSubtitlesError('no-key', 'OpenSubtitles refused this app. Its key may need replacing.', status);
  }
  if (status === 406) {
    return new OpenSubtitlesError(
      'allowance-used',
      'Today’s downloads are used up.',
      status,
      textOr(body['reset_time_utc'])
    );
  }
  if (status === 429) {
    const seconds = Number(rateLimitReset);
    return new OpenSubtitlesError(
      'rate-limited',
      'OpenSubtitles asked us to slow down. Try again in a moment.',
      status,
      null,
      Number.isFinite(seconds) && seconds > 0 ? seconds : null
    );
  }
  // An expired token comes back as a 500 saying so, not as a 401.
  if (status === 500 && /invalid|expired|token/i.test(message)) {
    return new OpenSubtitlesError('signed-out', 'Sign in to OpenSubtitles again.', status);
  }
  if (status >= 500) {
    return new OpenSubtitlesError('unavailable', 'OpenSubtitles is not answering properly. Try again later.', status);
  }
  return new OpenSubtitlesError('failed', 'OpenSubtitles could not do that.', status);
};

const toResult = (entry: Record<string, unknown>): SubtitleResult | null => {
  const attributes = record(entry['attributes']);
  const files = Array.isArray(attributes['files']) ? attributes['files'].map(record) : [];
  const file = files.find(candidate => Number.isInteger(candidate['file_id']));
  if (!file) {
    return null;
  }
  const uploader = record(attributes['uploader']);
  const feature = record(attributes['feature_details']);

  return {
    subtitleId: String(attributes['subtitle_id'] ?? entry['id'] ?? ''),
    fileId: file['file_id'] as number,
    fileName: String(file['file_name'] ?? ''),
    language: String(attributes['language'] ?? '').toLowerCase(),
    release: String(attributes['release'] ?? file['file_name'] ?? '').trim(),
    downloads: numberOr(attributes['download_count'], 0),
    hearingImpaired: attributes['hearing_impaired'] === true,
    hd: attributes['hd'] === true,
    fps: typeof attributes['fps'] === 'number' && attributes['fps'] > 0 ? attributes['fps'] : null,
    rating: numberOr(attributes['ratings'], 0),
    votes: numberOr(attributes['votes'], 0),
    fromTrusted: attributes['from_trusted'] === true,
    aiTranslated: attributes['ai_translated'] === true,
    machineTranslated: attributes['machine_translated'] === true,
    uploadedAt: textOr(attributes['upload_date']),
    uploader: textOr(uploader['name']),
    uploaderRank: textOr(uploader['rank']),
    title: textOr(feature['title'] ?? feature['movie_name']),
    year: typeof feature['year'] === 'number' ? feature['year'] : null,
    season: typeof feature['season_number'] === 'number' ? feature['season_number'] : null,
    episode: typeof feature['episode_number'] === 'number' ? feature['episode_number'] : null
  };
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const numberOr = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

const textOr = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
