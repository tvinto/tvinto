import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TmdbClient, TmdbFetch, tmdbClient } from '@shared/tmdb/client';
import { API_URL } from './api-url';
import { LocalProfileService } from './local-profile.service';

/** Where a key typed on this device is kept. Never synced: a key is its owner's. */
const OWN_KEY = 'xtream_tmdb_key';

const readOwnKey = (): string => {
  try {
    return localStorage.getItem(OWN_KEY) ?? '';
  } catch {
    return '';
  }
};

/**
 * Which TMDB key this device uses, for descriptions and
 * "Popular now".
 *
 * Its own, typed on Account, when it has one: a device used without an
 * account has no sync service to ask, and somebody running their own service
 * may not have set one. Otherwise the sync service's, which it hands to
 * signed-in apps. Either way the device calls TMDB itself.
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

  /** A seam for tests. */
  fetchImpl: TmdbFetch = (url, init) => fetch(url, init);

  /** The key typed on this device, or ''. */
  readonly ownKey = signal(readOwnKey());

  private serviceKey: Promise<string | null> | null = null;
  private built: { key: string; client: TmdbClient } | null = null;

  /** The client to use now, or null when this device has no key from anywhere. */
  async client(): Promise<TmdbClient | null> {
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
   * Keeps a key on this device once TMDB has taken it. Throws TMDB's refusal
   * (a TmdbError) otherwise, and keeps nothing.
   */
  async setOwnKey(key: string): Promise<void> {
    const trimmed = key.trim();
    await tmdbClient((url, init) => this.fetchImpl(url, init), trimmed).check();
    try {
      localStorage.setItem(OWN_KEY, trimmed);
    } catch {
      // Storage unavailable: kept for this run only.
    }
    this.ownKey.set(trimmed);
  }

  /** Forgets the key typed here; the sync service's is used again, if it has one. */
  clearOwnKey(): void {
    try {
      localStorage.removeItem(OWN_KEY);
    } catch {
      // Nothing to remove.
    }
    this.ownKey.set('');
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
