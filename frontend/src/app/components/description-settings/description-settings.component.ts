import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmLabel } from '@spartan-ng/helm/label';
import { ChoiceChipsComponent } from '../../ui/choice-chips.component';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { HlmInput } from '@spartan-ng/helm/input';
import { TmdbError } from '@shared/tmdb/client';
import { TmdbService } from '../../services/tmdb.service';
import { ToastService } from '../../services/toast.service';
import { LANGUAGES, t } from '../../utils/i18n';
import { LanguageService } from '../../services/language.service';
import { DESCRIPTION_LANGUAGES, DescriptionLanguage } from '@shared/tmdb/describe';
import { DescriptionsService } from '../../services/descriptions.service';
import { LocalProfileService } from '../../services/local-profile.service';
import { TPipe } from '../../pipes/t.pipe';

/** TMDB's own logo, from TMDB, as its attribution page offers it. */
export const TMDB_LOGO =
  'https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg';

/**
 * Whose words describe films and shows: the provider's,
 * or TMDB's in one of the app's languages. An account setting, so the television
 * follows the phone. With TMDB's notice and logo, which its terms ask for
 * wherever its data is used.
 */
@Component({
  selector: 'app-description-settings',
  standalone: true,
  imports: [TPipe, HlmButton, HlmInput, HlmLabel, ChoiceChipsComponent, SettingGroupComponent, SettingRowComponent],
  host: { class: 'contents' },
  template: `
    <app-setting-group [heading]="'describe.title' | t" data-description-settings>
      <app-setting-row [label]="'describe.language' | t" kind="static">
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
          {{ (localProfile.active() ? 'local.needsSync' : 'describe.notSetUp') | t }}
        </p>
      }

      <!-- A key of this device's own: for one without an account, or a sync
           service without a key (TmdbService). Saved only once TMDB takes it. -->
      @if (keys.ownKey()) {
        <app-setting-row [label]="'describe.ownKey' | t" [sub]="'describe.ownKeyInUse' | t" kind="static" data-tmdb-own-key>
          <button rowEnd hlmBtn variant="quiet" size="sm" type="button" (click)="removeKey()">{{ 'describe.ownKeyRemove' | t }}</button>
        </app-setting-row>
      } @else {
        <div class="setting-block flex flex-col gap-2" data-tmdb-own-key>
          <label class="flex flex-col gap-2">
            <span hlmLabel>{{ 'describe.ownKey' | t }}</span>
            <span class="flex flex-wrap items-center gap-3">
              <input
                hlmInput
                class="min-w-0 flex-1"
                type="password"
                autocomplete="off"
                spellcheck="false"
                [placeholder]="'describe.ownKeyPlaceholder' | t"
                [value]="draft()"
                (input)="draft.set($any($event.target).value)"
              />
              <button hlmBtn variant="primary" type="button" [disabled]="!draft().trim() || checking()" (click)="saveKey()">
                {{ (checking() ? 'describe.ownKeyChecking' : 'describe.ownKeySave') | t }}
              </button>
            </span>
          </label>
        </div>
      }

      <!-- TMDB's terms ask for their logo and this line wherever their data is used. -->
      <div class="setting-block flex items-center gap-3">
        <img [src]="logo" alt="TMDB" class="h-4 w-auto shrink-0" />
        <p class="text-xs text-muted-foreground">{{ 'describe.attribution' | t }}</p>
      </div>
    </app-setting-group>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DescriptionSettingsComponent {
  readonly descriptions = inject(DescriptionsService);
  readonly localProfile = inject(LocalProfileService);
  /** The languages to describe in, as chips. */
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
  readonly logo = TMDB_LOGO;

  readonly keys = inject(TmdbService);
  private readonly toasts = inject(ToastService);

  /** Null until known; false when this device has no TMDB key from anywhere. */
  readonly available = signal<boolean | null>(null);

  /** The key being typed, not yet saved. */
  readonly draft = signal('');
  readonly checking = signal(false);

  constructor() {
    this.readAvailable();
  }

  /** Kept only once TMDB takes it; a refusal is said in a dialog, with TMDB's answer. */
  async saveKey(): Promise<void> {
    this.checking.set(true);
    try {
      await this.keys.setOwnKey(this.draft());
      this.draft.set('');
      this.readAvailable();
    } catch (error) {
      const refused = error instanceof TmdbError && (error.status === 401 || error.status === 403);
      this.toasts.error(
        t(refused ? 'describe.ownKeyRefused' : 'describe.ownKeyUnreachable'),
        refused ? t('describe.ownKeyRefusedBody') : undefined,
        { detail: error instanceof Error ? error.message : String(error) }
      );
    } finally {
      this.checking.set(false);
    }
  }

  removeKey(): void {
    this.keys.clearOwnKey();
    this.readAvailable();
  }

  private readAvailable(): void {
    void this.descriptions.available().then(available => this.available.set(available));
  }
}
