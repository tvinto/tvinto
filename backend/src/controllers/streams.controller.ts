import { Request, Response, NextFunction } from 'express';
import { TypedRequest } from '../types/express';
import { StreamsResponse, CategoryResponse } from '../types/api.types';
import {
  CATEGORY_SORTS,
  CategorySort,
  STREAM_SORTS,
  StreamSort,
  StreamType
} from '../../../shared/types';
import { categoryScope, streamScope } from '../../../shared/xtream/ordering';
import { EPGRow, Viewer, xtreamService } from '../services/xtream.service';
import { errorResponse } from '../utils/errorHandler';
import { db } from '../utils/database';
import { resolveSession } from '../middleware/requireSession';
import { playbackTickets } from '../utils/playbackTickets';

type GetCategoriesParams = { type: StreamType };
type GetStreamsParams = { categoryId: string; type: StreamType };
type SearchStreamsBody = { query: string; types: StreamType[] };

/**
 * Credentials for the caller, resolved from their session token by
 * requireSession. Every handler below is mounted behind that middleware, so
 * this is always populated.
 */
const credentialsOf = (req: Request) => req.xtream!;

/**
 * The caller as both owners at once: the account their favourites and
 * arranging belong to, and the subscription whose catalogue they are reading.
 */
const viewerOf = (req: Request): Viewer => ({
  userId: req.userId!,
  providerUsername: req.xtream!.username,
  providerPassword: req.xtream!.password,
  serverUrl: req.xtream!.serverUrl
});

/**
 * Placeholder for the request-body slot of Express's Request generics, where
 * `{}` would accept any non-nullish value. The response-body slot has to stay
 * loose, since Express resolves its overloads against it.
 */
type NoBody = Record<string, never>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type AnyResBody = any;

/** Falls back to the default when a client sends an unknown sort. */
const asCategorySort = (value: unknown): CategorySort =>
  CATEGORY_SORTS.includes(value as CategorySort) ? (value as CategorySort) : 'name_asc';

const asStreamSort = (value: unknown): StreamSort =>
  STREAM_SORTS.includes(value as StreamSort) ? (value as StreamSort) : 'name_asc';

export const getCategories = async (
  req: Request<GetCategoriesParams, AnyResBody, NoBody, { sort?: string }>,
  res: Response<CategoryResponse>,
  _next: NextFunction
): Promise<void> => {
  const { type } = req.params;
  const sort = asCategorySort(req.query.sort);

  if (!type) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  try {
    const categories = await xtreamService.getCategories(viewerOf(req), type, sort);
    res.status(200).json({ 
      success: true, 
      data: categories 
    });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch categories: ' + err.message, 500);
  }
};

export const getStreams = async (
  req: Request<GetStreamsParams, AnyResBody, NoBody, { sort?: string }>,
  res: Response<StreamsResponse>,
  _next: NextFunction
): Promise<void> => {
  const { categoryId, type } = req.params;
  const sort = asStreamSort(req.query.sort);

  if (!categoryId || !type) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  try {
    const streams = await xtreamService.getStreams(viewerOf(req), type, categoryId, sort);
    res.status(200).json({ 
      success: true, 
      data: streams 
    });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch streams: ' + err.message, 500);
  }
};

export const searchStreams = async (
  req: TypedRequest<SearchStreamsBody>,
  res: Response<StreamsResponse>,
  _next: NextFunction
): Promise<void> => {
  const { query, types } = req.body;
  const { username } = credentialsOf(req);

  if (!query || !types?.length) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  try {
    // Search in database instead of making API calls (much faster)
    const searchResults = await xtreamService.searchStreamsInDatabase(query, types, username);

    res.status(200).json({ 
      success: true, 
      data: searchResults 
    });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Search failed: ' + err.message, 500);
  }
};

export const getStreamInfo = async (
  req: Request<Record<string, string>, unknown, unknown, { stream_id: string; type: StreamType }>,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { stream_id, type } = req.query;
  const { username, password, serverUrl } = credentialsOf(req);

  if (!stream_id || !type) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  try {
    const streamInfo = await xtreamService.getStreamInfo(username, password, stream_id, type, serverUrl);
    res.status(200).json({ 
      success: true, 
      data: streamInfo 
    });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch stream info: ' + err.message, 500);
  }
};

export const getSeriesInfo = async (
  req: Request<{ series_id: string }>,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { series_id } = req.params;
  const { username, password, serverUrl } = credentialsOf(req);

  if (!series_id) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  try {
    const seriesInfo = await xtreamService.getSeriesInfo(username, password, series_id, serverUrl);
    res.status(200).json({ 
      success: true, 
      data: seriesInfo 
    });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch series info: ' + err.message, 500);
  }
};

export const getEPG = async (
  req: Request<{ stream_id: string }, unknown, unknown, { limit?: string }>,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { stream_id } = req.params;
  const { limit } = req.query;
  const { username, password, serverUrl } = credentialsOf(req);

  if (!stream_id) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  try {
    const epg = await xtreamService.getEPG(username, password, stream_id, limit ? parseInt(limit) : undefined, serverUrl);
    res.status(200).json({ 
      success: true, 
      data: epg 
    });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch EPG: ' + err.message, 500);
  }
};

