import { Request, Response, NextFunction } from 'express';
import { TypedRequest } from '../types/express';
import { SyncStatusResponse } from '../types/api.types';
import { StreamType, SyncTypeDetail } from '../../../shared/types';
import { xtreamService, SyncCancelledError } from '../services/xtream.service';
import { errorResponse } from '../utils/errorHandler';

interface SyncDataBody {
  type?: StreamType;
}

interface SyncStatusParams {
  type: StreamType;
}

export const syncData = async (
  req: TypedRequest<SyncDataBody>,
  res: Response<{ 
    success: boolean; 
    message?: string; 
    syncedItems?: number; 
    details?: SyncTypeDetail[]; 
  }>,
  _next: NextFunction
): Promise<void> => {
  try {
    const { type } = req.body;
    const { username, password, serverUrl } = req.xtream!;


    const result = await xtreamService.syncData(type, username, password, serverUrl);
    
    res.status(200).json({
      success: result.success,
      message: result.message ?? 'Sync completed successfully',
      syncedItems: result.syncedItems,
      details: result.details
    });
  } catch (error) {
    if (error instanceof SyncCancelledError) {
      console.info('Sync cancelled by user');
      // 499 matches the status the previous implementation returned for a
      // client-initiated cancellation.
      res.status(499).json({ success: false, message: error.message });
      return;
    }

    const err = error as Error;
    console.error('Sync error:', err);
    errorResponse(res, 'Sync failed: ' + err.message, 500);
  }
};

export const getSyncStatus = async (
  req: Request<SyncStatusParams>,
  res: Response<SyncStatusResponse>,
  _next: NextFunction
): Promise<void> => {
  const { type } = req.params;
  const { username } = req.xtream!;

  if (!type) {
    errorResponse(res, 'Missing required parameters', 400);
    return;
  }

  try {
    const status = await xtreamService.getSyncStatus(type, username);
    res.status(200).json({ 
      success: true, 
      data: { 
        ...status,
        type // Include the type in the response
      } 
    });
  } catch (error) {
    const err = error as Error;
    errorResponse(res, 'Failed to get sync status: ' + err.message, 500);
  }
};

export const cancelSync = (
  req: Request,
  res: Response<{ success: boolean; message: string }>,
  _next: NextFunction
): void => {
  const { username } = req.xtream!;

  const wasRunning = xtreamService.cancelSync(username);

  res.status(200).json({
    success: wasRunning,
    message: wasRunning ? 'Sync cancelled' : 'No active sync found'
  });
};
