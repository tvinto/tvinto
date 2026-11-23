import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HlmInput } from '@spartan-ng/helm/input';
import { FamilyService } from '../../services/family.service';
import { locale, t } from '../../utils/i18n';
import { clockTime } from '../../utils/channel-display.utils';
import { GuideSourcesService } from '../../services/guide-sources.service';
import { GuideService } from '../../services/guide.service';
import { RecentSearchesService } from '../../services/recent-searches.service';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs/operators';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmLabel } from '@spartan-ng/helm/label';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronLeft, lucideChevronRight } from '@ng-icons/lucide';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { AccountService } from '../../services/account.service';
import { SubscriptionComponent } from '../subscription/subscription.component';
import { SubtitleSettingsComponent } from '../subtitle-settings/subtitle-settings.component';
import { PictureSettingsComponent } from '../picture-settings/picture-settings.component';
import { StartupSettingsComponent } from '../startup-settings/startup-settings.component';
import { LanguageSettingsComponent } from '../language-settings/language-settings.component';
import { PreviewSettingsComponent } from '../preview-settings/preview-settings.component';
import { ErrorReportSettingsComponent } from '../error-report-settings/error-report-settings.component';
import { OpenSubtitlesLinkComponent } from '../opensubtitles-link/opensubtitles-link.component';
import { TPipe } from '../../pipes/t.pipe';
import { DisplaySizeComponent } from '../display-size/display-size.component';
import { LanguagePickerComponent } from '../language-picker/language-picker.component';
import { StorageSettingsComponent } from '../storage-settings/storage-settings.component';
import { ParentalLockComponent } from '../parental-lock/parental-lock.component';
import { ProvidersComponent } from '../providers/providers.component';
import { FamilyComponent } from '../family/family.component';
import { DescriptionSettingsComponent } from '../description-settings/description-settings.component';
import { ToolsComponent } from '../tools/tools.component';
import { FamilyProfilesService } from '../../services/family-profiles.service';
import { DeviceSyncService } from '../../services/device-sync.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../services/confirm.service';
import { ProvidersService } from '../../services/providers.service';
import { API_URL } from '../../services/api-url';
import { serverName } from '@shared/server';
import { ProfilePictureDialogComponent } from '../../ui/profile-picture-dialog.component';

type Section = 'account' | 'family' | 'lock' | 'providers' | 'subtitles';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'account', label: 'account.sections.account' },
  { id: 'family', label: 'account.sections.family' },
  { id: 'lock', label: 'account.sections.lock' },
  { id: 'providers', label: 'account.sections.providers' },
  { id: 'subtitles', label: 'account.sections.subtitles' }
];

/**
 * Which sections a session sees. A kid changes nothing, so it sees who it is
 * and who set it up; somebody setting a member up sees that member's setup and
 * not this device's own preferences or the member's family.
 */
const SECTIONS_FOR = {
  kid: ['account', 'family'] as Section[],
  setup: ['lock', 'providers', 'subtitles'] as Section[],
  // Without an account there is no family to have (LocalProfileService).
  local: ['account', 'lock', 'providers', 'subtitles'] as Section[]
};