export const getEPGShort = async (
  req: Request<{ stream_id: string }>,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { stream_id } = req.params;
  const { username, password, serverUrl } = credentialsOf(req);

  if (!stream_id) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  try {
    const epg = await xtreamService.getEPGShort(username, password, stream_id, serverUrl);
    res.status(200).json({ 
      success: true, 
      data: epg 
    });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch EPG: ' + err.message, 500);
  }
};

export const getAllEPG = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { username, password, serverUrl } = credentialsOf(req);

  try {
    const epg = await xtreamService.getAllEPG(username, password, serverUrl);
    res.status(200).json({ 
      success: true, 
      data: epg 
    });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch EPG: ' + err.message, 500);
  }
};

export const getExternalEPG = async (
  req: TypedRequest<{ url: string; format?: string }>,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { url, format = 'xml' } = req.body;

  if (!url) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  try {
    const epg = await xtreamService.getExternalEPG(url, format);
    res.status(200).json({ 
      success: true, 
      data: epg 
    });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch external EPG: ' + err.message, 500);
  }
};

/** The favourited streams for a type, ready to render like any other list. */
export const getFavorites = (
  req: Request<NoBody, AnyResBody, NoBody, { type?: StreamType; sort?: string }>,
  res: Response
): void => {
  const type = (req.query.type || 'live') as StreamType;
  const sort = asStreamSort(req.query.sort);

  try {
    res.status(200).json({
      success: true,
      data: xtreamService.getFavorites(viewerOf(req), type, sort)
    });
  } catch (error) {
    errorResponse(res, 'Failed to fetch favourites: ' + (error as Error).message, 500);
  }
};

/** Just the ids, for marking which rows in a list are already favourited. */
export const getFavoriteIds = (
  req: Request<NoBody, AnyResBody, NoBody, { type?: StreamType }>,
  res: Response
): void => {
  const type = (req.query.type || 'live') as StreamType;
  res.status(200).json({ success: true, data: xtreamService.getFavoriteIds(req.userId!, type) });
};

export const addFavorite = (
  req: TypedRequest<{ streamId: string; type: StreamType; name?: string }>,
  res: Response
): void => {
  const { streamId, type } = req.body || {};

  if (!streamId || !type) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  // The name rides along so the row can be re-matched if the provider
  // reissues its ids.
  xtreamService.addFavorite(req.userId!, type, streamId, req.body?.name);
  res.status(200).json({ success: true, data: { streamId, favorite: true } });
};

export const removeFavorite = (
  req: TypedRequest<{ streamId: string; type: StreamType }>,
  res: Response
): void => {
  const { streamId, type } = req.body || {};

  if (!streamId || !type) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  xtreamService.removeFavorite(req.userId!, type, streamId);
  res.status(200).json({ success: true, data: { streamId, favorite: false } });
};

/**
 * Builds the storage key for a manual ordering. Categories are ordered per
 * stream type; streams are ordered within a single category.
 */
const scopeFor = (kind: string, type: StreamType, categoryId?: string): string | null => {
  if (kind === 'category') {
    return categoryScope(type);
  }
  if (kind === 'stream' && categoryId) {
    return streamScope(type, categoryId);
  }
  return null;
};

export const getManualOrder = (
  req: Request<NoBody, AnyResBody, NoBody, { kind?: string; type?: StreamType; categoryId?: string }>,
  res: Response
): void => {
  const { kind, type, categoryId } = req.query;

  const scope = kind && type ? scopeFor(kind, type, categoryId) : null;
  if (!scope) {
    errorResponse(res, 'Missing or invalid ordering scope', 400);
    return;
  }

  res.status(200).json({
    success: true,
    data: { scope, itemIds: xtreamService.getManualOrder(req.userId!, scope) }
  });
};

export const saveManualOrder = (
  req: TypedRequest<{
    kind: string;
    type: StreamType;
    categoryId?: string;
    itemIds: string[];
    names?: Record<string, string>;
  }>,
  res: Response
): void => {
  const { kind, type, categoryId, itemIds } = req.body || {};

  const scope = kind && type ? scopeFor(kind, type, categoryId) : null;
  if (!scope || !Array.isArray(itemIds)) {
    errorResponse(res, 'Missing or invalid ordering scope', 400);
    return;
  }

  xtreamService.saveManualOrder(req.userId!, scope, itemIds.map(String), req.body?.names);
  res.status(200).json({ success: true, data: { scope, saved: itemIds.length } });
};

/**
 * Issues a short-lived ticket the player can put in a URL.
 *
 * A <video> element cannot send an Authorization header, so the session token
 * itself must not be used here: it would end up in the DOM and in access logs,
 * which is what this whole change exists to prevent. The ticket is single-
 * purpose, expires quickly, and reveals nothing about the credentials.
 */
