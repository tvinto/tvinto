import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { toBase64 } from '@shared/auth/accountKeys';
import { sealFor } from '@shared/auth/keyPair';
import { API_URL } from './api-url';
import { AccountService } from './account.service';
import { AccountKeysService } from './account-keys.service';
import { ConfirmService } from './confirm.service';
import { ToastService } from './toast.service';
import { t } from '../utils/i18n';
import { technicalDetail } from '../utils/failure-messages.utils';
import { FamilyService } from './family.service';
import { ParentalLockService } from './parental-lock.service';
import { FamilyRole } from '@shared/family';

/** A tool asking to be let in (worker/src/toolRequests.ts). */
export interface ToolRequest {
  id: string;
  name: string;
  history: boolean;
  /** What the person's terminal shows, to compare. */
  code: string;
  /** What this device seals the account's key for: only that tool opens it. */
  publicKey: string;
  createdAt: string;
}

/** Something a tool asked this app to do (worker/src/toolActions.ts). */
export interface ToolAction {
  id: string;
  toolName: string;
  kind: 'add-member' | 'remove-member' | 'reset-password' | 'pin-off';
  details: { username?: string; role?: string; household?: boolean; memberId?: number };
  createdAt: string;
}

/** Twelve letters and digits in three groups, without the ones that read alike. */
function newPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const letters = [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
  return `${letters.slice(0, 4)}-${letters.slice(4, 8)}-${letters.slice(8)}`;
}

/** The desktop's tvinto:// links (electron/src/deepLinks.ts). */
interface DeepLinkBridge {
  take(): Promise<string[]>;
  on(listener: (link: string) => void): void;
}

const deepLinks = (): DeepLinkBridge | null =>
  (window as { xtreamDesktop?: { deepLinks?: DeepLinkBridge } }).xtreamDesktop?.deepLinks ?? null;

/**
 * Letting a tool in from this device, instead of typing the password into it.
 *
 * `tvinto sign-in` opens the desktop app on its request; the request waits on
 * Account > Tools too, for a device it cannot open. Allowing it seals this
 * account's key for the tool's own public key: the sync service relays it and
 * cannot read it.
 */
