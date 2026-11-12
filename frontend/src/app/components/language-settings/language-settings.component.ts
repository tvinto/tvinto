import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { OrderChipsComponent } from '../../ui/choice-chips.component';
import { SettingGroupComponent } from '../../ui/setting-row.component';
import { LANGUAGES_MAX, LANGUAGE_CHOICES } from '@shared/languages';
import { LanguagesService } from '../../services/languages.service';
import { TPipe } from '../../pipes/t.pipe';
import { locale } from '../../utils/i18n';

/**
 * Your languages: which copy of a film or show comes first, and which
 * trailer opens, in the order chosen -- up to three. An account setting.
 * Chips in order (DS-TV-3) rather than a select, as everywhere a television
 * reaches, and nothing applies until Save.
 */
@Component({
  selector: 'app-language-settings',
  standalone: true,
  imports: [TPipe, HlmButton, OrderChipsComponent, SettingGroupComponent],
  host: { class: 'contents' },
  template: `
    <app-setting-group [heading]="'yourLanguages.title' | t" data-language-settings>
      <div class="setting-block flex flex-col gap-4">
        <app-order-chips
          [label]="'yourLanguages.title' | t"
          [choices]="choiceList()"
          [values]="draft()"
          (valuesChange)="draft.set([...$event])"
          [max]="max"
          focusKey="language"
        />
        @if (changed()) {
          <div class="flex flex-wrap items-center gap-3" data-languages-save>
            <button hlmBtn variant="primary" size="sm" type="button" [disabled]="!draft().length" (click)="save()">{{ 'cat.save' | t }}</button>
            <button hlmBtn variant="quiet" size="sm" type="button" (click)="cancel()">{{ 'cat.cancel' | t }}</button>
            <span class="text-sm text-muted-foreground">{{ 'lock.age.unsaved' | t }}</span>
          </div>
        } @else if (languages.chosen()) {
          <div>
            <button hlmBtn variant="quiet" size="sm" type="button" (click)="reset()">{{ 'yourLanguages.reset' | t }}</button>
          </div>
        }
      </div>
    </app-setting-group>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LanguageSettingsComponent {
  readonly languages = inject(LanguagesService);

  readonly choices = LANGUAGE_CHOICES;
  readonly max = LANGUAGES_MAX;

  /** The order on screen, which applies only on Save. */
  readonly draft = linkedSignal(() => this.languages.languages());
  readonly changed = computed(() => this.draft().join(',') !== this.languages.languages().join(','));
  readonly choiceList = computed(() => this.choices.map(code => ({ value: code, label: this.name(code) })));

  private readonly names = (() => {
    try {
      return new Intl.DisplayNames([locale()], { type: 'language' });
    } catch {
      return null;
    }
  })();

  name(code: string): string {
    const name = this.names?.of(code) ?? code.toUpperCase();
    return name.charAt(0).toLocaleUpperCase(locale()) + name.slice(1);
  }

  save(): void {
    this.languages.save(this.draft());
  }

  cancel(): void {
    this.draft.set(this.languages.languages());
  }

  reset(): void {
    this.languages.save([]);
  }
}