export const createPlaybackTicket = async (
  req: TypedRequest<{ type: StreamType; streamId: string; extension?: string }>,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { type, streamId, extension } = req.body || {};

  if (!type || !streamId) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  // A film whose container nobody told us about has to be asked about, because
  // the provider serves it at a path ending in that container and refuses any
  // other. The caller usually knows for an episode and never knows for a film.
  let resolved = extension;
  if (type === 'vod' && !resolved) {
    try {
      resolved = (await xtreamService.vodExtensionFor(credentialsOf(req), streamId)) || undefined;
    } catch (error) {
      // Falling through to the default is better than refusing to play: it is
      // what happened before this existed, and it is right for every film that
      // really is an .mp4.
      console.warn(`Could not resolve the container for film ${streamId}`, error);
    }
  }

  const ticket = playbackTickets.issue(req.sessionToken!, {
    type,
    streamId,
    extension: resolved
  });

  // The URL keeps the media extension: players choose their pipeline from it,
  // and an extensionless URL makes hls.js sit out and the browser fail on the
  // manifest.
  const suffix = type === 'live' ? 'm3u8' : resolved || 'mp4';

  res.status(200).json({
    success: true,
    data: { url: `/api/streams/play/${ticket}.${suffix}` }
  });
};

/** Redirects a ticket to the real provider URL, which carries the credentials. */
export const playStream = (req: Request<{ ticket: string }>, res: Response): void => {
  // Strip the media extension added for the player's benefit.
  const claim = playbackTickets.redeem(req.params.ticket.replace(/\.[a-z0-9]+$/i, ''));

  if (!claim) {
    errorResponse(res, 'Playback link expired or invalid', 401);
    return;
  }

  // Resolved the same way as any other request: an account session reads its
  // subscription now, so a ticket issued before the credentials were renewed
  // still redeems against the current ones.
  const session = resolveSession(claim.sessionToken);
  if (!session?.credentials) {
    errorResponse(res, 'Session expired or invalid', 401);
    return;
  }

  const target = xtreamService.buildPlaybackUrl(
    session.credentials,
    claim.type,
    claim.streamId,
    claim.extension
  );

  // Keep the credential-bearing URL out of Referer headers on any onward request.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(302, target);
};

export const getNowEPG = async (
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { username } = credentialsOf(req);
  try {
    const now = await xtreamService.getNowEPGForUser(username);
    res.status(200).json({ success: true, data: now });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch now EPG: ' + err.message, 500);
  }
};

export const refreshEPGForStreams = async (
  req: TypedRequest<{ streamIds: string[]; ttlHours?: number }>,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { streamIds, ttlHours } = req.body || {};
  const { username, password, serverUrl } = credentialsOf(req);
  if (!Array.isArray(streamIds) || streamIds.length === 0) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }
  try {
    const result = await xtreamService.refreshEPGForStreamIds(username, password, streamIds, serverUrl, ttlHours ?? 2);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to refresh EPG: ' + err.message, 500);
  }
};

export const pruneEPG = async (
  req: Request<Record<string, string>, unknown, unknown, { olderThanHours?: string }>,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { olderThanHours } = req.query;
  const { username } = credentialsOf(req);
  try {
    const changes = await xtreamService.pruneOldEPG(username, olderThanHours ? parseInt(olderThanHours) : 72);
    res.status(200).json({ success: true, data: { deleted: changes } });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to prune EPG: ' + err.message, 500);
  }
};

export const getNowEPGForStreams = async (
  req: TypedRequest<{ streamIds: string[] }>,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { streamIds } = req.body || {};
  const { username } = credentialsOf(req);
  if (!Array.isArray(streamIds) || streamIds.length === 0) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }
  try {
    const mapping = await xtreamService.getNowEPGForStreamIds(username, streamIds);
    res.status(200).json({ success: true, data: mapping });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch now EPG for streams: ' + err.message, 500);
  }
};

export const getEPGFromDbForStreams = async (
  req: TypedRequest<{ streamIds: string[] }>,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  const { streamIds } = req.body || {};
  const { username } = credentialsOf(req);
  if (!Array.isArray(streamIds) || streamIds.length === 0) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }
  try {
    const placeholders = streamIds.map(() => '?').join(',');
    const sql = `SELECT e.*, s.stream_id FROM epg_listings e JOIN streams s ON s.epg_channel_id = e.epg_channel_id AND s.username = e.username WHERE s.username = ? AND s.stream_id IN (${placeholders}) ORDER BY e.start`;
    const rows = db.prepare(sql).all(username, ...streamIds) as (EPGRow & { stream_id: string })[];
    const map: Record<string, Pick<EPGRow, 'title' | 'description' | 'lang' | 'start' | 'stop'>[]> = {};
    for (const r of rows) {
      const key = String(r.stream_id);
      if (!map[key]) map[key] = [];
      map[key].push({
        title: r.title,
        description: r.description,
        lang: r.lang,
        start: r.start,
        stop: r.stop
      });
    }
    res.status(200).json({ success: true, data: map });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to fetch EPG from DB: ' + err.message, 500);
  }
};
