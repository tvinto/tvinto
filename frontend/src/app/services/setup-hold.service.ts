import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API_URL } from './api-url';
import { HELD_REQUESTS_KEY, HeldRequest, readHeldRequests } from '../utils/setup-hold.utils';
import { technicalDetail } from '../utils/failure-messages.utils';

/** Marks a request Save & Close is sending, which the hold lets through. */
export const SEND_HELD = new HttpContextToken<boolean>(() => false);

/**
 * The writes a family member's setup keeps back for Save & Close: their
 * subscription and their OpenSubtitles login, which go straight to the sync
 * service rather than through the queue (setup-hold.utils.ts). The interceptor
 * holds them; this keeps them, with the setup's storage, and sends them.
 */
@Injectable({ providedIn: 'root' })
export class SetupHoldService {
  // HttpClient is reached lazily: the interceptor that feeds this service runs
  // inside HttpClient, and asking for it at construction would be a cycle.
  private readonly injector = inject(Injector);
  // Read at each use: a server chosen at sign-in takes effect without a restart.
  private readonly syncServer = inject(API_URL);
  private get apiUrl(): string {
    return this.syncServer();
  }

  private readonly held = signal<HeldRequest[]>(this.read());
  readonly holding = computed(() => this.held().length > 0);

  /** Why the last Save & Close of these failed, for the error's Details. */
  lastFailure = '';

  requests(): readonly HeldRequest[] {
    return this.held();
  }

  hold(request: HeldRequest): void {
    this.write([...this.held(), request]);
  }

  /** Sends them in the order they were made; stops at the first that fails, keeping it and the rest. */
  async sendHeld(): Promise<boolean> {
    const http = this.injector.get(HttpClient);
    this.lastFailure = '';
    while (this.held().length) {
      const [next, ...rest] = this.held();
      try {
        await firstValueFrom(
          http.request(next.method, `${this.apiUrl}${next.path}`, {
            body: next.body,
            context: new HttpContext().set(SEND_HELD, true)
          })
        );
      } catch (error) {
        this.lastFailure = technicalDetail(error);
        return false;
      }
      this.write(rest);
    }
    return true;
  }

  private read(): HeldRequest[] {
    try {
      return readHeldRequests(localStorage.getItem(HELD_REQUESTS_KEY));
    } catch {
      return [];
    }
  }

  private write(requests: HeldRequest[]): void {
    this.held.set(requests);
    try {
      if (requests.length) {
        localStorage.setItem(HELD_REQUESTS_KEY, JSON.stringify(requests));
      } else {
        localStorage.removeItem(HELD_REQUESTS_KEY);
      }
    } catch {
      // Held for this run of the page.
    }
  }
}