@Injectable({ providedIn: 'root' })
export class ToolRequestsService {
  private readonly http = inject(HttpClient);
  // Read at each use: a server chosen at sign-in takes effect without a restart.
  private readonly syncServer = inject(API_URL);
  private get apiUrl(): string {
    return this.syncServer();
  }
  private readonly accounts = inject(AccountService);
  private readonly keys = inject(AccountKeysService);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);

  private readonly family = inject(FamilyService);
  private readonly lock = inject(ParentalLockService);

  /** The requests waiting for this account, as Account > Tools shows them. */
  readonly waiting = signal<ToolRequest[]>([]);

  /** What tools asked this app to do, waiting for a person (worker/src/toolActions.ts). */
  readonly actions = signal<ToolAction[]>([]);

  /** Listens for links on the desktop. Elsewhere there are none. */
  start(): void {
    const bridge = deepLinks();
    if (!bridge) {
      return;
    }
    bridge.on(link => void this.opened(link));
    void bridge.take().then(links => links.forEach(link => void this.opened(link)));
  }

  async refreshActions(): Promise<ToolAction[]> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ data: { actions: ToolAction[] } }>(`${this.apiUrl}/accounts/tools/actions`)
      );
      this.actions.set(response.data?.actions ?? []);
    } catch {
      this.actions.set([]);
    }
    return this.actions();
  }

  /** The question for an action, in words. */
  describe(action: ToolAction): { title: string; message: string; destructive: boolean } {
    const memberName = (): string =>
      this.family.view()?.members.find(member => member.id === action.details.memberId)?.username ?? '?';
    switch (action.kind) {
      case 'add-member':
        return {
          title: t('tools.actionAdd', { name: action.details.username ?? '', role: t(`family.role.${action.details.role}`) }),
          message: t('tools.actionAddBody', { tool: action.toolName }),
          destructive: false
        };
      case 'remove-member':
        return { title: t('tools.actionRemove', { name: memberName() }), message: t('tools.actionFrom', { tool: action.toolName }), destructive: true };
      case 'reset-password':
        return { title: t('tools.actionReset', { name: memberName() }), message: t('tools.actionResetBody', { tool: action.toolName }), destructive: true };
      default:
        return { title: t('tools.actionPinOff'), message: t('tools.actionFrom', { tool: action.toolName }), destructive: true };
    }
  }

  async refuseAction(action: ToolAction): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`${this.apiUrl}/accounts/tools/actions/${action.id}`, { done: false }));
    } catch {
      // Ran out meanwhile.
    }
    await this.refreshActions();
  }

  /** Asks the person, and on Allow does it here, with this app's own session. */
  async askAction(action: ToolAction): Promise<void> {
    await this.family.load().catch(() => undefined);
    const question = this.describe(action);
    const allow = await this.confirm.ask({ ...question, confirmLabel: t('tools.allow') });
    let done = false;
    if (allow) {
      try {
        done = await this.perform(action);
      } catch (error) {
        this.toasts.error(t('tools.actionFailed'), this.accounts.describeError(error), { detail: technicalDetail(error) });
      }
    }
    try {
      await firstValueFrom(this.http.post(`${this.apiUrl}/accounts/tools/actions/${action.id}`, { done }));
    } catch {
      // Ran out meanwhile: the tool hears that instead.
    }
    await this.refreshActions();
  }

  private async perform(action: ToolAction): Promise<boolean> {
    const member = this.family.view()?.members.find(candidate => candidate.id === action.details.memberId);
    switch (action.kind) {
      case 'add-member': {
        const password = newPassword();
        await this.family.addMember({
          username: action.details.username ?? '',
          password,
          role: (action.details.role ?? 'member') as FamilyRole,
          household: action.details.household === true
        });
        await this.showPassword(action.details.username ?? '', password);
        return true;
      }
      case 'remove-member':
        if (!member) {
          throw new Error(t('tools.actionNoMember'));
        }
        await this.family.deleteMember(member);
        return true;
      case 'reset-password': {
        if (!member) {
          throw new Error(t('tools.actionNoMember'));
        }
        const password = newPassword();
        await this.family.resetPassword(member, password);
        await this.showPassword(member.username, password);
        return true;
      }
      case 'pin-off':
        return this.lock.removePin();
      default:
        return false;
    }
  }

  /** A password made here, shown once to the person, and never sent to the tool. */
  private async showPassword(name: string, password: string): Promise<void> {
    await this.confirm.ask({
      title: t('tools.passwordTitle', { name }),
      message: t('tools.passwordBody', { password }),
      confirmLabel: t('tools.passwordDone')
    });
  }

  async refresh(): Promise<ToolRequest[]> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ data: { requests: ToolRequest[] } }>(`${this.apiUrl}/accounts/tools/requests`)
      );
      this.waiting.set(response.data?.requests ?? []);
    } catch {
      // A service from before requests has none.
      this.waiting.set([]);
    }
    return this.waiting();
  }

  /** Asks the person, with the code to compare, and answers the request. */
  async ask(request: ToolRequest): Promise<void> {
    const allow = await this.confirm.ask({
      title: t('tools.allowTitle', { name: request.name }),
      message: t(request.history ? 'tools.allowBodyHistory' : 'tools.allowBody', { code: request.code }),
      confirmLabel: t('tools.allow')
    });
    await this.answer(request, allow);
  }

  async answer(request: ToolRequest, allow: boolean): Promise<void> {
    try {
      const key = allow ? this.keys.sealingKey() : null;
      if (allow && !key) {
        throw new Error(t('errors.signInAgain'));
      }
      const response = await firstValueFrom(
        this.http.post<{ data?: { confirm?: string } }>(`${this.apiUrl}/accounts/tools/requests/${request.id}`, {
          allow,
          ...(key ? { sealedEnc: await sealFor(toBase64(key), request.publicKey) } : {})
        })
      );
      const confirm = response?.data?.confirm;
      if (allow && confirm) {
        // The tool gets nothing until this is typed into it (worker/src/
        // toolRequests.ts): what ties the approval to the person's own tool.
        void this.confirm.ask({
          title: t('tools.confirmTitle', { code: confirm }),
          message: t('tools.confirmBody', { name: request.name }),
          confirmLabel: t('tools.confirmDone')
        });
      } else if (allow) {
        this.toasts.success(t('tools.allowed', { name: request.name }));
      }
    } catch (error) {
      this.toasts.error(t('tools.notAllowed'), this.accounts.describeError(error), { detail: technicalDetail(error) });
    }
    await this.refresh();
  }

  /** A link the app was opened on: `tvinto://tool-request?id=...&code=...&server=...`. */
  private async opened(link: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return;
    }
    // The desktop's Chromium (Electron 26) reads `tvinto://tool-request` as an
    // empty host and a path of `//tool-request`; newer ones as a host. Either.
    const what = (url.hostname || url.pathname.replace(/^\/+/, '')).split('/')[0];
    if (what !== 'tool-request' && what !== 'tool-action') {
      return;
    }
    // A request to this app's own local address was asked about already, the
    // moment it arrived (LocalToolService): the link that follows it is spare.
    if (/^https?:\/\/(127\.0\.0\.1|localhost):47390\b/.test(url.searchParams.get('server') ?? '')) {
      return;
    }
    if (!this.accounts.getToken() || this.accounts.localProfile.active()) {
      this.toasts.error(t('tools.notAllowed'), t('tools.signInFirst'));
      return;
    }
    if ((url.searchParams.get('server') ?? '').replace(/\/+$/, '') !== this.apiUrl.replace(/\/+$/, '')) {
      this.toasts.error(t('tools.notAllowed'), t('tools.otherServer'));
      return;
    }
    if (what === 'tool-action') {
      const action = (await this.refreshActions()).find(candidate => candidate.id === url.searchParams.get('id'));
      if (!action) {
        this.toasts.error(t('tools.actionFailed'), t('tools.gone'));
        return;
      }
      await this.askAction(action);
      return;
    }
    const request = (await this.refresh()).find(candidate => candidate.id === url.searchParams.get('id'));
    if (!request) {
      this.toasts.error(t('tools.notAllowed'), t('tools.gone'));
      return;
    }
    await this.ask(request);
  }
}
