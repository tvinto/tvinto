/**
 * Stalker (Ministra, "MAC") portals: a subscription that signs in the way a
 * MAG set-top box does, with an address and a MAC address instead of a
 * username and password (private plan: stalker-portals).
 *
 * There is no published specification. What is here is how portals behave as
 * open-source players have learned it, iptvnator (MIT) above all, whose
 * findings the comments name. tools/qa/fake-stalker.js answers the same way,
 * and nothing is ever tested against a real portal.
 *
 * Two rules from the provider side hold here as they do for Xtream: a portal
 * usually allows one connection, and reading a large one page by page is
 * exactly the sweep that gets an account blocked. So pages are read one after
 * another with a pause, never in parallel, and only when asked for.
 *
 * The MAC address is a password. It goes in the cookie a portal reads it
 * from and nowhere else: never into an error, a log line or a test.
 */

/** One request, as a platform's HTTP sends it: a GET with these headers. */
export interface StalkerRequest {
  url: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  timeoutMs: number;
}

/** What came back: the status and the body as text, since a refusal is plain text, not JSON. */
export type StalkerSend = (request: StalkerRequest) => Promise<{ status: number; text: string }>;

export type StalkerFailure =
  /** Nothing answered at the address. */
  | 'unreachable'
  /** Something answered, but not as a portal at any of the usual paths. */
  | 'not-a-portal'
  /** The portal does not know this MAC address, or turned it away. */
  | 'refused'
  /** The account exists and is blocked or expired; `message` is the portal's own words. */
  | 'blocked'
  /** The portal wants a login and password as well, and none was given or they were wrong. */
  | 'needs-login'
  /** An answer that was not what the portal should have said. */
  | 'bad-answer';

export class StalkerError extends Error {
  constructor(
    message: string,
    readonly failure: StalkerFailure
  ) {
    super(message);
    this.name = 'StalkerError';
  }
}

/** What a MAG250 says about itself (iptvnator's STALKER_STB_PROFILE_PARAMS): some portals check. */
const MAG_PROFILE: Readonly<Record<string, string>> = {
  ver: 'ImageDescription: 0.2.18-r14-pub-250; ImageDate: Fri Jan 15 15:20:44 EET 2016; PORTAL version: 5.6.0; API Version: JS API version: 328; STB API version: 134; Player Engine version: 0x566',
  stb_type: 'MAG250',
  hw_version: '1.7-BD-00',
  image_version: '218',
  client_type: 'STB',
  num_banks: '2',
  video_out: 'hdmi',
  hd: '1'
};

export const MAG_USER_AGENT = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250';

const TIMEOUT_MS = 15_000;
/** create_link is slower on some portals: it may start a transcoder. */
const LINK_TIMEOUT_MS = 25_000;
/** Between pages of a list: a portal is read gently. */
export const PAGE_PAUSE_MS = 250;
/** No list is read past this many pages: 14 to a page, that is 14,000 entries. */
export const MOST_PAGES = 1000;

/** "00:1a:79:aa:bb:cc", "00-1A-79-AA-BB-CC" or "001A79AABBCC" as a portal wants it, or null. */
export function normaliseMac(text: string): string | null {
  const hex = text.trim().replace(/[:\-.\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) {
    return null;
  }
  return hex.match(/../g)!.join(':');
}

/**
 * Where the API may be, for an address as somebody typed or pasted it
 * (iptvnator's buildStalkerEndpointCandidates): the address itself when it is
 * a .php file, then portal.php, server/load.php and
 * stalker_portal/server/load.php beside it. The `/c` people copy from a
 * browser is the landing page, not part of the API's path.
 */
export function endpointCandidates(address: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z]+:\/\//i.test(address.trim()) ? address.trim() : `http://${address.trim()}`);
  } catch {
    return [];
  }
  parsed.search = '';
  parsed.hash = '';
  const path = parsed.pathname.replace(/\/+$/, '');
  const at = (candidatePath: string) => {
    const candidate = new URL(parsed.href);
    candidate.pathname = candidatePath;
    return candidate.href;
  };
  const candidates: string[] = [];
  if (/\.php$/i.test(path)) {
    candidates.push(at(path));
  }
  const base = /\.php$/i.test(path)
    ? path.replace(/\/portal\.php$/i, '').replace(/\/server\/load\.php$/i, '').replace(/\/[^/]*\.php$/i, '')
    : path.replace(/\/c$/i, '');
  candidates.push(at(`${base}/portal.php`), at(`${base}/server/load.php`));
  if (!/\/stalker_portal(\/|$)/i.test(base)) {
    candidates.push(at(`${base}/stalker_portal/server/load.php`));
  }
  return [...new Set(candidates)];
}

