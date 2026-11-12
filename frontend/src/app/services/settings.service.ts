import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, firstValueFrom, map, of, tap } from 'rxjs';
import { SETTING_KEYS, SettingKey } from '@shared/types';
import { emptyChangeSet } from '@shared/sync';
import { BOOKING_PREFIX, RECORDER_PREFIX, RULE_PREFIX } from '@shared/recording/plan';
import { AccountService } from './account.service';
import { API_URL } from './api-url';
import { DEVICE_ONLY_SETTINGS, accountSettings } from '../utils/settings.utils';
import { technicalDetail } from '../utils/failure-messages.utils';

/**
 * Preferences, most of which belong to the account rather than to one browser.
 *
 * The server is the authority for those. The theme and the sort orders are the
 * exception and never leave the device (`DEVICE_ONLY_SETTINGS`): they used to
 * follow the account, and switching the laptop to light turned the television
 * light as well. localStorage is
 * kept alongside as a cache, for two reasons: index.html reads the theme from
 * it before Angular boots, which is what stops a light-mode user seeing a dark
 * flash, and a value there is something to show while the request is in
 * flight.
 *
 * Writes are optimistic. A preference is not worth blocking on, and the worst
 * case of a failed write is that this device keeps a choice the others do not
 * hear about until it is set again.
 */
/**
 * Settings that are records rather than preferences: one key each, made and
 * deleted (shared/recording/plan.ts). The account's copy is the truth for
 * these -- one this device holds that the account lacks was deleted
 * elsewhere, not forgotten, and is not handed back up.
 */
