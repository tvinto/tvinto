import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { reportingFetch } from '../utils/failure-reports';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  OpenSubtitlesClient,
  OpenSubtitlesError,
  OpenSubtitlesFetch
} from '@shared/opensubtitles/client';
import {
  HeldSession,
  SubtitleLink,
  allowanceReset,
  linkPayload,
  parseLink,
  retryAfterSignIn,
  sessionUsable,
  userAgentFor,
  usernameProblem
} from '@shared/opensubtitles/link';
import { version } from '../../../package.json';
import { API_URL } from './api-url';
import { AccountKeysService } from './account-keys.service';
import { AccountService } from './account.service';
import { ServiceKindService } from './service-kind.service';
import { hasKey, t } from '../utils/i18n';

/**
 * - `checking`: not known yet.
 * - `unavailable`: this server has no subtitles (the Express backend), or no key is set.
 * - `unlinked`: nothing linked.
 * - `linked`: a login is kept and opens.
 * - `refused`: a login is kept, but OpenSubtitles said it is wrong. Link again.
 * - `unreadable`: a login is kept but this account's key no longer opens it. Link again.
 */
/** `needs-sync`: used without an account, where there is no service to hand out the key or keep the login. */
export type SubtitleLinkState = 'checking' | 'needs-sync' | 'unavailable' | 'unlinked' | 'linked' | 'refused' | 'unreadable';

export interface SubtitleAllowance {
  remaining: number;
  allowed: number;
  /** Local clock time the downloads come back, e.g. "02:00". */
  resetsAt: string;
  /** "4 h 23 m". */
  resetsIn: string;
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

/**
 * The account's OpenSubtitles account: linking it, signing it in, and what is
 * left of today's downloads.
 *
 * The device talks to OpenSubtitles itself. The sync
 * service gives it the application's key and keeps the login as a sealed blob
 * it cannot read; the token OpenSubtitles hands back lives in memory only, for
 * up to a day, and is fetched again with the kept login when it runs out.
 *
 * Never logs, and never puts a password, token or key in a message.
 */
/** Messages the client raises that say more than their problem does, by key. */
const KNOWN_MESSAGES: Record<string, string> = {
  'OpenSubtitles did not accept that username and password.': 'os.notAccepted',
  'OpenSubtitles wants your username here, not your email.': 'os.wantsUsername',
  'Link an OpenSubtitles account to download subtitles.': 'os.problem.signed-out',
  'OpenSubtitles did not return a session.': 'os.problem.failed',
  'OpenSubtitles did not return a file.': 'os.problem.failed'
};

@Injectable({ providedIn: 'root' })
export class OpenSubtitlesService {
  private readonly http = inject(HttpClient);
  // Read at each use: a server chosen at sign-in takes effect without a restart.
  private readonly syncServer = inject(API_URL);
  private get apiUrl(): string {
    return this.syncServer();
  }
  private readonly keys = inject(AccountKeysService);
  private readonly accounts = inject(AccountService);
  private readonly serviceKind = inject(ServiceKindService);

  readonly state = signal<SubtitleLinkState>('checking');
  /** The OpenSubtitles username, when linked. Never the password. */
  readonly username = signal<string | null>(null);
  readonly allowance = signal<SubtitleAllowance | null>(null);
  readonly busy = signal(false);
  /** Something a person can read about the last thing that went wrong. */
  readonly error = signal('');

  private apiKey: string | null = null;
  private link: SubtitleLink | null = null;
  private session: HeldSession | null = null;
  private client: OpenSubtitlesClient | null = null;
  private loading: Promise<void> | null = null;

  /** What OpenSubtitles is told this app is, which they ask every client to send. */
  readonly userAgent = userAgentFor(version);

  /** How requests reach OpenSubtitles. A seam for tests. */
  // Failing answers reported by status only (utils/failure-reports.ts).
  fetchImpl: OpenSubtitlesFetch = reportingFetch('opensubtitles', (url, init) => fetch(url, init));

