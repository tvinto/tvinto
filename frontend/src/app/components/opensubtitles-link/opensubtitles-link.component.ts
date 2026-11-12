import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { ToastService } from '../../services/toast.service';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { OpenSubtitlesService } from '../../services/opensubtitles.service';
import { PlayerPreferencesService } from '../../services/player-preferences.service';
import { hasKey, t } from '../../utils/i18n';
import { TPipe } from '../../pipes/t.pipe';

/**
 * ST-D-1: the Account page's OpenSubtitles card, in its three states -- not
 * linked, linking, linked -- plus the two that ask for linking again.
 *
 * The daily limit is stated before anyone signs up, because 20 a day shapes
 * everything after. What happens to the password is said beside the field.
 * Linked, the allowance is the largest thing on the card.
 */
@Component({
  selector: 'app-opensubtitles-link',
  standalone: true,
  imports: [TPipe, NgIcon, HlmButton, HlmInput, HlmLabel, SettingGroupComponent, SettingRowComponent],
  host: { class: 'contents' },
  providers: [provideIcons({ lucideLoaderCircle })],
  templateUrl: './opensubtitles-link.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OpenSubtitlesLinkComponent {
  readonly subtitles = inject(OpenSubtitlesService);
  private readonly preferences = inject(PlayerPreferencesService);

  readonly linking = signal(false);
  readonly showPassword = signal(false);
  readonly username = signal('');
  readonly password = signal('');

  readonly language = computed(() => {
    const code = this.preferences.preferences().subtitleLanguage;
    if (!code) {
      return t('languages.notChosen');
    }
    const key = 'languages.' + code;
    return hasKey(key) ? t(key) : code;
  });

  /** 0 to 100, for the allowance bar. */
  private readonly toast = inject(ToastService);

  /** "18 of 20 left today, resets 03:00 · 42 files saved · Croatian": the grey line under the name. */
  readonly linkedLine = computed(() => {
    const allowance = this.subtitles.allowance();
    const saved = this.subtitles.savedCount();
    return [
      allowance
        ? `${t('os.allowance', { remaining: allowance.remaining, allowed: allowance.allowed })}, ${t('os.resets', { time: allowance.resetsAt })}`
        : t('os.asking'),
      saved === null ? '' : t('os.files', { count: saved }),
      this.language()
    ]
      .filter(Boolean)
      .join(' · ');
  });

  constructor() {
    void this.subtitles.load().then(() => {
      if (this.subtitles.state() === 'linked') {
        void this.subtitles.refreshAllowance();
        void this.subtitles.refreshSavedCount();
      }
    });
  }

  startLinking(): void {
    this.subtitles.error.set('');
    this.username.set(this.subtitles.username() ?? '');
    this.password.set('');
    this.showPassword.set(false);
    this.linking.set(true);
  }

  cancel(): void {
    this.password.set('');
    this.subtitles.error.set('');
    this.linking.set(false);
  }

  async signIn(): Promise<void> {
    const linked = await this.subtitles.linkAccount(this.username(), this.password());
    // The password leaves the form either way; it is kept, sealed, only on success.
    this.password.set('');
    if (linked) {
      this.linking.set(false);
      void this.subtitles.refreshSavedCount();
    } else if (this.subtitles.error()) {
      // Failures in the error dialog, as everywhere (5 October).
      this.toast.error(t('os.signInFailed'), this.subtitles.error());
    }
  }

  onInput(field: 'username' | 'password', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    (field === 'username' ? this.username : this.password).set(value);
  }
}
