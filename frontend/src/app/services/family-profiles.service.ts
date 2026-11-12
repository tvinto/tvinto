import { Injectable, Injector, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { fromBase64, toBase64 } from '@shared/auth/accountKeys';
import { openPrivateKey, openWith } from '@shared/auth/keyPair';
import { FamilyMember, FamilyView } from '@shared/family';
import { API_URL } from './api-url';
import { AccountService } from './account.service';
import { DeviceSyncService } from './device-sync.service';
import { SettingsService } from './settings.service';
import { SetupHoldService } from './setup-hold.service';
import { ToastService } from './toast.service';
import { t } from '../utils/i18n';
import { FamilyService } from './family.service';
import { ParentalLockService } from './parental-lock.service';
import { SETTING_KEYS } from '@shared/types';
import { readLockSettings } from '../utils/category-lock.utils';
import {
  HouseholdProfile,
  ProfileVault,
  activate,
  fold,
  forgetProfile,
  readVault,
  shouldAskWhoIsWatching,
  stashActive,
  stashedValue,
  storageNameOf,
  writeVault
} from '../utils/profile-vault.utils';

const TOKEN_KEY = 'xtream_session_token';
const ACCOUNT_KEY = 'xtream_account';
const ENC_KEY = 'xtream_account_enc';
const SETTINGS_KEY = 'xtream_settings';

/** How often a device in use says so, for "Who's watching?" to skip a short break. */
const SEEN_EVERY_MS = 5 * 60 * 1000;

/** One person to pick on this device. */
export interface ProfileChoice extends HouseholdProfile {
  /** The account that signed in on this device. */
  home: boolean;
  /** The profile in use now. */
  active: boolean;
}

/**
 * Who is using this device.
 *
 * The account that signed in here, and the members of its household, are
 * profiles to pick between; picking one starts the app again as that
 * account, with everything of the previous one moved aside
 * (profile-vault.utils.ts). Setting a member up from the Family page is the
 * same move, with a session that reaches only their setup, and "Done" puts
 * the device back as it was.
 *
 * Switching needs the home account's session and its private key, which are
 * set aside while a member's profile is in use; so it always goes through the
 * home account, whichever profile is in front.
 */
@Injectable({ providedIn: 'root' })
export class FamilyProfilesService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = inject(API_URL);
  private readonly accounts = inject(AccountService);
  private readonly family = inject(FamilyService);
  private readonly lock = inject(ParentalLockService);
  private readonly injector = inject(Injector);

  /** Whether "Who's watching?" should be asked before anything else, decided once at start. */
  readonly askWhoIsWatching = signal(false);

  /** Set while a switch is being made, for the picker to show it is busy. */
  readonly switching = signal<string | null>(null);

  private seenTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const vault = this.vault();
    // Not again straight after a switch: the app restarts to become the
    // person chosen, and asking at that start made every switch take two
    // picks (the owner's TV, 10 November).
    this.askWhoIsWatching.set(this.accounts.signedIn() && shouldAskWhoIsWatching(vault) && !answeredBeforeRestart());
  }

  /** Starts saying, every few minutes, that this device is in use. */
  start(): void {
    if (this.seenTimer) {
      return;
    }
    // Not while the question is waiting to be answered: a TV left on the
    // picker is not somebody watching.
    if (!this.askWhoIsWatching()) {
      this.touch();
    }
    this.seenTimer = setInterval(() => {
      if (!this.askWhoIsWatching()) {
        this.touch();
      }
    }, SEEN_EVERY_MS);
  }

  /** The profiles this device offers, the home account first. */
  choices(): ProfileChoice[] {
    // The vault is storage, which nothing watches: read the family too, so a
    // computed over this follows somebody joining or leaving the household.
    this.family.view();
    const vault = this.vault();
    const account = this.accounts.account();
    if (!vault || !account) {
      return [];
    }
    const homeName = vault.home;
    const home: ProfileChoice = {
      id: homeName === fold(account.username) ? account.id : 0,
      username: this.homeUsername(vault) ?? homeName,
      role: 'admin',
      picture: this.homePicture(vault),
      home: true,
      active: vault.active === homeName
    };
    return [
      home,
      ...vault.household.map(profile => ({
        ...profile,
        home: false,
        active: vault.scope === 'full' && vault.active === fold(profile.username)
      }))
    ];
  }

  /** Carries on as whoever is in use: the question is answered. */
  stay(): void {
    this.askWhoIsWatching.set(false);
    this.touch();
  }

  /** Becomes this profile: the app starts again as it. */
  async switchTo(choice: ProfileChoice): Promise<void> {
    const vault = this.vault();
    if (!vault) {
      return;
    }
    const name = choice.home ? vault.home : fold(choice.username);
    if (vault.active === name && vault.scope === 'full') {
      this.stay();
      return;
    }

    this.switching.set(choice.username);
    try {
      const fresh =
        choice.home || vault.stash[name] ? {} : await this.freshProfile(vault, choice.id, 'full');

      // Out of a kid's profile into a grown-up's: that person's PIN, if they
      // have one (TV-20). Without it a parental lock would be one press from
      // undone. A grown-up with no PIN has chosen to have none.
      // Read from the service, not only from what this device kept: a PIN set
      // on another device since would otherwise not be asked for. Not read,
      // what is kept stands -- and with nothing kept either, the switch waits.
      if (this.accounts.role() === 'kid' && choice.role !== 'kid') {
        const current = await this.currentSettingOf(vault, name, fresh, SETTING_KEYS.parentalLock);
        const kept = vault.stash[name]?.[SETTINGS_KEY] ?? fresh[SETTINGS_KEY];
        if (current === undefined && !kept) {
          this.injector.get(ToastService).error(t('family.switchNotReady'), t('family.switchNotReadyBody'));
          return;
        }
        const lock = readLockSettings(current !== undefined ? current : this.settingOf(vault, name, fresh, SETTING_KEYS.parentalLock));
        if (lock && !(await this.lock.askForPinOf(lock, choice.username))) {
          return;
        }
      }

      let next = this.leaveCurrent(vault);
      next = activate(localStorage, next, name, 'full', fresh);
      writeVault(localStorage, { ...next, lastSeenAt: new Date().toISOString() });
      this.restart('/for-you');
    } finally {
      this.switching.set(null);
    }
  }

  /**
   * Opens a member's account to set it up: its providers, guides, hidden and
   * locked categories and preferences, through a session that never sees what
   * it watched. Only from the home account, which is the one that manages.
   */
  async setUp(member: FamilyMember, section = 'providers'): Promise<void> {
    const vault = this.vault();
    if (!vault || vault.active !== vault.home || vault.scope !== 'full') {
      return;
    }
    const session = await this.family.setupSession(member);
    const account = {
      id: member.id,
      username: member.username,
      createdAt: member.createdAt,
      role: member.role,
      managerId: member.managerId,
      household: member.household
    };
    let next = stashActive(localStorage, vault);
    next = activate(localStorage, next, storageNameOf(member.username, 'setup'), 'setup', {
      [TOKEN_KEY]: session.token,
      [ENC_KEY]: toBase64(session.enc),
      [ACCOUNT_KEY]: JSON.stringify(account)
    });
    writeVault(localStorage, next);
    this.restart(`/account?section=${section}`);
  }

  /** Done setting somebody up: everything of it on this device goes, and the home account comes back. */
  /**
   * Save, on the banner of a member's setup: what was changed reaches their
   * account now, and not before (DeviceSyncService holds it) -- then back to
   * this device's own account.
   */
  async saveSetUp(): Promise<void> {
    const vault = this.vault();
    if (!vault || vault.scope !== 'setup') {
      return;
    }
    // Unsent, it would be lost with the setup's storage: stay, and say so.
    const sync = this.injector.get(DeviceSyncService);
    const settings = this.injector.get(SettingsService);
    const held = this.injector.get(SetupHoldService);
    // The subscription first: the rest may be about its channels.
    const sent = (await held.sendHeld()) && (await sync.sendPending()) && (await settings.sendHeld());
    if (!sent) {
      this.injector.get(ToastService).error(t('family.setupNotSent'), t('family.setupNotSentBody'), {
        detail: [held.lastFailure, sync.lastFailure, settings.lastFailure].filter(Boolean).join('\n')
      });
      return;
    }
    let next = this.leaveCurrent(vault);
    next = activate(localStorage, next, next.home, 'full');
    writeVault(localStorage, next);
    this.restart('/account?section=family');
  }

  /**
   * Moves the profile in use aside -- or, for a setup session, forgets it,
   * since nothing done in one is the member's own to keep.
   */
  private leaveCurrent(vault: ProfileVault): ProfileVault {
    let next = stashActive(localStorage, vault);
    if (vault.scope === 'setup') {
      next = forgetProfile(localStorage, next, vault.active);
    }
    return next;
  }

  /**
   * What a profile this device has not held before needs to start: a session
   * for it, its `enc`, and its account -- got with the home account's session
   * and opened with the home account's private key.
   */
  private async freshProfile(vault: ProfileVault, memberId: number, scope: 'full'): Promise<Record<string, string>> {
    const homeToken = this.homeValue(vault, TOKEN_KEY);
    const homeEnc = fromBase64(this.homeValue(vault, ENC_KEY) ?? '');
    if (!homeToken || !homeEnc) {
      throw new Error('This device is not signed in to its own account any more');
    }
    const headers = { headers: new HttpHeaders({ Authorization: `Bearer ${homeToken}` }) };

    const view = (await firstValueFrom(this.http.get<{ data: FamilyView }>(`${this.apiUrl}/family`, headers))).data;
    const member = view.members.find(candidate => candidate.id === memberId);
    const privateKey = view.me.sealedPrivateKey ? await openPrivateKey(view.me.sealedPrivateKey, homeEnc) : null;
    const enc = member?.sealedEnc && privateKey ? await openWith(member.sealedEnc, privateKey) : null;
    if (!member || !enc) {
      throw new Error('not-ready');
    }

    const { token } = (
      await firstValueFrom(
        this.http.post<{ data: { token: string } }>(`${this.apiUrl}/family/members/${memberId}/session`, { scope }, headers)
      )
    ).data;

    // Its settings too: the PIN a kid would be asked for is among them, and
    // they are this profile's first cache either way.
    const settings = await firstValueFrom(
      this.http.get<{ data: Record<string, string> }>(`${this.apiUrl}/devices/settings`, {
        headers: new HttpHeaders({ Authorization: `Bearer ${token}` })
      })
    ).catch(() => null);

    return {
      ...(settings ? { [SETTINGS_KEY]: JSON.stringify(settings.data ?? {}) } : {}),
      [TOKEN_KEY]: token,
      [ENC_KEY]: enc,
      [ACCOUNT_KEY]: JSON.stringify({
        id: member.id,
        username: member.username,
        createdAt: member.createdAt,
        role: member.role,
        managerId: member.managerId,
        household: member.household
      })
    };
  }

  /**
   * One of a profile's settings, from what this device holds of it: its
   * stashed settings, or -- for a profile it has not held before -- what its
   * fresh start was given.
   */
  private settingOf(vault: ProfileVault, name: string, fresh: Record<string, string>, key: string): string | null {
    const raw = vault.stash[name]?.[SETTINGS_KEY] ?? fresh[SETTINGS_KEY] ?? null;
    try {
      return raw ? ((JSON.parse(raw) as Record<string, string>)[key] ?? null) : null;
    } catch {
      return null;
    }
  }

  /**
   * One of a profile's settings as the service has it now, asked with that
   * profile's own session; undefined when it could not be read.
   */
  private async currentSettingOf(
    vault: ProfileVault,
    name: string,
    fresh: Record<string, string>,
    key: string
  ): Promise<string | null | undefined> {
    const token = fresh[TOKEN_KEY] ?? (name === vault.home ? this.homeValue(vault, TOKEN_KEY) : stashedValue(vault, name, TOKEN_KEY));
    if (!token) {
      return undefined;
    }
    try {
      const response = await firstValueFrom(
        this.http.get<{ data: Record<string, string> }>(`${this.apiUrl}/devices/settings`, {
          headers: new HttpHeaders({ Authorization: `Bearer ${token}` })
        })
      );
      return response.data?.[key] ?? null;
    } catch {
      return undefined;
    }
  }

  /** Whether entering this profile from a kid's would ask for a PIN, for the picker to say so. */
  needsPin(choice: ProfileChoice): boolean {
    const vault = this.vault();
    if (!vault || choice.role === 'kid' || this.accounts.role() !== 'kid') {
      return false;
    }
    const name = choice.home ? vault.home : fold(choice.username);
    return readLockSettings(this.settingOf(vault, name, {}, SETTING_KEYS.parentalLock)) !== null;
  }

  /** A home-account value, from storage if it is in use or from the vault if it is set aside. */
  private homeValue(vault: ProfileVault, key: string): string | null {
    return vault.active === vault.home ? localStorage.getItem(key) : stashedValue(vault, vault.home, key);
  }

  /** The home account's picture, from its stored account like its name. */
  private homePicture(vault: ProfileVault): string | null {
    const raw = this.homeValue(vault, ACCOUNT_KEY);
    try {
      return raw ? ((JSON.parse(raw) as { picture?: string | null }).picture ?? null) : null;
    } catch {
      return null;
    }
  }

  private homeUsername(vault: ProfileVault): string | null {
    const raw = this.homeValue(vault, ACCOUNT_KEY);
    try {
      return raw ? ((JSON.parse(raw) as { username?: string }).username ?? null) : null;
    } catch {
      return null;
    }
  }

  private touch(): void {
    const vault = this.vault();
    if (vault) {
      writeVault(localStorage, { ...vault, lastSeenAt: new Date().toISOString() });
    }
  }

  private vault(): ProfileVault | null {
    try {
      return readVault(localStorage);
    } catch {
      return null;
    }
  }

  /**
   * Starts the app again at a page. Every service reads storage as it starts,
   * so a reload is what makes the new profile the one everything sees.
   */
  private restart(path: string): void {
    // From the root, which every build serves -- a deep address is only as
    // good as each platform's fallback to index.html -- and on to the page
    // once the app is up (`takePageAfterRestart`).
    try {
      sessionStorage.setItem(AFTER_RESTART_KEY, path);
      sessionStorage.setItem(ANSWERED_KEY, '1');
    } catch {
      // It starts at For You instead.
    }
    window.location.replace(document.baseURI);
  }
}

const AFTER_RESTART_KEY = 'xtream_after_restart';
/** Set by a restart this service made: who is watching was just decided. */
const ANSWERED_KEY = 'tvinto_profile_answered';

/** Whether this start is a restart for a profile just chosen, once. */
function answeredBeforeRestart(): boolean {
  try {
    const answered = sessionStorage.getItem(ANSWERED_KEY) === '1';
    sessionStorage.removeItem(ANSWERED_KEY);
    return answered;
  } catch {
    return false;
  }
}

/** Where a profile switch asked the app to open, once; null when it did not. */
export function takePageAfterRestart(): string | null {
  try {
    const path = sessionStorage.getItem(AFTER_RESTART_KEY);
    sessionStorage.removeItem(AFTER_RESTART_KEY);
    return path && path.startsWith('/') ? path : null;
  } catch {
    return null;
  }
}
