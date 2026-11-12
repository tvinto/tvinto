import { Category, SeriesInfo, Stream, StreamType } from '../types';
import {
  XtreamError,
  buildCatchUpUrl,
  buildGuideUrl,
  buildPlaybackUrl,
  categoriesAction,
  containerExtensionOf,
  isAuthenticated,
  normaliseCategories,
  normaliseStreams,
  resolveApiUrl,
  streamsAction
} from './protocol';
import { XtreamTransport } from './transport';

/** A subscription: where the provider is, and who to say you are. */
export interface XtreamAccount {
  serverUrl: string;
  username: string;
  password: string;
}

export interface AuthResponse {
  user_info: Record<string, unknown>;
  server_info?: Record<string, unknown>;
}

/**
 * A conversation with one Xtream account.
 *
 * Everything the app ever needs to ask a provider, in one place, over a
 * transport it is handed. That is what lets the same code run on the server
 * today and on a phone that has no backend to lean on -- the difference
 * between those is how a GET is performed, and nothing above it.
 *
 * It knows nothing about caching. A device will want to keep what it fetches,
 * and so does the backend, but neither is this object's business: mixing them
 * is what made the original impossible to lift out.
 */
export class XtreamClient {
  private readonly apiUrl: string;

  constructor(
    private readonly transport: XtreamTransport,
    private readonly account: XtreamAccount,
    /** Applied when a call does not ask for its own. */
    private readonly defaultTimeoutMs?: number
  ) {
    this.apiUrl = resolveApiUrl(account.serverUrl);
  }

  /**
   * Checks the credentials.
   *
   * A refusal arrives inside a 200 with auth: 0, so this cannot be left to the
   * status code alone.
   */
  async authenticate(timeoutMs?: number): Promise<AuthResponse> {
    const response = (await this.request({}, timeoutMs)) as AuthResponse | null;

    if (!response || !response.user_info) {
      throw new XtreamError('Invalid response from Xtream server', 401);
    }
    if (!isAuthenticated(response)) {
      throw new XtreamError('Invalid credentials', 401);
    }

    return response;
  }

  async getCategories(type: StreamType, timeoutMs?: number): Promise<Category[]> {
    const response = await this.request({ action: categoriesAction(type) }, timeoutMs);
    return normaliseCategories(response);
  }

  async getStreams(type: StreamType, categoryId?: string, timeoutMs?: number): Promise<Stream[]> {
    const params: Record<string, unknown> = { action: streamsAction(type) };
    if (categoryId) {
      params['category_id'] = categoryId;
    }

    const response = await this.request(params, timeoutMs);
    return normaliseStreams(response, type, categoryId);
  }

  /**
   * The full address of a whole-library listing, for a device that downloads
   * it to a file rather than through the transport (see `Catalogue.indexFrom`).
   *
   * It carries the username and password in its query string, as every Xtream
   * request does. Never log it.
   */
  streamsAddress(type: StreamType): string {
    const query = new URLSearchParams({
      username: this.account.username,
      password: this.account.password,
      action: streamsAction(type)
    });
    return `${this.apiUrl}?${query.toString()}`;
  }

  /**
   * The container a film is actually stored in, or null.
   *
   * Xtream serves a film at a path ending in its real extension, and asking for
   * an .mkv as .mp4 gets a refusal rather than the film. The extension is not
   * reliably in `get_vod_streams` -- this provider omits it there entirely --
   * so the only dependable source is this call, per film.
   *
   * The exact counterpart of what makes shows work: `get_series_info` returns
   * each episode's container, which is why episodes have always played and
   * films have not.
   */
  async getVodContainerExtension(vodId: string, timeoutMs?: number): Promise<string | null> {
    return containerExtensionOf(await this.getVodInfo(vodId, timeoutMs));
  }

  /**
   * A film's details as the provider sends them (`{ info, movie_data }`).
   *
   * One request, for one film someone is looking at -- never for a list.
   * Undecoded, like the guide: what to read out of it is the caller's business
   * (the container here, the TMDB id in shared/opensubtitles/identify.ts).
   */
  async getVodInfo(vodId: string, timeoutMs?: number): Promise<unknown> {
    return this.request({ action: 'get_vod_info', vod_id: vodId }, timeoutMs);
  }

  async getSeriesInfo(seriesId: string, timeoutMs?: number): Promise<SeriesInfo> {
    const response = await this.request(
      { action: 'get_series_info', series_id: seriesId },
      timeoutMs
    );
    return response as SeriesInfo;
  }

  /**
   * The next few programmes for a channel, as the provider sends them.
   *
   * Undecoded: Xtream base64-encodes the titles and descriptions, and the
   * decoding has its own home. Handing back what arrived keeps this object to
   * one job.
   */
  async getShortEPG(streamId: string, limit?: number, timeoutMs?: number): Promise<unknown> {
    const params: Record<string, unknown> = { action: 'get_short_epg', stream_id: streamId };
    if (limit) {
      params['limit'] = limit;
    }
    return this.request(params, timeoutMs);
  }

  /** The whole guide in one call, which most providers make expensive. */
  async getAllEPG(timeoutMs?: number): Promise<unknown> {
    return this.request({ action: 'get_simple_data_table' }, timeoutMs);
  }

  /**
   * Where a stream plays from.
   *
   * No request: the URL is built from the credentials. That is why the browser
   * never gets one, and why a native client can use it directly.
   */
  playbackUrl(type: StreamType, streamId: string, extension?: string): string {
    return buildPlaybackUrl(this.account.serverUrl, this.account, type, streamId, extension);
  }

  /**
   * Where a stretch of a channel's past plays from. `start` is in the
   * provider's clock (`providerClockTime`). Carries credentials: never logged.
   */
  catchUpUrl(streamId: string, start: string, minutes: number, extension: 'm3u8' | 'ts' = 'm3u8'): string {
    return buildCatchUpUrl(this.account.serverUrl, this.account, streamId, start, minutes, extension);
  }

  /**
   * Where this subscription serves its own guide.
   *
   * Here rather than at the caller because the credentials are this object's
   * and should stay that way -- a caller that could build this URL for itself
   * would be a caller holding the password.
   */
  guideUrl(): string {
    return buildGuideUrl(this.account.serverUrl, this.account);
  }

  /**
   * One call to the provider.
   *
   * The credentials go on every request -- Xtream has no notion of a session,
   * so each one carries them afresh.
   */
  private async request(
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    const response = await this.transport.get(
      this.apiUrl,
      { username: this.account.username, password: this.account.password, ...params },
      timeoutMs ?? this.defaultTimeoutMs
    );

    if (response.status !== 200) {
      throw new XtreamError(`Xtream server returned status ${response.status}`, response.status);
    }
    if (response.data === null || response.data === undefined || response.data === '') {
      throw new XtreamError('Empty response from Xtream server', 502);
    }

    return response.data;
  }
}
