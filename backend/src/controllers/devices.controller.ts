import { Request, Response } from 'express';
import { TypedRequest } from '../types/express';
import { ChangeSet, syncService } from '../services/sync.service';
import { errorResponse } from '../utils/errorHandler';
import { syncNow } from '../utils/syncClock';

/**
 * Reconciling one account across its devices.
 *
 * Distinct from sync.controller, which pulls the catalogue down from the
 * provider. This is about the small amount the user made themselves, and about
 * two phones agreeing on it.
 */

/**
 * Everything this account has changed since a given moment.
 *
 * A device with no `since` gets the lot, which is what a new phone needs. The
 * response carries the server's clock so the next call can quote that rather
 * than the device's own, which may be minutes out.
 */
export const pullChanges = (
  req: Request<Record<string, never>, unknown, never, { since?: string }>,
  res: Response
): void => {
  const since = (req.query.since || '').trim();

  // A malformed timestamp would otherwise be compared as a string against real
  // ones and quietly return the wrong slice of history.
  if (since && Number.isNaN(Date.parse(since))) {
    errorResponse(res, 'since must be an ISO timestamp', 400);
    return;
  }

  res.status(200).json({ success: true, data: syncService.changesSince(req.userId!, since) });
};

/** Takes a batch of changes from a device. */
export const pushChanges = (req: TypedRequest<Partial<ChangeSet>>, res: Response): void => {
  const batch = req.body;

  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    errorResponse(res, 'A change set is required', 400);
    return;
  }

  for (const field of [
    'favourites',
    'arrangements',
    'progress',
    'settings',
    'guideSources',
    'channelMappings',
    'deletions'
  ] as const) {
    const value = batch[field];
    if (value !== undefined && !Array.isArray(value)) {
      errorResponse(res, `${field} must be an array`, 400);
      return;
    }
  }

  try {
    const result = syncService.applyChanges(req.userId!, batch);

    // The pull that follows should start from now, not from whatever the
    // device thought the time was when it built this batch.
    res.status(200).json({
      success: true,
      data: { ...result, serverTime: syncNow() }
    });
  } catch (error) {
    console.error('Failed to apply a change set', error);
    errorResponse(res, 'Failed to apply the changes', 500);
  }
};

/** The account's preferences, for a client that only wants those. */
export const getSettings = (req: Request, res: Response): void => {
  res.status(200).json({ success: true, data: syncService.getSettings(req.userId!) });
};

export const saveSettings = (req: TypedRequest<Record<string, string>>, res: Response): void => {
  const settings = req.body;

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    errorResponse(res, 'Settings must be an object of keys and values', 400);
    return;
  }

  const offending = Object.entries(settings).find(([, value]) => typeof value !== 'string');
  if (offending) {
    errorResponse(res, `Setting "${offending[0]}" must be a string`, 400);
    return;
  }

  syncService.saveSettings(req.userId!, settings);
  res.status(200).json({ success: true, data: syncService.getSettings(req.userId!) });
};
