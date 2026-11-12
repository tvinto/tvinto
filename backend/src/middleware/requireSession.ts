import { Request, Response, NextFunction } from 'express';
import { sessionStore, XtreamCredentials } from '../utils/sessions';
import { accountsService } from '../services/accounts.service';
import { errorResponse } from '../utils/errorHandler';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      xtream?: XtreamCredentials;
      sessionToken?: string;
      userId?: number;
    }
  }
}

/** Reads the bearer token from the Authorization header, if present. */
export function readBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  const token = header.slice('bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/** What a token resolves to: who is calling, and what to call the provider with. */
export interface ResolvedSession {
  userId: number;
  credentials: XtreamCredentials | null;
}

/**
 * Turns a token into the caller and their provider credentials.
 *
 * The subscription is read fresh every time, so renewed credentials take
 * effect immediately and a removed one stops working immediately. A signed-in
 * account with no usable subscription still resolves -- it is a valid caller
 * who simply cannot reach a provider yet, and the difference decides what the
 * client should show.
 */
export function resolveSession(token: string): ResolvedSession | null {
  const subject = sessionStore.resolve(token);
  if (!subject) {
    return null;
  }

  const stored = accountsService.getActiveCredentials(subject.userId);
  return {
    userId: subject.userId,
    credentials: stored
      ? { username: stored.username, password: stored.password, serverUrl: stored.serverUrl }
      : null
  };
}

/**
 * Resolves the caller into req.xtream, rejecting the request when the token is
 * missing or no longer valid.
 *
 * A session with no usable subscription is refused here with a distinct status,
 * because every route behind this middleware needs a provider to talk to. The
 * account routes sit outside it for exactly that reason.
 */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token = readBearerToken(req);

  if (!token) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  const session = resolveSession(token);
  if (!session) {
    errorResponse(res, 'Session expired or invalid', 401);
    return;
  }

  if (!session.credentials) {
    errorResponse(res, 'No subscription configured for this account', 409);
    return;
  }

  req.xtream = session.credentials;
  req.userId = session.userId;
  req.sessionToken = token;
  next();
}

/**
 * Requires a signed-in account, but not a working subscription.
 *
 * Used by the routes that exist to fix the subscription problem -- adding
 * credentials, listing what is stored -- which cannot demand the very thing
 * they are there to set up.
 */
export function requireAccount(req: Request, res: Response, next: NextFunction): void {
  const token = readBearerToken(req);

  if (!token) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  const userId = sessionStore.resolveUserId(token);
  if (userId === null) {
    errorResponse(res, 'Session expired or invalid', 401);
    return;
  }

  req.userId = userId;
  req.sessionToken = token;
  next();
}
