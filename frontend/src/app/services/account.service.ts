import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  Observable,
  TimeoutError,
  catchError,
  firstValueFrom,
  from,
  map,
  of,
  switchMap,
  tap,
  timeout
} from 'rxjs';
import { Account, ProviderSubscription, ProviderSubscriptionInput } from '@shared/types';
import { Capacitor } from '@capacitor/core';
import { API_URL } from './api-url';
import { ProviderAccessService } from './provider-access.service';
import { AccountKeysService } from './account-keys.service';
import { ServiceKindService } from './service-kind.service';
import { LOCAL_FROM_KEY, LOCAL_STORAGE_NAME, LocalProfileService } from './local-profile.service';
import { moveDrawers } from '../utils/local-drawers.utils';
import { subscriptionId } from '@shared/xtream/guideSourceId';
import { t } from '../utils/i18n';
import {
  ProfileScope,
  VAULT_KEY,
  forgetProfile,
  fold,
  homeVault,
  readVault,
  storageNameOf,
  writeVault
} from '../utils/profile-vault.utils';

/**
 * How long to wait for the server to vouch for a session before going on
 * without it.
 *
 * There has to be a limit, and a short one. This runs on the way in, with a
 * spinner in front of the user, and an unreachable backend does not always
 * refuse a connection -- the Android emulator's NAT swallows it, so the request
 * simply never answers and the app sits on "Signing in..." for as long as
 * anyone is willing to watch. Four seconds is longer than a healthy check takes
 * and shorter than a person's patience.
 */
const SESSION_CHECK_TIMEOUT_MS = 4000;

const TOKEN_KEY = 'xtream_session_token';
const ACCOUNT_KEY = 'xtream_account';
const SUBSCRIPTIONS_KEY = 'xtream_subscriptions';

/**
 * Where the session token lives, which is not the same question on each.
 *
 * In a browser, sessionStorage: the tab is one visit to a machine that may not
 * be yours, and a token that outlived the tab would be waiting for whoever sat
 * down next.
 *
 * On a device, localStorage, because none of that holds. The app is sandboxed
 * to one person, and Android ends processes as a matter of routine -- a token
 * that died with the process would mean signing in again after every eviction,
 * and signing in is the one thing that cannot be done without the backend. A
 * phone away from the PC would be left at a form it could not submit, unable to
 * reach a catalogue already sitting in its own database.
 */
const tokenStore = (): Storage =>
  platformKeepsSession() ? localStorage : sessionStorage;

/**
 * Read without injection, because this is used by a field initialiser that runs
 * before the constructor. The detection is a pure function of the environment.
 */
const platformKeepsSession = (): boolean => {
  const named = Capacitor.getPlatform();
  if (named !== 'web') {
    return true;
  }
  return typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent);
};

/**
 * What is known about whether a stored subscription actually works.
 *
 * Three states rather than a boolean, because the two unhappy ones are not the
 * same thing and a person reading the screen needs to be able to tell them
 * apart. "I asked your provider and got no answer" is a reason to worry about
 * the provider; "nobody asked" is not.
 */
export type SubscriptionCheck = 'confirmed' | 'unreachable' | 'not-checked';

/**
 * A subscription as one server or the other describes it.
 *
 * The backend sends the fields; the sync service sends a sealed blob, because
 * it holds no key and could not send the fields if it wanted to.
 */
type SealedOrPlain = Partial<ProviderSubscription> & {
  id: number | string;
  payload?: string;
};

/** An invite code as the service lists it: the code itself is never stored. */
export interface Invite {
  id: number;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
}

/** A tvinto tool signed in to the account, as the service lists it (worker/src/sessions.ts). */
export interface ToolSession {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  history: boolean;
  current: boolean;
}

/** A code just made, which is the only time it is seen. */
export interface CreatedInvite {
  id: number;
  code: string;
  createdAt: string;
  expiresAt: string;
}

interface AuthResponse {
  success: boolean;
  data?: {
    token: string;
    user: Account;
    hasSubscription?: boolean;
    /** Whether this account signs in with a derived key yet. */
    enrolled?: boolean;
  };
  message?: string;
}

