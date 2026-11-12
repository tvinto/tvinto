import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { map, of } from 'rxjs';
import { AccountService } from '../services/account.service';
import { API_URL } from '../services/api-url';
import { SEND_HELD, SetupHoldService } from '../services/setup-hold.service';
import { isHeldWrite, withHeld } from '../utils/setup-hold.utils';

/**
 * In a family member's setup, keeps their subscription and OpenSubtitles login
 * back for Save & Close, answering as the service would have; and shows them
 * in what the setup reads meanwhile. Everywhere else, and for what Save &
 * Close sends, requests pass as they are.
 */
export const setupHoldInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.context.get(SEND_HELD) || inject(AccountService).profileScope() !== 'setup') {
    return next(req);
  }
  const apiUrl = inject(API_URL);
  if (!req.url.startsWith(apiUrl)) {
    return next(req);
  }
  const path = req.url.slice(apiUrl.length).split('?')[0];
  const hold = inject(SetupHoldService);

  if (isHeldWrite(req.method, path)) {
    hold.hold({ method: req.method, path, body: req.body });
    return of(new HttpResponse({ status: 200, body: { success: true, data: null } }));
  }
  if (req.method === 'GET' && hold.holding()) {
    return next(req).pipe(
      map(event => (event instanceof HttpResponse ? event.clone({ body: withHeld(path, event.body, hold.requests()) }) : event))
    );
  }
  return next(req);
};
