import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle, lucideUserPlus } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmLabel } from '@spartan-ng/helm/label';
import { ChoiceChipsComponent } from '../../ui/choice-chips.component';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { ConfirmService } from '../../services/confirm.service';
import { ToastService } from '../../services/toast.service';
import { HlmInput } from '@spartan-ng/helm/input';
import { FAMILY_ROLES, FamilyMember, FamilyRole } from '@shared/family';
import { ProviderRecord, recordId } from '@shared/providers/providerRecord';
import { TPipe } from '../../pipes/t.pipe';
import { AccountService } from '../../services/account.service';
import { FamilyService } from '../../services/family.service';
import { FamilyProfilesService } from '../../services/family-profiles.service';
import { ProviderAccessService } from '../../services/provider-access.service';
import { InvitesComponent } from '../invites/invites.component';
import { locale, t } from '../../utils/i18n';
import { ProfilePictureDialogComponent } from '../../ui/profile-picture-dialog.component';

/** A member with how deep below this account it sits, for indenting. */
interface Row {
  member: FamilyMember;
  depth: number;
}

/**
 * Account → Family (boards D-14, P-10).
 *
 * For an admin: everyone below it, adding somebody, and for each person their
 * role, whether they are a profile on this account's devices, which of this
 * account's providers they use, whether their guides are this account's, and
 * a way into their account to set up the rest. For a member or a kid: who set
 * them up, and -- for a member -- leaving.
 */