/**
 * The signed-in account, and the subscriptions attached to it.
 *
 * Owns the session token outright -- XtreamService reads it from here rather
 * than keeping a second copy, because two places remembering who you are is two
 * places to get it wrong.
 *
 * The account is what persists. A subscription is a detail of it that can be
 * replaced when the provider reissues credentials, without the user becoming
 * someone else as far as their favourites are concerned.
 */
@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = inject(API_URL);
  private readonly providerAccess = inject(ProviderAccessService);
  private readonly keys = inject(AccountKeysService);
  private readonly serviceKind = inject(ServiceKindService);

  /** Whether this device is used without an account. */
  readonly localProfile = inject(LocalProfileService);

  /** How far through deriving the sign-in key, for a form to show. */
  readonly deriving = this.keys.deriving;

  private readonly token = signal<string | null>(this.readToken());

  /** Who is signed in. Restored from storage so a reload does not flicker. */
  readonly account = signal<Account | null>(this.readAccount());

  /**
   * Restored from storage, like the account itself.
   *
   * Not merely to save a request. Both guards read this, and an offline device
   * that had forgotten its subscription would send a signed-in user to "add
   * your subscription" -- a page that cannot be completed without the backend,
   * to fix something that was never wrong.
   */
  readonly subscriptions = signal<ProviderSubscription[]>(this.readSubscriptions());

  /**
   * Whether a subscription is set up, which decides where a user lands.
   * Without an account, whether this device keeps a provider.
   */
  readonly hasSubscription = signal<boolean>(
    this.localProfile.active() ? this.providerAccess.hasStoredRecords() : this.readSubscriptions().some(s => s.active)
  );

  readonly signedIn = computed(() => this.token() !== null);

  /**
   * Whether the library may be used: signed in, or used without an account,
   * where the device's own providers are all it needs.
   */
  readonly hasAccess = computed(() => this.token() !== null || this.localProfile.active());

  /**
   * What the session in use is for: the account itself, or a family manager
   * setting it up from its own device. Read once:
   * changing it starts the app again (FamilyProfilesService).
   */
  readonly profileScope = signal<ProfileScope>(this.readScope());

  /**
   * The name this account's own storage is kept under. Its username, except
   * while somebody is setting it up, which keeps a copy of its own so nothing
   * done then lands in the account's copy on this device.
   */
  readonly storageName = computed(() => {
    if (this.localProfile.active()) {
      return LOCAL_STORAGE_NAME;
    }
    const username = this.account()?.username;
    return username ? storageNameOf(username, this.profileScope()) : username;
  });

  /** Its role in its family. An account from an older service is an admin. */
  readonly role = computed(() => this.account()?.role ?? 'admin');

  /**
   * Whether this session may change the account's setup -- providers, guides,
   * hidden and locked categories, preferences. Everyone but a kid at its own
   * device; and a kid being set up by the people above it.
   */
  readonly canChangeSetup = computed(() => this.profileScope() === 'setup' || this.role() !== 'kid');

  /** Whether this session may add and manage accounts below it. */
  readonly managesFamily = computed(() => this.profileScope() === 'full' && this.role() === 'admin');

  /**
   * Bumped when somebody signs out on purpose.
   *
   * What LocalUserDataService watches to know that clearing itself is right.
   * The account going null is not that signal: a refused session does it too,
   * and the device's own copy has to survive one.
   */
  readonly deliberateSignOuts = signal(0);

  constructor() {
    // A device signed in before families has no vault: it was only ever made
    // at sign-in. Without one it could never offer "Who's watching?", so the
    // account it holds becomes its home now.
    try {
      const account = this.account();
      if (account && this.token() && !readVault(localStorage)) {
        writeVault(localStorage, homeVault(account.username));
      }
    } catch {
      // No vault means no profiles, which is a device that works as it always has.
    }
  }

  getToken(): string | null {
    return this.token();
  }

  // --- Getting in ---------------------------------------------------------

  /**
   * Creates an account, enrolling its keys in the same request.
   *
   * The password still goes with it, because this server hashes one as well.
   * The Worker that replaces it will not, and this
   * call already sends everything that one needs.
   */
  register(username: string, password: string, invite = ''): Observable<Account> {
    return from(this.keys.derive(password, this.keys.freshSalt())).pipe(
      switchMap(keys =>
        // The keys and nothing else: the password never leaves the device.
        this.http.post<AuthResponse>(`${this.apiUrl}/accounts/register`, {
          username,
          keys,
          // The way through a closed registration (worker/src/invites.ts).
          ...(invite.trim() ? { invite: invite.trim() } : {})
        })
      ),
      map(response => this.adopt(response)),
      // A fresh account has no subscription by definition.
      tap(() => this.hasSubscription.set(false))
    );
  }

  // --- Invite codes ------------------------------------------------------

  /** A new code for somebody else to make an account with: once, within a week. */
  createInvite(): Observable<CreatedInvite> {
    return this.http
      .post<{ success: boolean; data: CreatedInvite }>(`${this.apiUrl}/accounts/invites`, {})
      .pipe(map(response => response.data));
  }

  /** The codes this account has made, newest first, and who used them. */
  listInvites(): Observable<Invite[]> {
    return this.http
      .get<{ success: boolean; data: Invite[] }>(`${this.apiUrl}/accounts/invites`)
      .pipe(map(response => response.data));
  }

  revokeInvite(id: number): Observable<void> {
    return this.http.delete(`${this.apiUrl}/accounts/invites/${id}`).pipe(map(() => undefined));
  }

  /** The tvinto tools signed in to this account. */
  listTools(): Observable<ToolSession[]> {
    return this.http
      .get<{ success: boolean; data: { tools: ToolSession[] } }>(`${this.apiUrl}/accounts/tools`)
      .pipe(map(response => response.data?.tools ?? []));
  }

  signOutTool(id: string): Observable<void> {
    return this.http.delete(`${this.apiUrl}/accounts/tools/${encodeURIComponent(id)}`).pipe(map(() => undefined));
  }

  logIn(username: string, password: string): Observable<Account> {
    return from(this.signIn(username, password)).pipe(
      tap(response => this.hasSubscription.set(response.data?.hasSubscription ?? false)),
      map(response => this.adopt(response))
    );
  }

  /**
   * Signs in with the key derived from the password, and only with that.
   *
   * It used to fall back to sending the password itself whenever the key was
   * refused -- a migration path for accounts on the old backend, which could
   * not tell a wrong password from an account not yet moved over. The sync
   * service has no password path at all, so the fallback did nothing but send
   * every mistyped password to it in the clear (inside TLS) before failing.
   */
  private async signIn(username: string, password: string): Promise<AuthResponse> {
    const derived = await this.keys.derive(password, await this.keys.saltFor(username));
    return firstValueFrom(
      this.http.post<AuthResponse>(`${this.apiUrl}/accounts/login`, { username, auth: derived.auth })
    );
  }

  /**
   * The server would not accept this session.
   *
   * Not the same as signing out, and the difference is everything this device
   * holds. A refusal is a fact about a token -- it expired, or it belongs to a
   * server that is no longer the one being talked to -- and the person is
   * still the same person, about to sign in again as themselves.
   *
   * So the token goes and nothing else does. The favourites, the history, the
   * provider credentials and the key that opens the hosted subscription all
   * stay, because they are what let this device work with no server in reach
   * and what it will offer the server once it is let back in.
   *
   * Getting this wrong is not theoretical. A session idles out after twelve
   * hours, so treating a refusal as a sign-out meant a device left alone
   * overnight woke up having thrown away its own copy of the account.
   */
  sessionRefused(): void {
    this.token.set(null);
    this.account.set(null);
    this.subscriptions.set([]);
    this.hasSubscription.set(false);

    try {
      tokenStore().removeItem(TOKEN_KEY);
    } catch {
      // The in-memory token is already gone, which is what stops it being sent.
    }
  }

  /**
   * Takes back a sign-in from a device used without an account whose work
   * could not be moved onto the account: the device goes on as it was, and
   * nothing of the account is left on it.
   */
  undoSignIn(): void {
    this.token.set(null);
    this.account.set(null);
    this.subscriptions.set([]);
    this.hasSubscription.set(this.providerAccess.hasStoredRecords());
    this.keys.forgetSealingKey();
    try {
      tokenStore().removeItem(TOKEN_KEY);
      localStorage.removeItem(ACCOUNT_KEY);
      localStorage.removeItem(SUBSCRIPTIONS_KEY);
      localStorage.removeItem(VAULT_KEY);
    } catch {
      // The in-memory session is already gone, which is what stops it being used.
    }
  }

  /**
   * Signs out and goes on without an account, keeping what this device has:
   * its providers, settings, favourites,
   * history, guides and reminders, moved from the account's name to the
   * device's own (local-drawers.utils.ts). The account keeps everything
   * too; nothing more is sent to it or fetched from it.
   */
  signOutKeeping(): void {
    const name = this.storageName();
    // First, so whatever watches the account sees a device used without one
    // rather than a sign-out, and clears nothing.
    this.localProfile.enter();
    if (name && name !== LOCAL_STORAGE_NAME) {
      moveDrawers(localStorage, name, LOCAL_STORAGE_NAME);
      try {
        localStorage.setItem(LOCAL_FROM_KEY, name);
      } catch {
        // Then a later sign-in hands it over without asking, as for a device that never had an account.
      }
    }

    this.token.set(null);
    this.account.set(null);
    this.subscriptions.set([]);
    this.hasSubscription.set(this.providerAccess.hasStoredRecords());
    // The key that opens the account's copy on the service: not the device's.
    this.keys.forgetSealingKey();
    try {
      tokenStore().removeItem(TOKEN_KEY);
      localStorage.removeItem(ACCOUNT_KEY);
      localStorage.removeItem(SUBSCRIPTIONS_KEY);
    } catch {
      // The in-memory session is already gone, which is what stops it being used.
    }
    this.forgetOtherProfiles();
    this.profileScope.set('full');
  }

  logOut(): void {
    // Watched by LocalUserDataService, which clears itself. Counted rather
    // than inferred from the account going null, because a refused session
    // does that too and must not take the device's own copy with it.
    this.deliberateSignOuts.update(count => count + 1);

    this.token.set(null);
    this.account.set(null);
    this.subscriptions.set([]);
    this.hasSubscription.set(false);

    // A device holds the provider's credentials to work without the backend.
    // Signing out has to take them back, or the next person to use the phone
    // inherits the last one's subscription.
    void this.providerAccess.reset();

    // And the key that opens the hosted copy of them. Leaving it behind would
    // let the next person to use this device fetch and open the last one's
    // subscription.
    this.keys.forgetSealingKey();

    // The favourites and history kept beside them go too, but this does not
    // reach over and do it: LocalUserDataService watches the account signal and
    // clears itself. It has to depend on this service to know whose data it is
    // holding, and calling back the other way would be a dependency cycle.

    try {
      tokenStore().removeItem(TOKEN_KEY);
      localStorage.removeItem(ACCOUNT_KEY);
      localStorage.removeItem(SUBSCRIPTIONS_KEY);
    } catch {
      // Storage unavailable; the in-memory state is already cleared.
    }

    // Every other profile this device held goes with it: signing out of a
    // shared television signs the whole household out of it.
    this.forgetOtherProfiles();
    this.profileScope.set('full');

    // Signed out is not locked out: the account was only ever for syncing.
    this.localProfile.enter();
  }

  /**
   * Where the account stands in its family, as the service just said. Kept
   * with the account, so a kid's device knows it is one with no network.
   */
  adoptFamilyPlace(role: 'admin' | 'member' | 'kid', managerId: number | null, household: boolean): void {
    const account = this.account();
    if (!account || (account.role === role && account.managerId === managerId && account.household === household)) {
      return;
    }
    const placed = { ...account, role, managerId, household };
    this.account.set(placed);
    this.storeAccount(placed);
  }

  /**
   * The account's own profile picture (shared/profilePicture.ts): an animal,
   * a small image made on this device, or null for the one from the name.
   */
  async setPicture(picture: string | null): Promise<void> {
    await firstValueFrom(this.http.post(`${this.apiUrl}/accounts/picture`, { picture }));
    const account = this.account();
    if (account) {
      const changed = { ...account, picture };
      this.account.set(changed);
      this.storeAccount(changed);
    }
  }

  /**
   * A sign-in: this account is the device's own now, and any profiles kept for
   * a previous one are forgotten rather than left to be switched into.
   */
  private startVault(username: string): void {
    try {
      const vault = readVault(localStorage);
      if (vault && vault.home === fold(username) && vault.active === fold(username)) {
        return;
      }
      this.forgetOtherProfiles();
      writeVault(localStorage, homeVault(username));
      this.profileScope.set('full');
    } catch {
      // No vault means no profiles, which is a device that works as it always has.
    }
  }

  private forgetOtherProfiles(): void {
    try {
      let vault = readVault(localStorage);
      if (!vault) {
        return;
      }
      for (const name of Object.keys(vault.stash)) {
        vault = forgetProfile(localStorage, vault, name);
      }
      if (vault.scope === 'setup') {
        vault = forgetProfile(localStorage, vault, vault.active);
      }
      localStorage.removeItem(VAULT_KEY);
    } catch {
      // Nothing more to forget than storage will let us reach.
    }
  }

  private readScope(): ProfileScope {
    try {
      return readVault(localStorage)?.scope ?? 'full';
    } catch {
      return 'full';
    }
  }

  /**
   * Confirms the session is still good and refreshes what hangs off it.
   *
   * Sessions live in the backend, so this is how a reload finds out that the
   * token it is holding has stopped being worth anything.
   *
   * The distinction that matters is between the server saying no and there
   * being no server. Only the first is evidence about the session. This used to
   * treat both alike and sign the user out, which on a device with no backend
   * in reach meant an app that could not be used at all -- and, since signing
   * out also surrenders the provider credentials, one that threw away the very
   * thing that would have let it work alone.
   *
   * So an unreachable server is answered with "carry on". The token may be
   * stale, but nothing here can tell, and the cost of being wrong is small: the
   * first request once the backend is back returns 401, and the interceptor
   * signs out then, on evidence.
   */
  refresh(): Observable<boolean> {
    if (!this.token()) {
      return of(false);
    }

    return this.http
      .get<{ success: boolean; data: { user: Account; providers: SealedOrPlain[] } }>(
        `${this.apiUrl}/accounts/me`
      )
      .pipe(
        timeout({ each: SESSION_CHECK_TIMEOUT_MS }),
        switchMap(async response => {
          this.account.set(response.data.user);
          this.storeAccount(response.data.user);
          this.setSubscriptions(await this.describeSubscriptions(response.data.providers));
          return true;
        }),
        catchError((error: unknown) => {
          if (this.serverIsUnreachable(error) || this.serverIsFailing(error)) {
            // Believe what was stored last time rather than nothing at all.
            return of(this.account() !== null);
          }

          // A refusal of this session, and only that: the token goes, and what
          // the device holds stays for the same person signing back in. This
          // used to be a full sign-out for any answer at all, so a server
          // having a bad minute at launch -- a 500 -- threw away the device's
          // subscription and history and left it at the sign-in form.
          this.sessionRefused();
          return of(false);
        })
      );
  }

  /**
   * Whether a failed request means "no answer" rather than "no".
   *
   * Angular reports a request that never reached anywhere as status 0, which is
   * also what a CORS refusal looks like from the client -- neither tells us
   * anything about the session, so both are treated as silence.
   *
   * A timeout counts too, and is the common case rather than the exotic one: a
   * refused connection fails immediately, but a blackholed one -- which is what
   * an emulator's NAT does with a port nothing is listening on -- produces no
   * answer of any kind. Silence and a slow silence say the same thing.
   */
  private serverIsUnreachable(error: unknown): boolean {
    if (error instanceof TimeoutError) {
      return true;
    }
    return error instanceof HttpErrorResponse && error.status === 0;
  }

  /** A server error, which says nothing about whether this session is good. */
  private serverIsFailing(error: unknown): boolean {
    return error instanceof HttpErrorResponse && error.status >= 500;
  }

  // --- Subscriptions ------------------------------------------------------

  loadSubscriptions(): Observable<ProviderSubscription[]> {
    return this.http
      .get<{ success: boolean; data: ProviderSubscription[] }>(`${this.apiUrl}/accounts/providers`)
      .pipe(
        tap(response => this.setSubscriptions(response.data)),
        map(response => response.data)
      );
  }

  /**
   * Stores or renews a subscription.
   *
   * `verified` says whether the provider confirmed the credentials. False means
   * they were kept but could not be checked -- worth telling the user, since it
   * is the difference between "this will work" and "this might".
   */
  saveSubscription(
    details: ProviderSubscriptionInput
  ): Observable<{ subscription: ProviderSubscription; check: SubscriptionCheck }> {
    return from(this.serviceKind.encryptsSubscriptions()).pipe(
      switchMap(sealed =>
        sealed ? from(this.saveSealed(details)) : this.savePlain(details)
      ),
      tap(() => {
        this.hasSubscription.set(true);
        // Renewed credentials: a device is still holding the old ones, and
        // would go on presenting them to the provider until it was restarted.
        void this.providerAccess.reset();
      })
    );
  }

  /** The backend takes the credentials and encrypts them with its own key. */
  private savePlain(
    details: ProviderSubscriptionInput
  ): Observable<{ subscription: ProviderSubscription; check: SubscriptionCheck }> {
    return this.http
      .post<{
        success: boolean;
        data: { provider: ProviderSubscription; verified: boolean };
      }>(`${this.apiUrl}/accounts/providers`, details)
      .pipe(
        map(response => ({
          subscription: response.data.provider,
          // This backend does ask the provider, so a false here really does
          // mean it tried and could not get an answer.
          check: response.data.verified ? ('confirmed' as const) : ('unreachable' as const)
        }))
      );
  }

  /**
   * The sync service takes a sealed blob and an id, and can read neither.
   *
   * Nothing checks it, and saying so is the point. A service that cannot read
   * a subscription cannot ask the provider whether it works -- which is not
   * the same as having asked and got no answer, and telling somebody their
   * provider looks down when nobody went and looked is worse than saying
   * nothing.
   */
  private async saveSealed(
    details: ProviderSubscriptionInput
  ): Promise<{ subscription: ProviderSubscription; check: SubscriptionCheck }> {
    const payload = await this.keys.seal(
      JSON.stringify({
        serverUrl: details.serverUrl,
        username: details.username,
        password: details.password,
        label: details.label ?? null
      })
    );

    const id = subscriptionId(details.serverUrl, details.username);

    await firstValueFrom(
      this.http.post(`${this.apiUrl}/accounts/providers`, { id, payload, active: true })
    );

    const at = new Date().toISOString();
    const subscription: ProviderSubscription = {
      id,
      userId: this.account()?.id ?? 0,
      label: details.label ?? null,
      serverUrl: details.serverUrl,
      xtreamUsername: details.username,
      active: true,
      createdAt: at,
      updatedAt: at
    };

    // Built here rather than read back, because reading it back would only
    // return the ciphertext this device just sent.
    this.setSubscriptions([subscription]);

    return { subscription, check: 'not-checked' };
  }

  removeSubscription(id: number | string): Observable<void> {
    return this.http
      .delete<{ success: boolean }>(`${this.apiUrl}/accounts/providers/${id}`)
      .pipe(
        tap(() => {
          const remaining = this.subscriptions().filter(s => s.id !== id);
          this.setSubscriptions(remaining);
        }),
        map(() => undefined)
      );
  }

  /**
   * Turns whatever the server said about subscriptions into something to show.
   *
   * The backend describes them: label, address, provider username. The sync
   * service cannot -- all three are inside the ciphertext -- so it sends the
   * ciphertext, and the device opens it here. Which is the arrangement working
   * rather than a workaround: only this device holds the key.
   *
   * A row that will not open is dropped rather than shown as a broken
   * subscription. It means the account password changed on another device and
   * this one is still holding the old key, and the honest reading of that is
   * "there is nothing here for you", which sends the person to the screen that
   * asks for it again.
   */
  private async describeSubscriptions(rows: SealedOrPlain[]): Promise<ProviderSubscription[]> {
    const described: ProviderSubscription[] = [];

    for (const row of rows ?? []) {
      if (row.serverUrl) {
        described.push(row as ProviderSubscription);
        continue;
      }
      if (!row.payload) {
        continue;
      }

      const opened = await this.keys.open(row.payload);
      if (!opened) {
        console.warn('A stored subscription could not be opened with this account key');
        continue;
      }

      try {
        const details = JSON.parse(opened) as ProviderSubscriptionInput & {
          label?: string | null;
          kind?: string;
          url?: string;
        };
        if (details.kind === 'm3u') {
          // A playlist as the main provider. It counts as a subscription --
          // the library opens -- and carries no login for the form to show.
          described.push({
            id: row.id,
            userId: this.account()?.id ?? 0,
            label: details.label ?? null,
            serverUrl: '',
            xtreamUsername: '',
            active: row.active !== false,
            createdAt: row.createdAt ?? '',
            updatedAt: row.updatedAt ?? ''
          });
          continue;
        }
        described.push({
          id: row.id,
          userId: this.account()?.id ?? 0,
          label: details.label ?? null,
          serverUrl: details.serverUrl,
          xtreamUsername: details.username,
          active: row.active !== false,
          createdAt: row.createdAt ?? '',
          updatedAt: row.updatedAt ?? ''
        });
      } catch {
        console.warn('A stored subscription opened into something unreadable');
      }
    }

    return described;
  }

  /** Turns a failed request into something worth showing a person. */
  describeError(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const message = (error.error as { message?: string } | null)?.message;
      if (message) {
        return message;
      }
      if (error.status === 0) {
        return t('errors.serverUnreachable');
      }
    }
    return t('errors.generic');
  }

  // --- Internals ----------------------------------------------------------

  private adopt(response: AuthResponse): Account {
    if (!response.success || !response.data?.token) {
      throw new Error(response.message || 'Authentication failed');
    }

    // Somebody else than the person this device last held. A refused session
    // keeps the device's copy for the same person signing back in
    // (`sessionRefused`); for anybody else that copy is not theirs, and the
    // provider's login in it would otherwise be offered to their account as a
    // device moving server offers its own (DeviceSyncService.adoptServer).
    // Found on 1 October 2026, when a TV signed in as a family test account
    // handed it the previous account's subscription.
    const before = this.readAccount()?.username;
    if (before && fold(before) !== fold(response.data.user.username)) {
      void this.providerAccess.reset();
    }

    // A device used without an account stays so until what it kept has
    // moved onto the account (SyncStartService), which then leaves it.
    this.startVault(response.data.user.username);
    this.storeToken(response.data.token);
    this.account.set(response.data.user);
    this.storeAccount(response.data.user);

    return response.data.user;
  }

  private setSubscriptions(subscriptions: ProviderSubscription[]): void {
    this.subscriptions.set(subscriptions);
    this.hasSubscription.set(subscriptions.some(s => s.active));

    try {
      localStorage.setItem(SUBSCRIPTIONS_KEY, JSON.stringify(subscriptions));
    } catch {
      // Only costs a request next time, and only while the backend is up.
    }
  }

  /** Never carries a password: ProviderSubscription has no field for one. */
  private readSubscriptions(): ProviderSubscription[] {
    try {
      const stored = localStorage.getItem(SUBSCRIPTIONS_KEY);
      const parsed: unknown = stored ? JSON.parse(stored) : null;
      return Array.isArray(parsed) ? (parsed as ProviderSubscription[]) : [];
    } catch {
      return [];
    }
  }

  private storeToken(token: string): void {
    this.token.set(token);
    try {
      tokenStore().setItem(TOKEN_KEY, token);
    } catch {
      // In-memory still works for this tab's lifetime.
    }
  }

  private readToken(): string | null {
    try {
      return tokenStore().getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  /** The name only, so the shell can greet without waiting on a request. */
  private storeAccount(account: Account): void {
    try {
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    } catch {
      // Nothing depends on this surviving.
    }
  }

  private readAccount(): Account | null {
    try {
      const stored = localStorage.getItem(ACCOUNT_KEY);
      return stored ? (JSON.parse(stored) as Account) : null;
    } catch {
      return null;
    }
  }
}
