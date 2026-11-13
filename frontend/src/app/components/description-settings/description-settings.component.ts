import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ChoiceChipsComponent } from '../../ui/choice-chips.component';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { TmdbService } from '../../services/tmdb.service';
import { LANGUAGES, t } from '../../utils/i18n';
import { LanguageService } from '../../services/language.service';
import { DESCRIPTION_LANGUAGES, DescriptionLanguage } from '@shared/tmdb/describe';
import { DescriptionsService } from '../../services/descriptions.service';
import { LocalProfileService } from '../../services/local-profile.service';
import { TmdbKeyComponent } from '../tmdb-key/tmdb-key.component';
import { TPipe } from '../../pipes/t.pipe';

export { TMDB_LOGO } from '../tmdb-key/tmdb-key.component';

/**
 * Whose words describe films and shows: the provider's,
 * or TMDB's in one of the app's languages. An account setting, so the television
 * follows the phone. With TMDB's notice and logo, which its terms ask for
 * wherever its data is used.
 */
@Component({
  selector: 'app-description-settings',
  standalone: true,
  imports: [TPipe, ChoiceChipsComponent, SettingGroupComponent, SettingRowComponent, TmdbKeyComponent],
  host: { class: 'contents' },
  template: `
    <app-setting-group [heading]="'describe.title' | t" data-description-settings>
      <app-setting-row [label]="'describe.language' | t" [sub]="'describe.languageHelp' | t" kind="static">
        <app-choice-chips
          rowEnd
          [label]="'describe.title' | t"
          [choices]="languageChoices()"
          [value]="descriptions.language()"
          (valueChange)="$event && descriptions.setLanguage($event)"
          focusKey="describe-language"
        />
      </app-setting-row>

      @if (available() === false) {
        <p class="setting-block text-sm text-muted-foreground" role="status">
          {{ (localProfile.active() ? 'describe.needsKey' : 'describe.notSetUp') | t }}
        </p>
      }

      <!-- A key of this device's own: for one without an account, or a sync
           service without a key (TmdbService). With TMDB's notice. -->
      <app-tmdb-key />
    </app-setting-group>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DescriptionSettingsComponent {
  readonly descriptions = inject(DescriptionsService);
  readonly localProfile = inject(LocalProfileService);
  /**
   * The provider's, English, and the app's own language -- and whatever is
   * chosen now, if it is another. Not all sixteen: chips for every language
   * would bury the three anyone here wants.
   */
  readonly languageChoices = computed(() => {
    const shown = new Set<DescriptionLanguage>(['provider', 'en', this.appLanguage.current(), this.descriptions.language()]);
    return this.choices
      .filter(choice => shown.has(choice))
      .map(choice => ({
        value: choice,
        label: choice === 'provider' || choice === 'en' ? t('describe.choice.' + choice) : LANGUAGES.find(language => language.id === choice)?.label ?? choice
      }));
  });
  private readonly appLanguage = inject(LanguageService);

  readonly choices: readonly DescriptionLanguage[] = DESCRIPTION_LANGUAGES;

  private readonly keys = inject(TmdbService);

  /** Null until known; false when this device has no TMDB key from anywhere. */
  readonly available = signal<boolean | null>(null);

  constructor() {
    // Asked again whenever a key is saved or removed here.
    effect(() => {
      this.keys.ownKey();
      untracked(() => void this.descriptions.available().then(available => this.available.set(available)));
    });
  }
}