/** A stream address from what create_link answers: "ffmpeg http://..." and the like, without the player's name. */
export function streamAddress(cmd: string): string {
  return cmd.trim().replace(/^(?:ffmpeg|ffrt\d?|auto|rtsp)\s+/i, '').trim();
}

/** What the portal says about the account, once signed in. */
export interface StalkerProfile {
  /** The account's name or login, when the portal gives one. */
  name: string;
  /** When the subscription ends, as the portal says it, or ''. */
  expires: string;
}

export interface StalkerGenre {
  id: string;
  title: string;
  /** Ministra's flag for adult genres. */
  censored: boolean;
}

export interface StalkerChannel {
  id: string;
  name: string;
  number: string;
  /** What create_link turns into a stream address. */
  cmd: string;
  logo: string;
  genreId: string;
  xmltvId: string;
  /** Hours of catch-up the portal keeps, 0 for none. */
  archiveHours: number;
}

export interface StalkerItem {
  id: string;
  name: string;
  cmd: string;
  categoryId: string;
  poster: string;
  description: string;
  year: string;
  rating: string;
  added: string;
  isSeries: boolean;
}

export interface StalkerSeason {
  id: string;
  name: string;
  /** Its episodes by number, as the portal lists them. */
  episodes: number[];
  cmd: string;
}

