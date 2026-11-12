import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  CURRENT_KDF,
  SALT_BYTES,
  checkKdfParams,
  deriveAccountKeys,
  fromBase64,
  toBase64
} from '@shared/auth/accountKeys';
import { open, seal } from '@shared/auth/secretBox';
import { API_URL } from './api-url';
import { createWebKdf } from './native/webKdf';
import { t } from '../utils/i18n';

/**
 * Turning a password into the key that proves who you are.
 *
 * The password stops leaving the device here. What goes to the server is
 * `auth`, and what it keeps is a hash of that -- so a copy of its database is
 * not a copy of anyone's password, and cannot be replayed as a sign-in either.
 *
 * `enc`, the other half, never leaves the device and is what seals the
 * subscription before it is stored. See shared/auth/secretBox.ts.
 */

/** Where the sealing key is kept between launches. */
const ENC_KEY = 'xtream_account_enc';

/** What the server needs a device to know before it can derive anything. */
export interface SaltAnswer {
  salt: string;
  cost: number;
  blockSize: number;
  parallelism: number;
}

/** What a device sends back. */
export interface SubmittedKeys extends SaltAnswer {
  auth: string;
}

@Injectable({ providedIn: 'root' })
export class AccountKeysService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = inject(API_URL);

  /**
   * How far through the slow step, from 0 to 1, or null when not deriving.
   *
   * Worth showing. scrypt is a second on a desktop and several on a television,
   * and a sign-in button that does nothing for four seconds looks broken rather
   * than busy.
   */
  readonly deriving = signal<number | null>(null);

  /** The salt and cost this account uses, asked for before signing in. */
  async saltFor(username: string): Promise<SaltAnswer> {
    const response = await firstValueFrom(
      this.http.get<{ success: boolean; data: SaltAnswer }>(`${this.apiUrl}/accounts/salt`, {
        params: { username }
      })
    );

    return response.data;
  }

  /**
   * A salt for an account that does not exist yet.
   *
   * Made here rather than asked for, because there is nothing to ask about: a
   * registration would otherwise need a round trip to invent a salt and another
   * to use it.
   */
  freshSalt(): SaltAnswer {
    const salt = new Uint8Array(SALT_BYTES);
    crypto.getRandomValues(salt);

    return { salt: toBase64(salt), ...CURRENT_KDF };
  }

  /** Derives the key for this password, under the salt and cost given. */
  async derive(password: string, answer: SaltAnswer): Promise<SubmittedKeys> {
    const { keys, enc } = await this.deriveDetached(password, answer);
    this.keepSealingKey(enc);
    return keys;
  }

  /**
   * The keys for a password without making them this device's own.
   *
   * For an account somebody else will sign in to: one a family manager is
   * creating, or giving a new password. The `enc`
   * comes back to seal that account's first setup with, and is kept nowhere.
   */
  async deriveDetached(password: string, answer: SaltAnswer): Promise<{ keys: SubmittedKeys; enc: Uint8Array }> {
    this.deriving.set(0);

    try {
      // Reported often enough that setting the signal on every call would run
      // change detection hundreds of times for a number nobody can read that
      // fast. A whole percent is as much as a label can say.
      let shown = 0;
      const kdf = createWebKdf(fraction => {
        const percent = Math.round(fraction * 100);
        if (percent !== shown) {
          shown = percent;
          this.deriving.set(fraction);
        }
      });

      const salt = fromBase64(answer.salt);
      if (!salt?.length) {
        throw new Error('The server did not send a usable salt');
      }

      const params = { cost: answer.cost, blockSize: answer.blockSize, parallelism: answer.parallelism };
      // The server's word on the cost is not taken below the floor (shared/auth).
      checkKdfParams(params);
      const { auth, enc } = await deriveAccountKeys(password, salt, params, kdf);

      return { keys: { ...answer, auth: toBase64(auth) }, enc };
    } finally {
      this.deriving.set(null);
    }
  }

  /**
   * The key that opens this account's subscription, or null.
   *
   * Null after a sign-out, and on a device that has not signed in since this
   * existed. Both mean the same thing to a caller: ask the person to sign in
   * again, because nothing else can produce it.
   */
  sealingKey(): Uint8Array | null {
    const stored = this.read(ENC_KEY);
    return stored ? fromBase64(stored) : null;
  }

  /**
   * Seals something under this account's key.
   *
   * Throws when there is no key rather than storing anything in the clear.
   * Nothing that reaches here is safe to send unsealed -- it is a provider
   * password, or a guide URL with one in its query string.
   */
  async seal(plaintext: string): Promise<string> {
    return seal(plaintext, this.requireSealingKey());
  }

  /** Opens something sealed under this account's key, or returns null. */
  async open(sealed: string): Promise<string | null> {
    const key = this.sealingKey();
    return key ? open(sealed, key) : null;
  }

  private requireSealingKey(): Uint8Array {
    const key = this.sealingKey();
    if (!key) {
      throw new Error(t('errors.signInAgain'));
    }
    return key;
  }

  /** Seals text under some other account's key, for setting that account up. */
  sealFor(plaintext: string, enc: Uint8Array): Promise<string> {
    return seal(plaintext, enc);
  }

  /** Opens text sealed under some other account's key. */
  openFor(sealed: string, enc: Uint8Array): Promise<string | null> {
    return open(sealed, enc);
  }

  /** Makes a new key this device's own, after a change of password. */
  useSealingKey(enc: Uint8Array): void {
    this.keepSealingKey(enc);
  }

  /** Forgets it, for a sign-out. */
  forgetSealingKey(): void {
    try {
      localStorage.removeItem(ENC_KEY);
    } catch {
      // Nothing to remove if storage is unavailable.
    }
  }

  /**
   * Keeps the sealing key on this device, in the clear.
   *
   * Worth being plain about, because it looks like a mistake. What `enc`
   * protects is the *hosted* copy: the service holds ciphertext and no key, so
   * a copy of its database yields no provider password and no guide URL. It
   * was never protecting anything on this device, which already stores the
   * provider credentials in the clear beside it -- and has to, because working
   * with no server in reach is the whole point of keeping them.
   *
   * The alternative is asking for the password again at every launch, to
   * re-derive a key guarding data that is sitting unencrypted in the next row.
   * That would be ceremony, not security.
   */
  private keepSealingKey(enc: Uint8Array): void {
    try {
      localStorage.setItem(ENC_KEY, toBase64(enc));
    } catch {
      // Usable for this launch even if it cannot be kept for the next.
    }
  }

  private read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  /**
   * Records these keys against an account, using a token just obtained.
   *
   * The token is passed rather than left to the interceptor: this runs during
   * a sign-in, before the session has been adopted, so there is nothing for the
   * interceptor to attach yet.
   */
  async enrol(keys: SubmittedKeys, token: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.apiUrl}/accounts/keys`, keys, {
        headers: { Authorization: `Bearer ${token}` }
      })
    );
  }

}