/**
 * The account, in sections (D-13, D-17, P-14): who you are and how this
 * device draws; the parental lock; the providers; subtitles. Devices and the
 * household join the list when they exist.
 *
 * The section is in the address (`?section=lock`), so Back on a phone returns
 * from a section to the list, and a link can open one directly.
 */
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [PreviewSettingsComponent, ErrorReportSettingsComponent, LanguageSettingsComponent, 
    TPipe,
    RouterLink,
    FormsModule,
    HlmInput,
    HlmButton,
    HlmLabel,
    NgIcon,
    SettingGroupComponent,
    SettingRowComponent,
    SubscriptionComponent,
    SubtitleSettingsComponent,
    PictureSettingsComponent,
    StartupSettingsComponent,
    OpenSubtitlesLinkComponent,
    DisplaySizeComponent,
    LanguagePickerComponent,
    StorageSettingsComponent,
    ParentalLockComponent,
    ProvidersComponent,
    FamilyComponent,
    DescriptionSettingsComponent,
    ToolsComponent
  , ProfilePictureDialogComponent],
  providers: [provideIcons({ lucideChevronLeft, lucideChevronRight })],
  templateUrl: './account.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AccountComponent {
  readonly accounts = inject(AccountService);
  /** The sync service this account is on, by its host. */
  readonly serverShown = serverName(inject(API_URL)());
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  private readonly profiles = inject(FamilyProfilesService);
  readonly providers = inject(ProvidersService);
  private readonly deviceSync = inject(DeviceSyncService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  /** Until when a second Sign out signs out anyway, losing what could not be sent. */
  private signOutAnywayUntil = 0;

  readonly account = this.accounts.account;
  readonly subscriptions = this.accounts.subscriptions;

  readonly sections = computed(() => {
    const only = this.accounts.localProfile.active()
      ? SECTIONS_FOR.local
      : this.accounts.profileScope() === 'setup'
        ? SECTIONS_FOR.setup
        : this.accounts.role() === 'kid'
          ? SECTIONS_FOR.kid
          : null;
    return only ? SECTIONS.filter(entry => only.includes(entry.id)) : SECTIONS;
  });

  /** Whether this device has other profiles to switch to. */
  readonly hasProfiles = computed(() => {
    this.accounts.account();
    return this.profiles.choices().length > 1;
  });

  private readonly asked = toSignal(this.route.queryParamMap.pipe(map(params => params.get('section'))), {
    initialValue: null
  });

  /** The section asked for, or null for the list -- which on a desktop shows the first beside it. */
  readonly chosen = computed<Section | null>(
    () => this.sections().find(entry => entry.id === this.asked())?.id ?? null
  );

  readonly current = computed<Section>(() => this.chosen() ?? this.sections()[0].id);

  constructor() {
    if (this.accounts.getToken()) {
      this.accounts.loadSubscriptions().subscribe({ error: () => undefined });
    }
  }

  /** The open section's title, as a key for the t pipe. */
  readonly title = computed(() => SECTIONS.find(entry => entry.id === this.current())?.label ?? 'account.title');

  /** From the list a new page (so Back returns to it); between sections, in place. */
  choose(id: Section): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { section: id },
      replaceUrl: this.chosen() !== null
    });
  }

  backToList(): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: {} });
  }

  private readonly family = inject(FamilyService);

  /** What was searched for on this device, which can be cleared here. */
  readonly recentSearches = inject(RecentSearchesService);

  // --- Guides, on a phone (SR-P-3) --------------------------------------------

  private readonly guideSources = inject(GuideSourcesService);
  private readonly guide = inject(GuideService);

  /** When the most recently loaded of this account's guides was loaded here. */
  private readonly guidesLoadedAt = signal<string | null>(null);

  private readonly readsGuideLoads = effect(() => {
    const ids = this.guideSources.enabled().map(source => source.id);
    if (this.guide.supported) {
      untracked(() => void this.readNewestLoad(ids));
    }
  });

  private async readNewestLoad(ids: string[]): Promise<void> {
    const loads = await Promise.all(ids.map(id => this.guide.lastLoadedAt(id).catch(() => null)));
    this.guidesLoadedAt.set(loads.filter((at): at is string => !!at).sort().pop() ?? null);
  }

  /** "2 guides · loaded today at 19:40": the line under Guides on Account. */
  readonly guidesLine = computed(() => {
    const count = this.guideSources.enabled().length;
    if (!count) {
      return t('account.guides.none');
    }
    const parts = [t('account.guides.count', { count })];
    const at = this.guidesLoadedAt();
    if (at) {
      const when = new Date(at);
      const time = clockTime(when.getTime());
      parts.push(
        when.toDateString() === new Date().toDateString()
          ? t('account.guides.loadedToday', { time })
          : t('account.guides.loadedOn', { date: when.toLocaleDateString(locale()), time })
      );
    }
    return parts.join(' · ');
  });

  passwords = { current: '', next: '', repeat: '' };
  readonly changingPassword = signal(false);
  /** Whether Change password has its form open under it. */
  readonly passwordOpen = signal(false);

  /** The picture dialog, and whether its choice is on its way. */
  readonly pictureOpen = signal(false);
  readonly savingPicture = signal(false);

  async savePicture(picture: string | null): Promise<void> {
    this.savingPicture.set(true);
    try {
      await this.accounts.setPicture(picture);
      this.pictureOpen.set(false);
    } catch (error) {
      this.toast.error(t('avatar.failed'), this.accounts.describeError(error));
    } finally {
      this.savingPicture.set(false);
    }
  }

  /** What the Picture row says: the animal chosen, "Your picture", or Automatic. */
  pictureName(who: { picture?: string | null }): string {
    const picture = who.picture;
    if (!picture) {
      return t('avatar.fromName');
    }
    return picture.startsWith('animal:') ? t('avatar.animal.' + picture.slice('animal:'.length)) : t('avatar.own');
  }

  /** "3 subscriptions · since 2 Oct 2026 · on sync.example.com": the grey line under the name. */
  readonly accountLine = computed(() => {
    const user = this.account();
    if (!user) {
      return '';
    }
    return [
      t('account.subscriptions', { count: this.subscriptions().length }),
      t('account.since', { date: new Date(user.createdAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) }),
      t('server.accountOn', { name: this.serverShown })
    ].join(' · ');
  });

  signIn(): void {
    void this.router.navigate(['/sign-in']);
  }

  /** Failures in the error dialog, as everywhere (5 October); success closes the form. */
  async changePassword(): Promise<void> {
    const { current, next, repeat } = this.passwords;
    const failed = (message: string): void => void this.toast.error(t('account.password.failed'), message);
    if (!current || next.length < 8) {
      failed(t('account.password.tooShort'));
      return;
    }
    if (next !== repeat) {
      failed(t('account.password.mismatch'));
      return;
    }
    this.changingPassword.set(true);
    try {
      await this.family.changePassword(current, next);
      this.passwords = { current: '', next: '', repeat: '' };
      this.passwordOpen.set(false);
      this.toast.success(t('account.password.done'));
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      failed(
        reason === 'wrong-current'
          ? t('account.password.wrongCurrent')
          : reason === 'sign-in-again'
            ? t('errors.signInAgain')
            : this.accounts.describeError(error)
      );
    } finally {
      this.changingPassword.set(false);
    }
  }

  switchProfile(): void {
    void this.router.navigate(['/profiles']);
  }

  /**
   * Sends what this device has not yet, before its copy of the account is
   * cleared: a change made in the minute before signing out used to go with
   * it. When the service cannot be reached it says so, and a second press
   * within ten seconds signs out anyway.
   */
  /**
   * Asked rather than assumed: keep what
   * this device has and go on without an account, or remove it all from the
   * device as a sign-out always did. The account keeps everything either way.
   * On a device shared by a household, keeping keeps this person's things
   * and forgets the other profiles, as any sign-out does.
   */
  async signOut(): Promise<void> {
    const choice = this.accounts.localProfile.supported
      ? await this.confirm.choose({
          title: t('local.signOutTitle', { name: this.account()?.username ?? '' }),
          message: t('local.signOutBody'),
          confirmLabel: t('local.keep'),
          otherLabel: t('local.remove')
        })
      : 'other';
    if (choice === null) {
      return;
    }
    const sent = await this.deviceSync.sendPending();
    if (!sent && Date.now() > this.signOutAnywayUntil) {
      this.signOutAnywayUntil = Date.now() + 10_000;
      this.toast.error(t('account.notSent'), t('account.notSentBody'), { detail: this.deviceSync.lastFailure });
      return;
    }
    if (choice === 'confirm') {
      this.accounts.signOutKeeping();
      void this.router.navigate(['/for-you'], { replaceUrl: true });
      return;
    }
    this.accounts.logOut();
    void this.router.navigate(['/']);
  }
}
