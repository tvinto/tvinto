import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map, of } from 'rxjs';
import { AccountService } from '../services/account.service';
import { OnboardingService } from '../services/onboarding.service';
import { FamilyProfilesService } from '../services/family-profiles.service';

/**
 * Keeps signed-out visitors out of the app.
 *
 * A held token is not proof on its own -- sessions live in the backend's memory
 * and a restart invalidates them -- so the first guarded navigation checks it
 * with the server. Afterwards the answer is already known and no request is
 * made.
 */
export const authGuard: CanActivateFn = () => {
  const accounts = inject(AccountService);
  const router = inject(Router);

  // Without an account, the device's own providers are all it needs.
  if (accounts.localProfile.active()) {
    return true;
  }

  if (!accounts.getToken()) {
    return router.createUrlTree(['/']);
  }

  if (accounts.account() && accounts.subscriptions().length > 0) {
    return of(true);
  }

  return accounts.refresh().pipe(map(valid => valid || router.createUrlTree(['/'])));
};

/**
 * Keeps a signed-in account out of the library until it has a subscription.
 *
 * Being signed in with nothing to watch is a real state, not an error: it is
 * where you are the moment you register. Sending them to the setup page is the
 * useful response, rather than an empty library that fails on every request.
 */
export const subscriptionGuard: CanActivateFn = () => {
  const accounts = inject(AccountService);
  const router = inject(Router);

  if (accounts.hasSubscription()) {
    return true;
  }
  // A device with nothing in it yet starts with the walk-through, once.
  return router.createUrlTree([inject(OnboardingService).shouldShow() ? '/welcome' : '/subscription']);
};

/**
 * Asks who is watching before the first page, on a device shared by a
 * household and not in use for a while (FamilyProfilesService).
 */
export const whoIsWatchingGuard: CanActivateFn = () => {
  const profiles = inject(FamilyProfilesService);
  return profiles.askWhoIsWatching() ? inject(Router).createUrlTree(['/profiles']) : true;
};