export type RecordKey = `${typeof BOOKING_PREFIX}${string}` | `${typeof RECORDER_PREFIX}${string}` | `${typeof RULE_PREFIX}${string}`;
const isAccountRecord = (key: string): boolean => key.startsWith(BOOKING_PREFIX) || key.startsWith(RULE_PREFIX);

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly http = inject(HttpClient);
  private readonly accounts = inject(AccountService);
  private readonly apiUrl = inject(API_URL);

  private readonly values = signal<Record<string, string>>(this.readCache());

  /** Whether the server's copy has been fetched, so callers can wait for it. */
  readonly loaded = signal(false);

  /**
   * Settings changed while setting up a family member, kept back until Save
   * (FamilyProfilesService.saveSetUp): nothing reaches their account before
   * it, a user's rule of 5 October. Kept with the setup's own storage, so
   * it is forgotten with it.
   */
  private readonly heldKeys = signal<string[]>(this.readHeld());

  /** Why the last Save of settings failed, for an error's Details. */
  lastFailure = '';

  /** Whether any setting is waiting for Save. */
  readonly holding = computed(() => this.heldKeys().length > 0);

  constructor() {
    // Follows whoever is signed in rather than being driven from the sign-in
    // and sign-out paths, of which there are several. Doing it the other way
    // would also mean AccountService reaching back into this one, and the two
    // depending on each other.
    let lastAccountId: number | null = null;
    let signOutsSeen = this.accounts.deliberateSignOuts();

    effect(() => {
      const id = this.accounts.account()?.id ?? null;
      if (id === lastAccountId) {
        return;
      }
      lastAccountId = id;

      untracked(() => {
        if (id === null) {
          // A signed-out browser must not hand the next account the previous
          // one's theme. A device signed out keeping what it has goes on
          // without an account with the same settings (signOutKeeping).
          const removed = this.accounts.deliberateSignOuts() !== signOutsSeen;
          signOutsSeen = this.accounts.deliberateSignOuts();
          if (removed || !this.accounts.localProfile.active()) {
            this.clear();
          } else if (this.keptAtSignOut) {
            // A sign-in taken back: the device's own settings return.
            this.values.set({ ...this.values(), ...this.keptAtSignOut });
            this.writeCache();
            this.keptAtSignOut = null;
            this.decided = null;
          }
        } else {
          this.load().subscribe();
        }
      });
    });
  }

  /**
   * Fetches the account's preferences, and hands up anything this browser has
   * that the account does not.
   *
   * That migration is what carries an existing user's choices over the first
   * time they sign in: those settings only ever lived here, and arriving at a
   * server that has never heard of them should not reset them.
   */
  load(): Observable<Record<string, string>> {
    if (!this.accounts.getToken()) {
      return of(this.values());
    }
    // An answer is about the sign-in this load is for, never an earlier one.
    this.decided = null;

    return this.http
      .get<{ success: boolean; data: Record<string, string> }>(`${this.apiUrl}/devices/settings`)
      .pipe(
        // What the account holds for this device's own choices is ignored: it
        // was written back when they synced, and would override them here.
        map(response => accountSettings(response.data ?? {})),
        tap(stored => {
          const local = this.values();
          const ownChoices = accountSettings(local);
          if (this.accounts.localProfile.active()) {
            // Settings kept from a sign-out, maybe somebody else's: held back
            // until the person signing in says whether they come along
            // (SyncStartService) -- the PIN and the locks among them.
            this.keptAtSignOut = ownChoices;
            const deviceOnly = Object.fromEntries(Object.entries(local).filter(([key]) => !(key in ownChoices)));
            this.values.set({ ...deviceOnly, ...stored });
            this.writeCache();
            this.loaded.set(true);
            this.settleKept();
            return;
          }

          const missing: Record<string, string> = {};
          for (const [key, value] of Object.entries(ownChoices)) {
            if (stored[key] === undefined && value && !isAccountRecord(key)) {
              missing[key] = value;
            }
          }

          const kept = Object.fromEntries(Object.entries(local).filter(([key]) => !isAccountRecord(key) || key in stored));
          this.values.set({ ...kept, ...stored });
          this.writeCache();
          this.loaded.set(true);

          if (Object.keys(missing).length > 0) {
            this.push(missing);
          }
        }),
        catchError(() => {
          // Preferences are not worth failing a sign-in over; the cached ones
          // stay in force and the next load will try again.
          this.loaded.set(true);
          return of(this.values());
        })
      );
  }

  /** Settings kept on the device at a sign-out, waiting for `bringKept` or `dropKept`. */
  private keptAtSignOut: Record<string, string> | null = null;
  private decided: 'bring' | 'drop' | null = null;

  /** The person signing in brings what the device kept: what the account lacks is filled from it and sent. */
  bringKept(): void {
    this.decided = 'bring';
    this.settleKept();
  }

  /** The person signing in starts with their own: the kept settings are not theirs. */
  dropKept(): void {
    this.decided = 'drop';
    this.settleKept();
  }

  /** Acts on the answer once both it and the account's settings are in, in whichever order they came. */
  private settleKept(): void {
    if (!this.keptAtSignOut || !this.decided) {
      return;
    }
    if (this.decided === 'bring') {
      const current = this.values();
      const missing: Record<string, string> = {};
      for (const [key, value] of Object.entries(this.keptAtSignOut)) {
        if (current[key] === undefined && value) {
          missing[key] = value;
        }
      }
      this.values.set({ ...current, ...missing });
      this.writeCache();
      if (Object.keys(missing).length > 0) {
        this.push(missing);
      }
    }
    this.keptAtSignOut = null;
    this.decided = null;
  }

  get(key: SettingKey): string | null {
    return this.values()[key] ?? null;
  }

  /** Every setting this device holds, for tvinto without an account (LocalToolService). */
  all(): Record<string, string> {
    return { ...this.values() };
  }

  /** Forgets one setting on this device, as a removal from tvinto does. */
  remove(key: string): void {
    if (!(key in this.values())) {
      return;
    }
    this.values.update(current => Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)));
    this.writeCache();
  }

  /**
   * Deletes a record (`RecordKey`) here and for the account: a tombstone, so
   * the other devices drop it too when they next look.
   */
  delete(key: RecordKey): void {
    this.remove(key);
    if (!this.accounts.getToken() || this.accounts.profileScope() === 'setup') {
      return;
    }
    const body = { ...emptyChangeSet(), deletions: [{ kind: 'setting' as const, key, deletedAt: new Date().toISOString() }] };
    this.http
      .post(`${this.apiUrl}/devices/changes`, body)
      .pipe(catchError(() => of(null)))
      .subscribe();
  }

  /** Drops settings another device deleted, as a pull reported them. */
  applyRemoved(keys: readonly string[]): void {
    const gone = new Set(keys);
    if (!Object.keys(this.values()).some(key => gone.has(key))) {
      return;
    }
    this.values.update(current => Object.fromEntries(Object.entries(current).filter(([key]) => !gone.has(key))));
    this.writeCache();
  }

  /** Records a preference here at once, and tells the server in the background. */
  set(key: SettingKey | RecordKey, value: string): void {
    if (this.values()[key] === value) {
      return;
    }

    this.values.update(current => ({ ...current, [key]: value }));
    this.writeCache();

    if (this.accounts.getToken() && !DEVICE_ONLY_SETTINGS.has(key)) {
      if (this.accounts.profileScope() === 'setup') {
        this.hold(key);
      } else {
        this.push({ [key]: value });
      }
    }
  }

  /** Sends what was kept back for Save; false when the server could not be reached. */
  async sendHeld(): Promise<boolean> {
    const keys = this.heldKeys();
    if (!keys.length) {
      return true;
    }
    const values = this.values();
    const held = Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]]));
    try {
      await firstValueFrom(this.http.post(`${this.apiUrl}/devices/settings`, held));
    } catch (error) {
      this.lastFailure = technicalDetail(error);
      return false;
    }
    this.writeHeld([]);
    return true;
  }

  private hold(key: string): void {
    if (!this.heldKeys().includes(key)) {
      this.writeHeld([...this.heldKeys(), key]);
    }
  }

  private readHeld(): string[] {
    try {
      const stored = JSON.parse(localStorage.getItem(HELD_KEY) ?? '[]') as unknown;
      return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeHeld(keys: string[]): void {
    this.heldKeys.set(keys);
    try {
      if (keys.length) {
        localStorage.setItem(HELD_KEY, JSON.stringify(keys));
      } else {
        localStorage.removeItem(HELD_KEY);
      }
    } catch {
      // Held for this run of the page.
    }
  }

  /** Adopts values a pull brought back from another device. */
  applyIncoming(incoming: Record<string, string>): void {
    const settings = accountSettings(incoming);
    if (Object.keys(settings).length === 0) {
      return;
    }
    this.values.update(current => ({ ...current, ...settings }));
    this.writeCache();
  }

  /**
   * Sends everything held, for a server that has never seen it.
   *
   * Settings are not queued like the rest -- they go to the server as they are
   * changed -- so a move to a different service would leave them behind
   * entirely until somebody happened to change one.
   */
  resend(): void {
    const held = accountSettings(this.values());
    if (Object.keys(held).length && this.accounts.getToken()) {
      this.push(held);
    }
  }

  /** Forgets the cache, so the next account does not inherit this one's choices. */
  clear(): void {
    // The device's own choices stay: they were never the account's to take.
    const deviceOnly = Object.fromEntries(
      Object.entries(this.values()).filter(([key]) => DEVICE_ONLY_SETTINGS.has(key))
    );
    this.values.set(deviceOnly);
    this.loaded.set(false);
    this.writeCache();
  }

  private push(settings: Record<string, string>): void {
    this.http
      .post(`${this.apiUrl}/devices/settings`, settings)
      .pipe(catchError(() => of(null)))
      .subscribe();
  }

  private readCache(): Record<string, string> {
    const cached: Record<string, string> = {};

    try {
      const stored = localStorage.getItem(CACHE_KEY);
      if (stored) {
        Object.assign(cached, JSON.parse(stored) as Record<string, string>);
      }

      // Where these lived before they were account-wide. Read once so the
      // migration above has something to hand up, then left alone -- except
      // for the theme, which index.html still reads from its own key.
      for (const [key, legacyKey] of Object.entries(LEGACY_KEYS)) {
        const legacy = localStorage.getItem(legacyKey);
        if (legacy && cached[key] === undefined) {
          cached[key] = legacy;
        }
      }
    } catch {
      // Storage unavailable; preferences last only as long as this tab.
    }

    return cached;
  }

  private writeCache(): void {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(this.values()));

      // index.html reads this before Angular exists, to decide whether to
      // paint dark. It has to keep seeing the current answer.
      const theme = this.values()[SETTING_KEYS.theme];
      if (theme) {
        localStorage.setItem(LEGACY_KEYS[SETTING_KEYS.theme], theme);
      }
    } catch {
      // Nothing depends on the cache surviving.
    }
  }
}

const CACHE_KEY = 'xtream_settings';

/** The settings a family member's setup has kept back for Save. */
const HELD_KEY = 'xtream_settings_held';

/** Where each preference lived when it belonged to the browser. */
const LEGACY_KEYS: Record<string, string> = {
  theme: 'theme',
  categorySort: 'xtream_category_sort',
  streamSort: 'xtream_stream_sort'
};
