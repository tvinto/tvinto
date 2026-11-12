import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { serverName } from '@shared/server';
import { API_URL } from '../../services/api-url';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { ToolAction, ToolRequest, ToolRequestsService } from '../../services/tool-requests.service';
import { HlmButton } from '@spartan-ng/helm/button';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { TPipe } from '../../pipes/t.pipe';
import { AccountService, ToolSession } from '../../services/account.service';
import { ConfirmService } from '../../services/confirm.service';
import { LocalToolService } from '../../services/local-tool.service';
import { ToastService } from '../../services/toast.service';
import { locale, t } from '../../utils/i18n';
import { technicalDetail } from '../../utils/failure-messages.utils';

/**
 * The tvinto tools signed in to this account, a way to sign one out, and how
 * to set one up for an AI agent.
 *
 * A tool is how an AI agent reaches the account, so it has to be visible from
 * the account's own devices and easy to end. The setup steps are commands to
 * type on a computer, so a television shows only the tools signed in, and
 * nothing at all when there are none. A service from before tools shows
 * nothing either.
 *
 * Used without an account, the desktop answers tvinto itself
 * (LocalToolService), and the card lists the tools let in here instead.
 */
@Component({
  selector: 'app-tools',
  standalone: true,
  imports: [TPipe, HlmButton, SettingGroupComponent, SettingRowComponent],
  templateUrl: './tools.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ToolsComponent {
  private readonly accounts = inject(AccountService);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);
  private readonly tv = inject(TvNavigationService);

  private readonly local = inject(LocalToolService);

  /** Tools signed in to this app itself, used without an account. */
  readonly localOnly = this.local.available;

  private readonly synced = signal<ToolSession[]>([]);
  readonly tools = computed<ToolSession[]>(() =>
    this.localOnly()
      ? this.local.tools().map(tool => ({
          id: tool.id,
          name: tool.name,
          createdAt: tool.createdAt,
          lastUsedAt: tool.lastUsedAt ?? tool.createdAt,
          history: tool.history,
          current: false
        }))
      : this.synced()
  );

  /** Whether tools can be here at all: this app answers them, or the sync service answered the list. */
  private readonly syncSupported = signal(false);
  private readonly supported = computed(() => this.localOnly() || this.syncSupported());

  /** The host to sign in to, as the commands need it. */
  readonly server = serverName(inject(API_URL)());

  /** This account's name, for the sign-in command. */
  readonly username = computed(() => this.accounts.account()?.username ?? '');

  /** Tools asking to be let in, to allow or refuse here (tvinto sign-in). */
  readonly requests = inject(ToolRequestsService);

  readonly showHow = computed(() => this.supported() && !this.tv.isTelevision());
  readonly shown = computed(
    () =>
      this.showHow() ||
      (this.supported() && (this.tools().length > 0 || this.requests.waiting().length > 0 || this.requests.actions().length > 0))
  );

  async allowAction(action: ToolAction): Promise<void> {
    await this.requests.askAction(action);
  }

  async refuseAction(action: ToolAction): Promise<void> {
    await this.requests.refuseAction(action);
  }

  async allow(request: ToolRequest): Promise<void> {
    await this.requests.ask(request);
    this.load();
  }

  async refuse(request: ToolRequest): Promise<void> {
    await this.requests.answer(request, false);
    this.load();
  }

  constructor() {
    this.load();
  }

  async signOut(tool: ToolSession): Promise<void> {
    const sure = await this.confirm.ask({
      title: t('tools.signOutTitle', { name: tool.name }),
      message: t('tools.signOutBody'),
      confirmLabel: t('tools.signOut'),
      destructive: true
    });
    if (!sure) {
      return;
    }
    if (this.localOnly()) {
      this.local.signOut(tool.id);
      return;
    }
    this.accounts.signOutTool(tool.id).subscribe({
      next: () => this.load(),
      error: (error: unknown) => {
        this.toasts.error(t('tools.notSignedOut'), this.accounts.describeError(error), {
          detail: technicalDetail(error)
        });
        this.load();
      }
    });
  }

  private load(): void {
    if (this.localOnly()) {
      return;
    }
    this.accounts.listTools().subscribe({
      next: tools => {
        this.synced.set(tools);
        this.syncSupported.set(true);
        void this.requests.refresh();
        void this.requests.refreshActions();
      },
      // A service from before tools has none to list; the card stays away.
      error: () => {
        this.synced.set([]);
        this.syncSupported.set(false);
      }
    });
  }

  /** "Last used 31 Oct · keeps a history": the grey line under a tool's name. */
  toolLine(tool: ToolSession): string {
    const date = new Date(tool.lastUsedAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
    const parts = [t('tools.lastUsed', { date })];
    if (tool.history) {
      parts.push(t('tools.history'));
    }
    return parts.join(' · ');
  }
}
