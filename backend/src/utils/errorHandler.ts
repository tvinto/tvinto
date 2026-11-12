import { Request, Response, NextFunction } from 'express';
import { ErrorResponse } from '../types/api.types';

export class AppError extends Error {
  statusCode: number;
  status: string;
  isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Masks Xtream credentials wherever they appear in a URL or message. */
export const redactCredentials = (value: string): string =>
  value
    .replace(/([?&]username=)[^&\s'"]+/gi, '$1<redacted>')
    .replace(/([?&]password=)[^&\s'"]+/gi, '$1<redacted>');

/**
 * Reduces an error to something safe to log.
 *
 * Axios errors carry the entire request config, and Xtream puts the username
 * and password in the query string of every outbound call -- so logging such
 * an error whole writes the user's provider password to disk. Only the fields
 * worth reading are kept, with credentials masked.
 */
export const describeError = (error: unknown): string => {
  if (!error) {
    return 'unknown error';
  }

  const err = error as {
    message?: string;
    code?: string;
    response?: { status?: number };
    config?: { url?: string };
  };

  const parts = [err.message ?? String(error)];
  if (err.code) {
    parts.push(`code=${err.code}`);
  }
  if (err.response?.status) {
    parts.push(`status=${err.response.status}`);
  }
  if (err.config?.url) {
    parts.push(`url=${redactCredentials(err.config.url)}`);
  }

  return redactCredentials(parts.join(' '));
};

export const errorResponse = (
  res: Response,
  message: string,
  statusCode: number = 500,
  error?: unknown
): void => {
  const response: ErrorResponse = {
    success: false,
    message,
    timestamp: new Date().toISOString()
  };

  if (process.env.NODE_ENV === 'development' && error) {
    // Only the sanitised description: the raw error may be an axios failure
    // carrying the credential-bearing request URL, or a parse failure carrying
    // the raw request body.
    console.error('Error:', describeError(error));
  }

  res.status(statusCode).json(response);
};

export const catchAsync = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
};

export const globalErrorHandler = (
  err: { statusCode?: number; status?: string; message?: string },
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  errorResponse(
    res,
    err.message || 'Something went wrong',
    err.statusCode,
    process.env.NODE_ENV === 'development' ? err : undefined
  );
};
