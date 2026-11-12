import { Category, Stream, StreamType } from '../types';

/**
 * What an Xtream server expects and what it sends back.
 *
 * Pure, and deliberately knows nothing about how a request is made. The
 * backend reaches the provider with axios; a phone will reach it with the
 * platform's own HTTP, without a browser's rules about origins in the way.
 * Everything either of them needs to know about the protocol itself -- which
 * action names go with which content, how a playback URL is spelled, and the
 * several shapes a server might answer in -- belongs here, once.
 *
 * The quirks below are not hypothetical. They were all found against a real
 * provider, and losing them by rewriting this per platform is exactly what
 * this module exists to prevent.
 */

/** A protocol-level failure, carrying an HTTP status the callers already speak. */
export class XtreamError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'XtreamError';
  }
}

/** The action parameter for listing categories of a given type. */
export function categoriesAction(type: StreamType): string {
  switch (type) {
    case 'live':
      return 'get_live_categories';
    case 'vod':
      return 'get_vod_categories';
    case 'series':
      return 'get_series_categories';
    default:
      throw new XtreamError(`Unsupported stream type: ${type}`, 400);
  }
}

/** The action parameter for listing streams of a given type. */
export function streamsAction(type: StreamType): string {
  switch (type) {
    case 'live':
      return 'get_live_streams';
    case 'vod':
      return 'get_vod_streams';
    case 'series':
      // Not get_series_streams: a series is a container, and this is the call
      // that lists the containers rather than anything playable.
      return 'get_series';
    default:
      throw new XtreamError(`Unsupported stream type: ${type}`, 400);
  }
}

/**
 * The address of the API endpoint, given whatever the user typed.
 *
 * People enter a bare host, a host with a port, or the full path to
 * player_api.php. All three should work, and a wrong one should be refused
 * here rather than becoming a confusing failure a request later.
 */
export function resolveApiUrl(serverUrl: string | undefined | null): string {
  const raw = (serverUrl ?? '').trim();

  if (!raw) {
    throw new XtreamError('No Xtream server URL provided', 400);
  }

  const normalised = raw.includes('player_api.php')
    ? raw
    : `${raw.replace(/\/+$/, '')}/player_api.php`;

  try {
    new URL(normalised);
  } catch {
    throw new XtreamError(`Invalid Xtream server URL: ${normalised}`, 400);
  }

  return normalised;
}

/**
 * Where a stream is actually played from.
 *
 * Xtream puts the credentials in the path, which is why the browser never
 * builds one of these -- it would end up in the DOM and in any Referer header.
 * A native client has no such exposure and can use it directly.
 *
 * The extension matters: players choose their pipeline from it, and an
 * extensionless URL has hls.js sit out while the browser fails on the
 * manifest.
 */
export function buildPlaybackUrl(
  serverUrl: string | undefined | null,
  credentials: { username: string; password: string },
  type: StreamType,
  streamId: string,
  extension?: string
): string {
  // Playback lives at the server root, not under player_api.php.
  const base = resolveApiUrl(serverUrl).replace(/\/player_api\.php.*$/, '');
  const { username, password } = credentials;

  switch (type) {
    case 'live':
      return `${base}/live/${username}/${password}/${streamId}.${extension || 'm3u8'}`;
    case 'vod':
      return `${base}/movie/${username}/${password}/${streamId}.${extension || 'mp4'}`;
    case 'series':
      return `${base}/series/${username}/${password}/${streamId}.${extension || 'mp4'}`;
    default:
      throw new XtreamError(`Unsupported stream type: ${type}`, 400);
  }
}

/**
 * Where a stretch of a channel's past plays from (see catchUp.ts).
 *
 * `start` is already in the provider's clock, "2026-09-26:21-09"; turning a
 * moment into that is `providerClockTime`'s job. HLS by default, because that
 * is the form a player can seek in: as .ts the provider sends one stream and
 * answers a byte range with the start of it again.
 *
 * Carries the credentials in its path, like every playback address. Never log it.
 */
export function buildCatchUpUrl(
  serverUrl: string | undefined | null,
  credentials: { username: string; password: string },
  streamId: string,
  start: string,
  minutes: number,
  extension: 'm3u8' | 'ts' = 'm3u8'
): string {
  const base = resolveApiUrl(serverUrl).replace(/\/player_api\.php.*$/, '');
  const { username, password } = credentials;
  return `${base}/timeshift/${username}/${password}/${Math.max(1, Math.round(minutes))}/${start}/${streamId}.${extension}`;
}

/**
 * Where the subscription serves its own guide.
 *
 * Xtream publishes XMLTV at `xmltv.php` on the same host, authenticated the
 * same way, so the provider's guide is not a special kind of source -- it is
 * an ordinary one whose address can be worked out instead of typed. Which
 * matters most on a television, where typing anything is a chore.
 *
 * The credentials go in the query string here rather than the path, which is
 * the shape Xtream uses for this endpoint. Either way the result is a
 * credential and is treated as one: see safeToLog. It is synced only
 * encrypted.
 */
export function buildGuideUrl(
  serverUrl: string | undefined | null,
  credentials: { username: string; password: string }
): string {
  const base = resolveApiUrl(serverUrl).replace(/\/player_api\.php.*$/, '');
  const url = new URL(`${base}/xmltv.php`);

  url.searchParams.set('username', credentials.username);
  url.searchParams.set('password', credentials.password);

  return url.toString();
}

