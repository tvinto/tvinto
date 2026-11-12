import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle, lucideUserPlus } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { ToastService } from '../../services/toast.service';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { locale, t } from '../../utils/i18n';
import { TDatePipe, TPipe } from '../../pipes/t.pipe';
import { AccountService, CreatedInvite, Invite } from '../../services/account.service';
import { ClockService } from '../../services/clock.service';

/**
 * Inviting somebody: a code they type once to make an account.
 *
 * Registration on the sync service is closed, and stays closed to anybody
 * without a code (worker/src/invites.ts). Before this, a new person in the
 * household meant a user opening registration by hand and closing it again.
 *
 * The code is shown once, when it is made -- the service keeps only a hash --
 * so it is shown large, for reading out or copying from a television screen.
 */
@Component({
  selector: 'app-invites',
  standalone: true,
  imports: [TPipe, TDatePipe, NgIcon, HlmButton, SettingGroupComponent, SettingRowComponent],
  host: { class: 'contents' },
  providers: [provideIcons({ lucideLoaderCircle, lucideUserPlus })],
  templateUrl: './invites.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InvitesComponent {
  private readonly accounts = inject(AccountService);

  readonly invites = signal<Invite[]>([]);
  readonly made = signal<CreatedInvite | null>(null);
  readonly busy = signal(false);
  private readonly toast = inject(ToastService);

  constructor() {
    this.load();
  }

  create(): void {
    this.busy.set(true);
    this.accounts.createInvite().subscribe({
      next: invite => {
        this.busy.set(false);
        this.made.set(invite);
        this.load();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.failed(this.accounts.describeError(err));
      }
    });
  }

  revoke(invite: Invite): void {
    this.accounts.revokeInvite(invite.id).subscribe({
      next: () => {
        if (this.made()?.id === invite.id) {
          this.made.set(null);
        }
        this.load();
      },
      error: (err: unknown) => this.failed(this.accounts.describeError(err))
    });
  }

  /** Unused and still in date: what can still be handed to somebody. */
  /** Each invite, with whether it can still be used -- to the minute. */
  readonly rows = computed(() => {
    const now = this.now();
    return this.invites().map(invite => ({ invite, open: !invite.usedAt && Date.parse(invite.expiresAt) > now }));
  });
  private readonly now = inject(ClockService).minute;

  private load(): void {
    this.accounts.listInvites().subscribe({
      next: invites => this.invites.set(invites),
      // An older service has no invites at all; the card simply stays empty.
      error: () => this.invites.set([])
    });
  }

  /** "Made 2 Oct · used by Ana", "· unused until 9 Oct", "· ran out": the line for one invite. */
  inviteLine(invite: Invite, open: boolean): string {
    const day = (iso: string): string => new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
    const state = invite.usedAt
      ? `${t('invites.usedBy')} ${invite.usedBy ?? t('invites.removedAccount')}`
      : open
        ? t('invites.unusedUntil', { date: day(invite.expiresAt) })
        : t('invites.ranOut');
    return `${t('invites.madeOn', { date: day(invite.createdAt) })} · ${state}`;
  }

  /** A failure, in the error dialog as everywhere (5 October). */
  private failed(message: string): void {
    this.toast.error(t('invites.failed'), message);
  }
}