@Component({
  selector: 'app-family',
  standalone: true,
  imports: [TPipe, FormsModule, NgIcon, HlmButton, HlmInput, HlmLabel, InvitesComponent, ChoiceChipsComponent, SettingGroupComponent, SettingRowComponent, ProfilePictureDialogComponent],
  host: { class: 'contents' },
  providers: [provideIcons({ lucideLoaderCircle, lucideUserPlus })],
  templateUrl: './family.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FamilyComponent {
  readonly accounts = inject(AccountService);
  readonly family = inject(FamilyService);
  private readonly profiles = inject(FamilyProfilesService);
  private readonly access = inject(ProviderAccessService);
  private readonly router = inject(Router);

  readonly roles = FAMILY_ROLES;
  readonly view = this.family.view;
  readonly busy = signal<string | null>(null);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  /** Everyone below, each under the account that manages it. */
  readonly rows = computed<Row[]>(() => {
    const view = this.view();
    if (!view) {
      return [];
    }
    const children = new Map<number, FamilyMember[]>();
    for (const member of view.members) {
      children.set(member.managerId, [...(children.get(member.managerId) ?? []), member]);
    }
    const rows: Row[] = [];
    const walk = (managerId: number, depth: number) => {
      for (const member of children.get(managerId) ?? []) {
        rows.push({ member, depth });
        walk(member.id, depth + 1);
      }
    };
    walk(view.me.id, 0);
    return rows;
  });

  readonly selectedId = signal<number | null>(null);
  readonly selected = computed(() => this.view()?.members.find(member => member.id === this.selectedId()) ?? null);

  /** This account's own providers, which it may share. */
  readonly myProviders = computed(() => this.access.records());

  readonly adding = signal(false);
  draft = { username: '', password: '', role: 'member' as FamilyRole, household: false, guides: false };
  readonly draftShares = signal<Set<string>>(new Set());
  readonly passwordShown = signal(false);

  resetTo = '';
  joinCode = '';

  constructor() {
    void this.family.load().catch(error => this.failed(this.accounts.describeError(error)));
    void this.access.loadedRecords().catch(() => undefined);
  }

  readonly managerName = computed(() => this.view()?.managers[0]?.username ?? '');

  /** This account's providers, each with whether the member being added gets it. */
  readonly draftProviders = computed(() => {
    const shared = this.draftShares();
    return this.myProviders().map(record => ({ record, shared: shared.has(recordId(record)) }));
  });

  /** For the member opened: which of this account's providers and guides it has. */
  readonly selectedShares = computed(() => {
    const member = this.selected();
    if (!member) {
      return null;
    }
    const link = this.family.linkFor(member.id);
    return {
      providers: this.myProviders().map(record => ({ record, shared: link.providers[recordId(record)] !== undefined })),
      guides: link.guides
    };
  });

  // --- Adding --------------------------------------------------------------

  startAdding(): void {
    this.draft = { username: '', password: '', role: 'member', household: false, guides: false };
    this.draftShares.set(new Set());
    this.adding.set(true);
    this.selectedId.set(null);
  }

  toggleDraftShare(record: ProviderRecord): void {
    const next = new Set(this.draftShares());
    const id = recordId(record);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.draftShares.set(next);
  }

  async add(): Promise<void> {
    const draft = { ...this.draft, username: this.draft.username.trim() };
    if (!/^[a-z0-9._-]{3,32}$/i.test(draft.username)) {
      this.failed(t('family.add.badName'));
      return;
    }
    if (draft.password.length < 8) {
      this.failed(t('family.add.shortPassword'));
      return;
    }
    await this.run('add', async () => {
      const id = await this.family.addMember(draft);
      const member = this.view()?.members.find(candidate => candidate.id === id);
      if (member) {
        for (const record of this.myProviders()) {
          if (this.draftShares().has(recordId(record))) {
            await this.family.shareProvider(member, record, true);
          }
        }
        if (draft.guides) {
          await this.family.setGuidesShared(member, true);
        }
      }
      this.adding.set(false);
      this.selectedId.set(id);
      this.toast.success(t('family.add.done', { name: draft.username }));
    });
  }

  // --- One person ----------------------------------------------------------

  select(member: FamilyMember): void {
    this.adding.set(false);
    this.resetTo = '';
    this.selectedId.set(this.selectedId() === member.id ? null : member.id);
  }

  setRole(member: FamilyMember, role: FamilyRole): Promise<void> {
    return this.run('role', () => this.family.changeMember(member, { role }));
  }

  /** The member whose picture is being chosen. */
  readonly picturing = signal<FamilyMember | null>(null);

  async setPicture(member: FamilyMember, picture: string | null): Promise<void> {
    await this.run('picture', () => this.family.changeMember(member, { picture }));
    this.picturing.set(null);
  }

  /** What the Picture row says: the animal chosen, "Your picture", or Automatic. */
  pictureName(who: { picture?: string | null }): string {
    const picture = who.picture;
    if (!picture) {
      return t('avatar.fromName');
    }
    return picture.startsWith('animal:') ? t('avatar.animal.' + picture.slice('animal:'.length)) : t('avatar.own');
  }

  setHousehold(member: FamilyMember, household: boolean): Promise<void> {
    return this.run('household', () => this.family.changeMember(member, { household }));
  }

  setShare(member: FamilyMember, record: ProviderRecord, on: boolean): Promise<void> {
    return this.run(`share:${recordId(record)}`, () => this.family.shareProvider(member, record, on));
  }

  setGuides(member: FamilyMember, on: boolean): Promise<void> {
    return this.run('guides', () => this.family.setGuidesShared(member, on));
  }

  setUp(member: FamilyMember, section: string): Promise<void> {
    return this.run('setup', () => this.profiles.setUp(member, section));
  }

  async resetPassword(member: FamilyMember): Promise<void> {
    if (this.resetTo.length < 8) {
      this.failed(t('family.add.shortPassword'));
      return;
    }
    await this.run('reset', async () => {
      await this.family.resetPassword(member, this.resetTo);
      this.resetTo = '';
      this.toast.success(t('family.reset.done', { name: member.username }));
    });
  }

  /** Asks first, in the confirm dialog: neither can be taken back from here. */
  async release(member: FamilyMember): Promise<void> {
    const sure = await this.confirm.ask({
      title: t('family.release.confirm', { name: member.username }),
      confirmLabel: t('family.release.button'),
      destructive: true
    });
    if (!sure) {
      return;
    }
    await this.run('release', async () => {
      await this.family.release(member);
      this.selectedId.set(null);
    });
  }

  async deleteMember(member: FamilyMember): Promise<void> {
    const sure = await this.confirm.ask({
      title: t('family.delete.confirm', { name: member.username }),
      confirmLabel: t('family.delete.button'),
      destructive: true
    });
    if (!sure) {
      return;
    }
    await this.run('delete', async () => {
      await this.family.deleteMember(member);
      this.selectedId.set(null);
    });
  }

  // --- A member's own view -------------------------------------------------

  leave(): Promise<void> {
    return this.run('leave', () => this.family.leave());
  }

  join(): Promise<void> {
    if (!this.joinCode.trim()) {
      return Promise.resolve();
    }
    return this.run('join', async () => {
      await this.family.join(this.joinCode);
      this.joinCode = '';
      this.toast.success(t('family.join.done', { name: this.managerName() }));
    });
  }

  switchProfile(): void {
    void this.router.navigate(['/profiles']);
  }

  private async run(what: string, work: () => Promise<unknown>): Promise<void> {
    this.busy.set(what);
    try {
      await work();
    } catch (error) {
      this.failed(
        error instanceof Error && error.message === 'not-ready'
          ? t('family.notReady')
          : this.accounts.describeError(error)
      );
    } finally {
      this.busy.set(null);
    }
  }

  /** A failure, in the error dialog as everywhere (5 October). */
  private failed(message: string): void {
    this.toast.error(t('family.failed'), message);
  }

  /** "Adult · in the household · last used 31 Oct": the grey line under a member's name. */
  memberLine(member: FamilyMember): string {
    const parts = [t('family.role.' + member.role)];
    if (member.household) {
      parts.push(t('family.inHousehold'));
    }
    parts.push(
      member.lastUsedAt
        ? t('family.lastUsed', { date: new Date(member.lastUsedAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) })
        : t('family.neverSignedIn')
    );
    return parts.join(' · ');
  }

  readonly roleChoices = computed(() => this.roles.map(role => ({ value: role, label: t('family.role.' + role) })));
}
