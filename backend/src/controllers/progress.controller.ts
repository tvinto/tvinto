import { Request, Response } from 'express';
import { TypedRequest } from '../types/express';
import { StreamType, WatchProgressInput } from '../../../shared/types';
import { progressService } from '../services/progress.service';
import { errorResponse } from '../utils/errorHandler';

const STREAM_TYPES: readonly StreamType[] = ['live', 'vod', 'series'];

/**
 * The account the request belongs to.
 *
 * Watch history is the user's, not the subscription's -- requireSession
 * guarantees this is populated for every route below.
 */
const accountOf = (req: Request) => req.userId!;

const asStreamType = (value: unknown): StreamType | null =>
  STREAM_TYPES.includes(value as StreamType) ? (value as StreamType) : null;

/** The recently watched entries for one section, newest first. */
export const getRecent = (
  req: Request<Record<string, never>, unknown, never, { type?: string; limit?: string }>,
  res: Response
): void => {
  const userId = accountOf(req);
  const type = asStreamType(req.query.type);

  if (!type) {
    errorResponse(res, 'A valid stream type is required', 400);
    return;
  }

  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
  res.status(200).json({ success: true, data: progressService.recent(userId, type, limit) });
};

/** Positions for a specific set of items, so a list can show resume bars. */
export const lookupProgress = (
  req: TypedRequest<{ type: StreamType; itemIds: string[] }>,
  res: Response
): void => {
  const userId = accountOf(req);
  const { itemIds } = req.body || {};
  const type = asStreamType(req.body?.type);

  if (!type || !Array.isArray(itemIds)) {
    errorResponse(res, 'A valid stream type and itemIds are required', 400);
    return;
  }

  res.status(200).json({
    success: true,
    data: progressService.forItems(userId, type, itemIds.map(String))
  });
};

/** Every episode position for one show, keyed by episode id. */
export const getSeriesProgress = (req: Request<{ seriesId: string }>, res: Response): void => {
  const userId = accountOf(req);
  const { seriesId } = req.params;

  if (!seriesId) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  res.status(200).json({ success: true, data: progressService.forSeries(userId, seriesId) });
};

export const saveProgress = (req: TypedRequest<WatchProgressInput>, res: Response): void => {
  const userId = accountOf(req);
  const body = req.body || ({} as WatchProgressInput);
  const type = asStreamType(body.type);

  if (!type || !body.itemId) {
    errorResponse(res, 'A valid stream type and itemId are required', 400);
    return;
  }

  const saved = progressService.record(userId, { ...body, type, itemId: String(body.itemId) });
  res.status(200).json({ success: true, data: saved });
};

export const deleteProgress = (
  req: TypedRequest<{ type: StreamType; itemId: string }>,
  res: Response
): void => {
  const userId = accountOf(req);
  const { itemId } = req.body || {};
  const type = asStreamType(req.body?.type);

  if (!type || !itemId) {
    errorResponse(res, 'A valid stream type and itemId are required', 400);
    return;
  }

  const removed = progressService.remove(userId, type, String(itemId));
  res.status(200).json({ success: true, data: { removed } });
};