export interface StalkerProgramme {
  title: string;
  description: string;
  startMs: number;
  stopMs: number;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** Sha-1 of the MAC in capitals, hex: the `prehash` real boxes send, which some portals check. */
async function prehash(mac: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(mac.toUpperCase()));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A refusal, which portals send as plain text with status 200 (iptvnator's extractStalkerAuthFailureBody). */
const REFUSAL = /^\s*(?:authorization failed|access denied|unauthorized)\b/i;

export interface StalkerOptions {
  /** A login and password, for the portals that ask for one after the MAC (`do_auth`). */
  login?: { username: string; password: string };
  /** Replaced in tests, so they do not wait between pages. */
  pause?: (ms: number) => Promise<void>;
  /** Where the API was found last time, tried first; and told where it is found. */
  knownEndpoint?: string | null;
  foundEndpoint?: (endpoint: string) => void;
  timezone?: string;
}

/**
 * One portal account. `connect()` finds the API, shakes hands and checks the
 * account; everything else asks through it, shaking hands again once when the
 * portal says the token has gone.
 */
export class StalkerPortal {
  private endpoint: string | null = null;
  private token: string | null = null;
  private random = '';
  private readonly mac: string;

  constructor(
    private readonly send: StalkerSend,
    private readonly address: string,
    mac: string,
    private readonly options: StalkerOptions = {}
  ) {
    const normalised = normaliseMac(mac);
    if (!normalised) {
      throw new StalkerError('That is not a MAC address: twelve hexadecimal digits, like 00:1A:79:12:34:56.', 'refused');
    }
    this.mac = normalised;
  }

  /** Finds the API at the address, signs in and says what the portal knows about the account. */
  async connect(): Promise<StalkerProfile> {
    const found = endpointCandidates(this.address);
    // Where it was last time first: one handshake instead of three on a portal at its third path.
    const known = this.options.knownEndpoint;
    const candidates = known && found.includes(known) ? [known, ...found.filter(one => one !== known)] : found;
    if (!candidates.length) {
      throw new StalkerError('That is not an address.', 'not-a-portal');
    }
    let answered = false;
    for (const candidate of candidates) {
      let response: { status: number; text: string };
      try {
        response = await this.send(this.request(candidate, { type: 'stb', action: 'handshake', token: '', prehash: await prehash(this.mac), JsHttpRequest: '1-xml' }, false));
      } catch {
        continue;
      }
      answered = true;
      if (response.status !== 200) {
        continue;
      }
      if (REFUSAL.test(response.text)) {
        // The API is here and it said no to this MAC: no other path will say yes.
        throw new StalkerError('The portal does not accept this MAC address.', 'refused');
      }
      const token = text((parse(response.text) as { js?: { token?: unknown } } | null)?.js?.token);
      if (token) {
        this.endpoint = candidate;
        if (candidate !== known) {
          this.options.foundEndpoint?.(candidate);
        }
        this.token = token;
        this.random = text((parse(response.text) as { js?: { random?: unknown } }).js?.random);
        return this.profile();
      }
    }
    throw new StalkerError(
      answered ? 'Something answered at that address, but not a portal.' : 'Nothing answered at that address.',
      answered ? 'not-a-portal' : 'unreachable'
    );
  }

  private async profile(secondStep = false): Promise<StalkerProfile> {
    const js = (await this.call(
      {
        type: 'stb',
        action: 'get_profile',
        ...MAG_PROFILE,
        not_valid_token: '0',
        auth_second_step: secondStep ? '1' : '0',
        metrics: JSON.stringify({ mac: this.mac, model: 'MAG250', type: 'STB', random: this.random }),
        prehash: await prehash(this.mac),
        JsHttpRequest: '1-xml'
      },
      false
    )) as Record<string, unknown> | null;
    const status = Number(js?.['status'] ?? 0);
    if (status === 1) {
      throw new StalkerError(text(js?.['msg']) || text(js?.['block_msg']) || 'The portal has blocked this account.', 'blocked');
    }
    if (status === 2) {
      // Login and password as well (iptvnator: status 2 is do_auth, then get_profile again with auth_second_step).
      if (secondStep || !this.options.login) {
        throw new StalkerError('This portal asks for a login and password as well.', 'needs-login');
      }
      const done = await this.call({ type: 'stb', action: 'do_auth', login: this.options.login.username, password: this.options.login.password, JsHttpRequest: '1-xml' }, false);
      if (done !== true && done !== 'true' && done !== 1) {
        throw new StalkerError('The portal did not accept that login and password.', 'needs-login');
      }
      return this.profile(true);
    }
    return { name: text(js?.['fname']) || text(js?.['name']) || text(js?.['login']), expires: text(js?.['expire_billing_date']) };
  }

  /** The live genres, without "All". */
  async liveGenres(): Promise<StalkerGenre[]> {
    return asList(await this.call({ type: 'itv', action: 'get_genres', JsHttpRequest: '1-xml' })).flatMap(genre);
  }

  /**
   * Every channel. In one request where the portal has get_all_channels;
   * otherwise genre by genre, page by page. Adult genres' channels come only
   * where the portal lists them, as with "all" on a real portal.
   */
  async channels(): Promise<StalkerChannel[]> {
    const all = await this.call({ type: 'itv', action: 'get_all_channels', JsHttpRequest: '1-xml' });
    const rows = Array.isArray(all) ? all : asList((all as { data?: unknown } | null)?.data);
    if (rows.length) {
      return rows.flatMap(channel);
    }
    const found: StalkerChannel[] = [];
    for (const one of await this.liveGenres()) {
      found.push(...(await this.pages({ type: 'itv', action: 'get_ordered_list', genre: one.id })).flatMap(channel));
    }
    return found;
  }

  /** Film or show categories, without "All". */
  async categories(type: 'vod' | 'series'): Promise<StalkerGenre[]> {
    return asList(await this.call({ type, action: 'get_categories', JsHttpRequest: '1-xml' })).flatMap(genre);
  }

  /** Every film or show in a category, page by page. */
  async items(type: 'vod' | 'series', categoryId: string): Promise<StalkerItem[]> {
    return (await this.pages({ type, action: 'get_ordered_list', category: categoryId, sortby: 'added' })).flatMap(item);
  }

  /** A show's seasons, each with its episodes. */
  async seasons(showId: string): Promise<StalkerSeason[]> {
    return (await this.pages({ type: 'series', action: 'get_ordered_list', movie_id: showId })).flatMap(season);
  }

  /** What is on a channel now and next, from the portal's own guide. */
  async shortGuide(channelId: string): Promise<StalkerProgramme[]> {
    return asList(await this.call({ type: 'itv', action: 'get_short_epg', ch_id: channelId, size: '10', JsHttpRequest: '1-xml' })).flatMap(programme);
  }

  /**
   * The address to play something at, asked for just before it plays: on many
   * portals it works once, or for a minute. `episode` for a show's episode,
   * with the season's cmd.
   */
  async link(type: 'itv' | 'vod' | 'series', cmd: string, episode?: number): Promise<string> {
    const js = (await this.call(
      { type: type === 'series' ? 'vod' : type, action: 'create_link', cmd, ...(episode ? { series: String(episode) } : {}), forced_storage: '0', disable_ad: '0', download: '0', JsHttpRequest: '1-xml' },
      true,
      LINK_TIMEOUT_MS
    )) as { cmd?: unknown; error?: unknown } | null;
    const address = streamAddress(text(js?.cmd));
    if (!/^https?:\/\//i.test(address)) {
      throw new StalkerError(text(js?.error) || 'The portal gave no address to play.', 'bad-answer');
    }
    return address;
  }

  private async pages(query: Record<string, string>): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let total = Infinity;
    for (let page = 1; page <= MOST_PAGES && rows.length < total; page++) {
      if (page > 1) {
        await (this.options.pause ?? sleep)(PAGE_PAUSE_MS);
      }
      const js = (await this.call({ ...query, p: String(page), JsHttpRequest: '1-xml' })) as { data?: unknown; total_items?: unknown } | null;
      const data = asList(js?.data);
      total = Number(js?.total_items ?? data.length);
      rows.push(...data);
      if (!data.length) {
        break;
      }
    }
    return rows;
  }

  /** One request with the session, shaking hands again once if the portal says the token has gone. */
  private async call(query: Record<string, string>, retry = true, timeoutMs = TIMEOUT_MS): Promise<unknown> {
    if (!this.endpoint || !this.token) {
      throw new StalkerError('Not connected to the portal.', 'bad-answer');
    }
    let response: { status: number; text: string };
    try {
      response = await this.send(this.request(this.endpoint, query, true, timeoutMs));
    } catch {
      throw new StalkerError('The portal did not answer.', 'unreachable');
    }
    if (REFUSAL.test(response.text) || response.status === 401 || response.status === 403) {
      if (!retry) {
        throw new StalkerError('The portal does not accept this MAC address.', 'refused');
      }
      await this.shakeHandsAgain();
      return this.call(query, false, timeoutMs);
    }
    if (response.status !== 200) {
      throw new StalkerError(`The portal answered ${response.status}.`, 'bad-answer');
    }
    const body = parse(response.text) as { js?: unknown } | null;
    if (!body || !('js' in body)) {
      throw new StalkerError('The portal answered with something that was not its usual reply.', 'bad-answer');
    }
    return body.js;
  }

  private async shakeHandsAgain(): Promise<void> {
    const response = await this.send(this.request(this.endpoint!, { type: 'stb', action: 'handshake', token: '', prehash: await prehash(this.mac), JsHttpRequest: '1-xml' }, false));
    const token = text((parse(response.text) as { js?: { token?: unknown } } | null)?.js?.token);
    if (!token) {
      throw new StalkerError('The portal does not accept this MAC address.', 'refused');
    }
    this.token = token;
    this.random = text((parse(response.text) as { js?: { random?: unknown } }).js?.random);
    await this.profile();
  }

  private request(url: string, query: Record<string, string>, withToken: boolean, timeoutMs = TIMEOUT_MS): StalkerRequest {
    const headers: Record<string, string> = {
      Cookie: `mac=${encodeURIComponent(this.mac)}; stb_lang=en; timezone=${encodeURIComponent(this.options.timezone ?? 'Europe/Zagreb')}`,
      'User-Agent': MAG_USER_AGENT,
      'X-User-Agent': 'Model: MAG250; Link: WiFi',
      Accept: '*/*'
    };
    if (withToken && this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return { url, query, headers, timeoutMs };
  }
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const asList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value.filter(row => row && typeof row === 'object') as Record<string, unknown>[]) : [];

function genre(row: Record<string, unknown>): StalkerGenre[] {
  const id = text(row['id']);
  return id && id !== '*' ? [{ id, title: text(row['title']) || text(row['name']), censored: text(row['censored']) === '1' }] : [];
}

function channel(row: Record<string, unknown>): StalkerChannel[] {
  const id = text(row['id']);
  return id
    ? [{
        id,
        name: text(row['name']),
        number: text(row['number']),
        cmd: text(row['cmd']),
        logo: text(row['logo']),
        genreId: text(row['tv_genre_id']),
        xmltvId: text(row['xmltv_id']),
        archiveHours: Number(row['tv_archive']) === 1 ? Number(row['tv_archive_duration']) || 0 : 0
      }]
    : [];
}

function item(row: Record<string, unknown>): StalkerItem[] {
  const id = text(row['id']);
  return id
    ? [{
        id,
        name: text(row['name']),
        cmd: text(row['cmd']),
        categoryId: text(row['category_id']),
        poster: text(row['screenshot_uri']),
        description: text(row['description']),
        year: text(row['year']),
        rating: text(row['rating_imdb']) || text(row['rating_kinopoisk']),
        added: text(row['added']),
        isSeries: Number(row['is_series']) === 1
      }]
    : [];
}

function season(row: Record<string, unknown>): StalkerSeason[] {
  const id = text(row['id']);
  const episodes = Array.isArray(row['series']) ? (row['series'] as unknown[]).map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
  return id ? [{ id, name: text(row['name']), episodes, cmd: text(row['cmd']) }] : [];
}

function programme(row: Record<string, unknown>): StalkerProgramme[] {
  const start = Number(row['start_timestamp']);
  const stop = Number(row['stop_timestamp']);
  return Number.isFinite(start) && Number.isFinite(stop) && stop > start
    ? [{ title: text(row['name']), description: text(row['descr']), startMs: start * 1000, stopMs: stop * 1000 }]
    : [];
}