  constructor() {
    // A different account, or none, must not inherit the last one's login or token.
    effect(() => {
      const id = this.accounts.account()?.id ?? null;
      void id;
      untracked(() => this.forgetInMemory());
    });
  }

  /** Reads the key and the kept login. Safe to call again; one load at a time. */
  load(): Promise<void> {
    this.loading ??= this.readState().finally(() => (this.loading = null));
    return this.loading;
  }

  /**
   * Links an OpenSubtitles account: checks the login with OpenSubtitles, then
   * seals it and keeps it on the account. Nothing is kept if the login fails.
   */
  async linkAccount(username: string, password: string): Promise<boolean> {
    this.error.set('');
    if (!username.trim() || !password) {
      this.error.set(t('os.enterBoth'));
      return false;
    }
    const problem = usernameProblem(username);
    if (problem) {
      this.error.set(t('os.useUsername'));
      return false;
    }

    this.busy.set(true);
    try {
      if (this.state() === 'checking') {
        await this.load();
      }
      const client = this.requireClient();
      const session = await client.login(username.trim(), password);
      this.session = { token: session.token, host: session.host, obtainedAt: Date.now() };

      const payload = await this.keys.seal(linkPayload(username, password));
      await firstValueFrom(this.http.post(`${this.apiUrl}/subtitles/account`, { payload }));

      this.link = parseLink(linkPayload(username, password));
      this.username.set(this.link?.username ?? null);
      this.state.set('linked');
      this.allowance.set(null);
      await this.refreshAllowance();
      return true;
    } catch (error) {
      this.error.set(this.describe(error));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** Forgets the login on every device of this account, and signs the token out. */
  async unlink(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await firstValueFrom(this.http.delete(`${this.apiUrl}/subtitles/account`));
      const token = this.session?.token;
      if (token && this.client) {
        void this.client.logout(token);
      }
      this.link = null;
      this.session = null;
      this.username.set(null);
      this.allowance.set(null);
      this.state.set('unlinked');
    } catch (error) {
      this.error.set(this.describe(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** How many subtitles the account keeps, for the Account page. Null until asked. */
  readonly savedCount = signal<number | null>(null);

  async refreshSavedCount(): Promise<void> {
    try {
      const response = await firstValueFrom(this.http.get<Envelope<unknown[]>>(`${this.apiUrl}/subtitles`));
      this.savedCount.set(Array.isArray(response.data) ? response.data.length : 0);
    } catch {
      // Only a count; the card reads fine without it.
    }
  }

  /** Asks OpenSubtitles what is left of today's downloads. */
  async refreshAllowance(): Promise<void> {
    if (this.state() !== 'linked') {
      return;
    }
    try {
      const user = await this.withSession((client, token) => client.user(token));
      // `remaining_downloads` has been seen to lag a download; never above what the account allows.
      this.allowance.set({
        remaining: Math.max(0, Math.min(user.remainingDownloads, user.allowedDownloads)),
        allowed: user.allowedDownloads,
        ...this.resetLabels(null)
      });
    } catch (error) {
      this.error.set(this.describe(error));
    }
  }

  /**
   * Runs something that needs a signed-in OpenSubtitles session.
   *
   * Signs in with the kept login when there is no usable token, and once more if
   * OpenSubtitles says the token expired. A refused login is never retried --
   * the state becomes `refused` and the person is asked to link again.
   */
  async withSession<T>(work: (client: OpenSubtitlesClient, token: string) => Promise<T>): Promise<T> {
    if (this.state() === 'checking') {
      await this.load();
    }
    const client = this.requireClient();
    let retried = false;

    for (;;) {
      const token = await this.token(client, retried);
      try {
        return await work(client, token);
      } catch (error) {
        if (error instanceof OpenSubtitlesError && retryAfterSignIn(error.problem, retried)) {
          this.session = null;
          retried = true;
          continue;
        }
        throw error;
      }
    }
  }

  /** The words for a failure, for a screen. */
  describe(error: unknown): string {
    if (error instanceof OpenSubtitlesError) {
      if (error.problem === 'allowance-used') {
        const reset = this.resetLabels(error.resetTimeUtc);
        return t('os.usedUp', { at: reset.resetsAt, in: reset.resetsIn });
      }
      // The problem, in the language in use, rather than the English the
      // error was raised with.
      const key = KNOWN_MESSAGES[error.message] ?? 'os.problem.' + error.problem;
      return hasKey(key) ? t(key) : error.message;
    }
    if (error instanceof HttpErrorResponse) {
      return error.status === 0
        ? t('os.serviceUnreachable')
        : (error.error?.message as string | undefined) || t('os.serviceCouldNot');
    }
    return error instanceof Error ? error.message : t('errors.generic');
  }

  private async token(client: OpenSubtitlesClient, forceLogin: boolean): Promise<string> {
    if (!forceLogin && sessionUsable(this.session, Date.now())) {
      client.resume(this.session);
      return this.session.token;
    }
    if (!this.link) {
      throw new OpenSubtitlesError('signed-out', 'Link an OpenSubtitles account first.');
    }
    if (this.state() === 'refused') {
      throw new OpenSubtitlesError('bad-login', 'OpenSubtitles no longer accepts the linked login. Link the account again.');
    }
    try {
      const session = await client.login(this.link.username, this.link.password);
      this.session = { token: session.token, host: session.host, obtainedAt: Date.now() };
      return session.token;
    } catch (error) {
      if (error instanceof OpenSubtitlesError && error.problem === 'bad-login') {
        // Kept, but no longer tried: OpenSubtitles limits logins and the same
        // password will not become right. The person links again.
        this.state.set('refused');
        this.error.set('OpenSubtitles no longer accepts the linked login. Link the account again.');
      }
      throw error;
    }
  }

  private async readState(): Promise<void> {
    this.error.set('');
    if (this.accounts.localProfile.active()) {
      this.state.set('needs-sync');
      return;
    }
    if (!(await this.serviceKind.isSyncService())) {
      this.state.set('unavailable');
      return;
    }

    try {
      const [config, kept] = await Promise.all([
        firstValueFrom(this.http.get<Envelope<{ apiKey: string | null }>>(`${this.apiUrl}/subtitles/config`)),
        firstValueFrom(
          this.http.get<Envelope<{ payload: string; updatedAt: string } | null>>(`${this.apiUrl}/subtitles/account`)
        )
      ]);

      this.apiKey = config.data?.apiKey ?? null;
      this.client = this.apiKey
        ? new OpenSubtitlesClient({ apiKey: this.apiKey, userAgent: this.userAgent, fetch: this.fetchImpl })
        : null;

      if (!this.apiKey) {
        this.state.set('unavailable');
        return;
      }
      if (!kept.data) {
        this.link = null;
        this.username.set(null);
        this.state.set('unlinked');
        return;
      }

      const link = parseLink(await this.keys.open(kept.data.payload));
      if (!link) {
        this.link = null;
        this.username.set(null);
        this.state.set('unreadable');
        return;
      }

      const changed = this.link?.username !== link.username || this.link?.password !== link.password;
      this.link = link;
      if (changed) {
        this.session = null;
      }
      this.username.set(link.username);
      this.state.set('linked');
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 404) {
        // A sync service from before subtitles existed.
        this.state.set('unavailable');
        return;
      }
      this.error.set(this.describe(error));
      if (this.state() === 'checking') {
        this.state.set('unavailable');
      }
    }
  }

  private requireClient(): OpenSubtitlesClient {
    if (!this.client) {
      throw new OpenSubtitlesError('no-key', 'Subtitles are not set up on this service yet.');
    }
    return this.client;
  }

  private resetLabels(resetTimeUtc: string | null): Pick<SubtitleAllowance, 'resetsAt' | 'resetsIn'> {
    const reset = allowanceReset(resetTimeUtc, new Date());
    return { resetsAt: reset.clock, resetsIn: reset.left };
  }

  private forgetInMemory(): void {
    this.apiKey = null;
    this.client = null;
    this.link = null;
    this.session = null;
    this.loading = null;
    this.username.set(null);
    this.allowance.set(null);
    this.error.set('');
    this.state.set('checking');
  }
}
