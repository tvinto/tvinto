import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
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
import { DesktopToolCli, ToolCommands, ToolTarget, asDesktopToolCli, desktopCommands, npmCommands } from '../../utils/tool-commands.utils';

/** The desktop bridge's way to ask where its own tvinto is (electron/src/toolCli.ts); absent elsewhere. */
const desktopToolCli = (): (() => Promise<unknown>) | null =>
  typeof window === 'undefined' ? null : ((window as { xtreamDesktop?: { toolCli?: () => Promise<unknown> } }).xtreamDesktop?.toolCli ?? null);

/** One command on screen, with its Copy button. */
export interface ShownCommand {
  id: string;
  label: string;
  command: string;
}

/** A way to get tvinto: npm, or the desktop app's own copy. */
export interface ToolRoute {
  id: 'npm' | 'desktop';
  heading: string;
  hint: string | null;
  commands: ShownCommand[];
}

/**
 * The tvinto tools signed in to this account, a way to sign one out, and how
 * to set one up for an AI agent.
 *
 * A tool is how an AI agent reaches the account, so it has to be visible from
 * the account's own devices and easy to end. How to set one up starts in
 * plain words: what an agent can do with it and what it never can. The
 * commands follow, from npm and then from the copy the desktop app carries,
 * with its paths filled in -- commands for a computer, so a television or a
 * phone shows the plain words only and says to set it up from a computer. A
 * service from before tools shows nothing.
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

  readonly showHow = this.supported;

  /**
   * A computer: not a television, and not the app on a phone. Commands are
   * shown only here. By platform name, because the desktop app is a "native
   * platform" to Capacitor too.
   */
  readonly onComputer = computed(() => !this.tv.isTelevision() && !['android', 'ios'].includes(Capacitor.getPlatform()));

  /** The desktop app's own tvinto, once its main process has said where it is. */
  private readonly desktopCli = signal<DesktopToolCli | null>(null);

  private readonly target = computed<ToolTarget>(() =>
    this.localOnly() ? { local: true } : { local: false, server: this.server, username: this.username() }
  );

  /** npm first; then, where this is the desktop app, its own copy, which needs no Node. */
  readonly routes = computed<ToolRoute[]>(() => {
    const routes: ToolRoute[] = [
      { id: 'npm', heading: t('tools.howNpm'), hint: null, commands: this.shownCommands('npm', npmCommands(this.target())) }
    ];
    const cli = this.desktopCli();
    if (cli) {
      routes.push({
        id: 'desktop',
        heading: t('tools.howDesktop'),
        hint: cli.platform === 'win32' ? t('tools.howPowerShell') : null,
        commands: this.shownCommands('desktop', desktopCommands(cli, this.target()))
      });
    }
    return routes;
  });

  /** Which command was just copied, for its button to say so for a moment. */
  readonly copied = signal<string | null>(null);
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
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
    void this.findDesktopCli();
  }

  private async findDesktopCli(): Promise<void> {
    const ask = desktopToolCli();
    if (!ask) {
      return;
    }
    try {
      this.desktopCli.set(asDesktopToolCli(await ask()));
    } catch {
      // A main process from before it carried tvinto: npm only.
    }
  }

  private shownCommands(route: ToolRoute['id'], commands: ToolCommands): ShownCommand[] {
    return [
      { id: `${route}-sign-in`, label: t('tools.howSignIn'), command: commands.signIn },
      { id: `${route}-connect`, label: t('tools.howConnect'), command: commands.connect }
    ];
  }

  async copy(command: ShownCommand): Promise<void> {
    if (!(await copyText(command.command))) {
      this.toasts.error(t('tools.notCopied'), t('tools.notCopiedBody'));
      return;
    }
    this.copied.set(command.id);
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => this.copied.set(null), 2000);
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

/** The clipboard, or the older way where the page may not use it. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}
