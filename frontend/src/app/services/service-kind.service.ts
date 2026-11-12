import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { API_URL } from './api-url';

/**
 * Which server this build is pointed at.
 *
 * There are two, and they want opposite things in a subscription. The Express
 * backend takes the provider's address, username and password, and encrypts
 * them itself with a key sitting beside its database. The sync service takes
 * ciphertext the device made under a key derived from the account password,
 * and could not read a subscription if it wanted to.
 *
 * Sending the wrong shape to either is not a small mistake: sending plaintext
 * credentials to the sync service would defeat the entire arrangement, and
 * sending ciphertext to the backend would store something nothing can open.
 * So the device asks once, rather than guessing from a URL or from a config
 * flag somebody has to remember to set.
 *
 * Asked once and remembered: a server does not change what it is while an
 * app is open, and this sits on the path to signing in. Asked again when
 * another server is chosen at sign-in (`forget`).
 */
@Injectable({ providedIn: 'root' })
export class ServiceKindService {
  private readonly http = inject(HttpClient);
  // Read at each use: a server chosen at sign-in takes effect without a restart.
  private readonly syncServer = inject(API_URL);
  private get apiUrl(): string {
    return this.syncServer();
  }

  private asked: Promise<boolean> | null = null;

  /**
   * Whether the server keeps the subscription as ciphertext it cannot read.
   *
   * False for anything that does not say otherwise -- an older backend, an
   * unreachable one, or something that is not either. That is the safe way
   * round: the plaintext path is what every existing device already does, so
   * being wrong here leaves things as they were rather than storing a
   * subscription nobody can open.
   */
  encryptsSubscriptions(): Promise<boolean> {
    return this.isSyncService();
  }

  /**
   * Whether this is the sync service rather than the Express backend.
   *
   * The same question, asked by callers who care about something else it
   * implies: the sync service holds accounts and what a person made, and
   * nothing else. It has no catalogue and no guide, so the endpoints that
   * served those are not merely unavailable there -- they do not exist, and
   * asking is a request that can only 404.
   */
  isSyncService(): Promise<boolean> {
    this.asked ??= this.ask();
    return this.asked;
  }

  /** For a server just chosen at sign-in (LoginComponent), and tests. */
  forget(): void {
    this.asked = null;
  }

  private async ask(): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ success: boolean; data?: { service?: string } }>(
          `${this.apiUrl}/health`
        )
      );

      return response.data?.service === 'sync';
    } catch {
      // Unreachable, or a server with nothing to say about itself. Either way
      // this is not the sync service as far as anything here can tell.
      return false;
    }
  }
}
