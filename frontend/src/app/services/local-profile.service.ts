import { Injectable, inject, signal } from '@angular/core';
import { PlatformService } from './platform.service';

/** Remembered on the device: '1' while it is used without an account. */
export const LOCAL_PROFILE_KEY = 'xtream_local_profile';

/**
 * The name this device's own storage is kept under while there is no account.
 * Not a name anybody can sign in as -- usernames
 * are letters, digits, dots, dashes and underscores -- so it never meets an
 * account's copy.
 */
export const LOCAL_STORAGE_NAME = '~local';

/**
 * Whose account the device's own copy came from, when it was kept at a
 * sign-out (AccountService.signOutKeeping): signing in as somebody else is
 * then asked about rather than handed over (SyncStartService).
 */
export const LOCAL_FROM_KEY = 'xtream_local_from';

/** Where AccountService keeps the session and the account, read here before it exists. */
const TOKEN_KEY = 'xtream_session_token';
const ACCOUNT_KEY = 'xtream_account';

/**
 * Whether this device is used without an account: everything kept here,
 * nothing sent anywhere. The account is needed only for syncing.
 *
 * A device that has never held an account starts this way, so somebody new
 * goes straight to adding a provider. One that holds an account whose
 * session was refused does not: that is the same person about to sign back
 * in, and their device's copy waits for them.
 *
 * Its own service, without AccountService, because the services under that
 * one -- providers, settings -- need to know too, and AccountService already
 * depends on them.
 */
@Injectable({ providedIn: 'root' })
export class LocalProfileService {
  /** Only where the device keeps everything and reaches the provider itself; never a browser. */
  readonly supported: boolean;

  readonly active = signal(false);

  constructor() {
    const platform = inject(PlatformService);
    this.supported = platform.keepsLocalData && platform.canReachProviderDirectly;
    this.active.set(this.supported && this.startsLocal());
  }

  /** Using the device without an account from now on. */
  enter(): void {
    if (!this.supported) {
      return;
    }
    this.active.set(true);
    try {
      localStorage.setItem(LOCAL_PROFILE_KEY, '1');
    } catch {
      // For this run of the app; the next start decides again from what it finds.
    }
  }

  /** The account the device's own copy was kept from, or null for one that never had one. */
  keptFrom(): string | null {
    try {
      return localStorage.getItem(LOCAL_FROM_KEY);
    } catch {
      return null;
    }
  }

  /** Signed in: the account is what this device is used as now. */
  leave(): void {
    this.active.set(false);
    try {
      localStorage.removeItem(LOCAL_PROFILE_KEY);
      localStorage.removeItem(LOCAL_FROM_KEY);
    } catch {
      // Signed in regardless; the stored session decides the next start.
    }
  }

  private startsLocal(): boolean {
    try {
      if (localStorage.getItem(LOCAL_PROFILE_KEY) === '1') {
        return true;
      }
      return localStorage.getItem(TOKEN_KEY) === null && localStorage.getItem(ACCOUNT_KEY) === null;
    } catch {
      return false;
    }
  }
}
