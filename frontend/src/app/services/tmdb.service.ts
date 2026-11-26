import { HttpClient } from '@angular/common/http';
import { reportingFetch } from '../utils/failure-reports';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TmdbClient, TmdbFetch, tmdbClient } from '@shared/tmdb/client';
import { normaliseTmdbKey } from '@shared/tmdb/key';
import { ACCOUNT_TMDB_KEY_PATH, openTmdbKey, sealCheckedTmdbKey } from '@shared/tmdb/accountKey';
import { seal } from '@shared/auth/secretBox';
import { API_URL } from './api-url';
import { AccountKeysService } from './account-keys.service';
import { AccountService } from './account.service';
import { LocalProfileService } from './local-profile.service';
import { t } from '../utils/i18n';

/** Where a key typed on a device used without an account is kept. */
const OWN_KEY = 'xtream_tmdb_key';

const readOwnKey = (): string => {
  try {
    return localStorage.getItem(OWN_KEY) ?? '';
  } catch {
    return '';
  }
};

const keepDeviceKey = (key: string): void => {
  try {
    localStorage.setItem(OWN_KEY, key);
  } catch {
    // Storage unavailable: kept for this run only.
  }
};

const forgetDeviceKey = (): void => {
  try {
    localStorage.removeItem(OWN_KEY);
  } catch {
    // Nothing to remove.
  }
};

/**
 * Which TMDB key this device uses, for descriptions and
 * "Popular now".
 *
 * The person's own, typed in Settings or the first launch, when there is
 * one: signed in, it is kept on the account, sealed like the provider login
 * (shared/tmdb/accountKey.ts), so every device of the account uses it; used
 * without an account, on this device. Otherwise the sync service's, which it
 * hands to signed-in apps. Either way the device calls TMDB itself.
 *
 * Per account: a family member or profile has its own, as with the
 * OpenSubtitles login, and uses the service's when it has none.
 */
@Injectable({ providedIn: 'root' })
export class TmdbService {
  private readonly http = inject(HttpClient);
  // Read at each use: a server chosen at sign-in takes effect without a restart.
  private readonly syncServer = inject(API_URL);
  private get apiUrl(): string {
    return this.syncServer();
  }
  private readonly localProfile = inject(LocalProfileService);
  private readonly accounts = inject(AccountService);
  private readonly keys = inject(AccountKeysService);

  /** A seam for tests. */
  // Failing answers reported by status only (utils/failure-reports.ts).
  fetchImpl: TmdbFetch = reportingFetch('tmdb', (url, init) => fetch(url, init));

  /** The person's own key in use here -- the account's, or this device's without one -- or ''. */
  readonly ownKey = signal(readOwnKey());

  private serviceKey: Promise<string | null> | null = null;
  private accountKey: Promise<void> | null = null;
  private built: { key: string; client: TmdbClient } | null = null;

  constructor() {
    let wasOnAccount = false;
    let signOuts = untracked(() => this.accounts.deliberateSignOuts());
    // Another account, or none, reads its own key, and never the last one's.
    effect(() => {
      const onAccount = this.onAccount();
      const signedOut = this.accounts.deliberateSignOuts() !== signOuts;
      untracked(() => {
        signOuts = this.accounts.deliberateSignOuts();
        this.serviceKey = null;
        this.accountKey = null;
        if (onAccount) {
          void this.readAccountKey();
        } else {
          // Going on without the account keeps its key on this device, as it
          // keeps the rest; a sign-out leaves nothing of it.
          if (wasOnAccount && !signedOut && this.ownKey()) {
            keepDeviceKey(this.ownKey());
          }
          this.ownKey.set(readOwnKey());
        }
        wasOnAccount = onAccount;
      });
    });
  }

  /** The client to use now, or null when this device has no key from anywhere. */
  async client(): Promise<TmdbClient | null> {
    if (this.onAccount()) {
      await this.readAccountKey();
    }
    const key = this.ownKey() || (await this.keyFromService());
    if (!key) {
      return null;
    }
    if (this.built?.key !== key) {
      this.built = { key, client: tmdbClient((url, init) => this.fetchImpl(url, init), key) };
    }
    return this.built.client;
  }

  /**
   * Keeps a key once TMDB has taken it: on the account when signed in, on
   * this device otherwise. Throws TMDB's refusal (a TmdbError) otherwise, and
   * keeps nothing.
   */
  async setOwnKey(key: string): Promise<void> {
    if (this.onAccount()) {
      const enc = this.keys.sealingKey();
      if (!enc) {
        throw new Error(t('errors.signInAgain'));
      }
      const checked = await sealCheckedTmdbKey(key, enc, (url, init) => this.fetchImpl(url, init));
      await firstValueFrom(this.http.post(this.accountKeyUrl, { payload: checked.payload }));
      this.ownKey.set(checked.key);
      return;
    }
    // As pasted: a token broken across lines, in quotes, or after "Bearer".
    const trimmed = normaliseTmdbKey(key);
    await tmdbClient((url, init) => this.fetchImpl(url, init), trimmed).check();
    keepDeviceKey(trimmed);
    this.ownKey.set(trimmed);
  }

  /**
   * Forgets the key -- from the account, so on every device of it, when
   * signed in. The sync service's is used again, if it has one.
   */
  async clearOwnKey(): Promise<void> {
    if (this.onAccount()) {
      await firstValueFrom(this.http.delete(this.accountKeyUrl));
    } else {
      forgetDeviceKey();
    }
    this.ownKey.set('');
  }

  /** Signed in to an account, rather than used without one: where a key is kept. */
  readonly onAccount = computed(() => this.accounts.account() !== null && !this.localProfile.active());

  private get accountKeyUrl(): string {
    return `${this.apiUrl}${ACCOUNT_TMDB_KEY_PATH}`;
  }

  /**
   * The account's key, asked once per sign-in. A key this device kept from
   * before keys followed the account, or from being used without one, goes to
   * an account that has none, and is then the account's alone.
   */
  private readAccountKey(): Promise<void> {
    this.accountKey ??= (async () => {
      const kept = await firstValueFrom(this.http.get<{ data: { payload: string } | null }>(this.accountKeyUrl));
      const enc = this.keys.sealingKey();
      const typedHere = readOwnKey();
      if (!kept.data && typedHere && enc) {
        this.ownKey.set(typedHere);
        // Kept here still if the account may not take it (a kid's), and tried again next launch.
        await firstValueFrom(this.http.post(this.accountKeyUrl, { payload: await seal(typedHere, enc) }))
          .then(forgetDeviceKey)
          .catch(() => undefined);
        return;
      }
      if (kept.data) {
        forgetDeviceKey();
      }
      this.ownKey.set(kept.data && enc ? ((await openTmdbKey(kept.data.payload, enc)) ?? '') : '');
    })().catch(() => {
      // Asked again next time: a service out of reach may be back, and an
      // older one has no such endpoint. Meanwhile whatever this device kept.
      this.accountKey = null;
      this.ownKey.set(readOwnKey());
    });
    return this.accountKey;
  }

  /** The sync service's key, asked once per launch; null without an account or a key. */
  private keyFromService(): Promise<string | null> {
    if (this.localProfile.active()) {
      return Promise.resolve(null);
    }
    this.serviceKey ??= firstValueFrom(this.http.get<{ data: { apiKey: string | null } }>(`${this.apiUrl}/tmdb/config`))
      .then(response => response.data?.apiKey || null)
      .catch(() => {
        // Asked again next time: an older service has no such endpoint yet,
        // and a service out of reach may be back.
        this.serviceKey = null;
        return null;
      });
    return this.serviceKey;
  }
}
