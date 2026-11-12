import { inject } from '@angular/core';
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AccountService } from '../services/account.service';

/**
 * Requests that are how you get a token, so they cannot carry one.
 *
 * The salt lookup counts. It runs before there is a session, and its refusals
 * are about the request rather than about who is asking -- treating one as an
 * expired session would sign out whoever happened to be signed in already.
 */
const isSignInCall = (url: string): boolean =>
  url.includes('/accounts/login') ||
  url.includes('/accounts/register') ||
  url.includes('/accounts/salt');

/**
 * Attaches the session token to API calls, and reacts to the two ways a request
 * can be refused for who you are rather than what you asked for.
 *
 * Centralising this is the point: credentials used to be pasted into every
 * request's query string by hand, which is how they ended up in URLs and
 * server logs. Call sites now send nothing sensitive at all.
 */
export const sessionInterceptor: HttpInterceptorFn = (req, next) => {
  const accounts = inject(AccountService);
  const router = inject(Router);

  // A request that already names its session is speaking for another account
  // on this device -- the family's home account while a profile is open
  // (FamilyService). It is left as it is, and a refusal of it says nothing
  // about the session this device is using.
  if (req.headers.has('Authorization')) {
    return next(req);
  }

  const signingIn = isSignInCall(req.url);
  const token = accounts.getToken();

  const outbound =
    token && !signingIn ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(outbound).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || signingIn) {
        return throwError(() => error);
      }

      // The token is no longer good -- most often because the backend
      // restarted, since sessions are held in its memory.
      // Only for a request that carried one: refusing a request without a
      // session says nothing about a session, and a device used without an
      // account has none to lose (LocalProfileService).
      if (error.status === 401 && token && !signingIn) {
        accounts.sessionRefused();
        void router.navigate(['/']);
      }

      // Signed in, but with no subscription to answer the request with. Not a
      // failure of identity, so the session stays; they just need to add one.
      if (error.status === 409 && !req.url.includes('/accounts/')) {
        accounts.hasSubscription.set(false);
        void router.navigate(['/subscription']);
      }

      return throwError(() => error);
    })
  );
};