/**
 * Whether an authentication response says the credentials are good.
 *
 * Xtream does not use status codes for this. A wrong password comes back as
 * HTTP 200 with `auth: 0` in the body, which is why a bare 403 from one of
 * these servers means the edge refused the request and says nothing at all
 * about the account.
 */
export function isAuthenticated(response: unknown): boolean {
  const userInfo = (response as { user_info?: { auth?: unknown } } | null)?.user_info;
  if (!userInfo) {
    return false;
  }
  return Number(userInfo.auth ?? 1) === 1;
}

/**
 * Flattens whatever a server sent into a list.
 *
 * Most answer with an array. Some answer with an object keyed by category or
 * by a numeric index, and some of those values are themselves arrays. Treating
 * only the first case as valid means the others silently produce nothing.
 */
export function toList(response: unknown): Record<string, unknown>[] {
  if (!response) {
    return [];
  }
  if (Array.isArray(response)) {
    return response as Record<string, unknown>[];
  }
  if (typeof response !== 'object') {
    return [];
  }

  const values = Object.values(response as Record<string, unknown>);
  return values.flatMap(value =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : [value as Record<string, unknown>]
  );
}

export function normaliseCategories(response: unknown): Category[] {
  return toList(response)
    .filter(item => item && item['category_id'] != null)
    .map(item => ({
      category_id: String(item['category_id']),
      category_name: String(item['category_name'] ?? ''),
      parent_id: String(item['parent_id'] ?? '0')
    }));
}

/**
 * Turns a stream listing into something uniform.
 *
 * Series are the awkward case: many servers name the id `series_id`, the
 * artwork `cover`, and the title `title`, none of which match what the rest of
 * the app expects. Rows with no id or no name are dropped rather than stored,
 * because they cannot be played, cannot be favourited, and violate NOT NULL on
 * the way into the cache.
 */
export function normaliseStreams(
  response: unknown,
  type: StreamType,
  categoryId?: string
): Stream[] {
  let items = toList(response);

  if (type === 'series') {
    items = items.map(item => ({
      ...item,
      stream_id: item['stream_id'] ?? item['series_id'] ?? item['id'] ?? null,
      name: item['name'] ?? item['title'] ?? '',
      stream_icon:
        item['stream_icon'] ?? item['cover'] ?? item['cover_big'] ?? item['backdrop_path'] ?? '',
      category_id: item['category_id'] ?? item['categoryId'] ?? item['category'] ?? null,
      // A show has no `added`; `last_modified` is when the provider last
      // changed it, which is when an episode arrived -- the order "Recently
      // added" means for a show. Without it every show sorted as never added,
      // and "Recently added" was A to Z (28 September). "0" when
      // neither is given, so a row normalised since always says something;
      // see storedBeforeKept in catalogue.ts.
      added: String(item['added'] ?? item['last_modified'] ?? '0')
    }));
  }

  items = items.filter(
    item => item && item['stream_id'] != null && item['name'] && String(item['name']).length > 0
  );

  // A live row always says whether it has catch-up, 0 when the provider said
  // nothing: a row without it is one stored before this was kept, and gets
  // fetched again (Catalogue.streams). Numbers, because providers send both.
  if (type === 'live') {
    items = items.map(item => ({
      ...item,
      tv_archive: Number(item['tv_archive']) === 1 ? 1 : 0,
      tv_archive_duration: Number(item['tv_archive_duration']) > 0 ? Number(item['tv_archive_duration']) : 0
    }));
  }

  // Plenty of servers ignore the category_id parameter on get_series and
  // return the whole catalogue, so the filter has to be applied again here --
  // after the aliasing above, since that is what put category_id in place.
  if (type === 'series' && categoryId) {
    items = items.filter(item => String(item['category_id']) === String(categoryId));
  }

  return items as unknown as Stream[];
}

/**
 * The container extension out of a `get_vod_info` response.
 *
 * Providers disagree about where it sits: most put it under `movie_data`, some
 * at the top level, and some spell it with the leading dot they use in the
 * path. All three are read, and the dot stripped, because the caller is going
 * to add one.
 *
 * Null when there is nothing usable, which the caller should treat as "carry on
 * with the default" rather than as a failure -- a film that plays as .mp4 is
 * the common case, and refusing to build a URL would break the films that
 * currently work.
 */
export function containerExtensionOf(response: unknown): string | null {
  const body = response as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return null;
  }

  const movieData = body['movie_data'] as Record<string, unknown> | undefined;
  const raw = movieData?.['container_extension'] ?? body['container_extension'];

  if (typeof raw !== 'string') {
    return null;
  }

  const extension = raw.trim().replace(/^\./, '').toLowerCase();

  // A sanity check rather than a whitelist: containers this app has never heard
  // of are still fine, but anything with a slash or a query in it did not come
  // from this field and would build a URL pointing somewhere else entirely.
  return /^[a-z0-9]{2,5}$/.test(extension) ? extension : null;
}

/**
 * Whether a failure was the provider failing to serve us, rather than
 * answering about this particular request.
 *
 * A timeout, a request that got no response, and any 5xx are all the server's
 * own trouble. A 403 counts too, for the reason given above: these servers
 * report bad credentials as a 200, so a 403 came from infrastructure.
 *
 * A 401 is deliberately absent. That is an answer, and it refuses.
 */
export function isProviderUnreachable(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  return (
    status === 403 || status === 408 || status === 502 || (typeof status === 'number' && status >= 500)
  );
}
