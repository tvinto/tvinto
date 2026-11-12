import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { t } from '../../utils/i18n';
import { ChoicePanelService } from '../../ui/choice-panel.service';
import { SettingRowComponent } from '../../ui/setting-row.component';

/**
 * Language, on Account and the welcome screen: a row that opens the panel
 * (DS-TV-2, DS-TV-4). Each language is named in itself, so somebody who
 * cannot read the one in use can still find theirs. Applied at once. A row
 * rather than chips: sixteen chips ran off the welcome card.
 */
@Component({
  selector: 'app-language-picker',
  standalone: true,
  imports: [SettingRowComponent],
  host: { class: 'contents' },
  template: `
    <app-setting-row [label]="title()" [value]="currentLabel()" [focusKey]="focusKey()" data-language (activate)="choose()" />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LanguagePickerComponent {
  readonly focusKey = input('account-language');
  readonly languages = inject(LanguageService);
  private readonly panels = inject(ChoicePanelService);

  readonly title = computed(() => t('language.title'));
  readonly currentLabel = computed(() => this.languages.languages.find(language => language.id === this.languages.current())?.label ?? '');

  async choose(): Promise<void> {
    const choices = this.languages.languages.map(language => ({ value: language.id, label: language.label }));
    const chosen = await this.panels.choose(this.title(), choices, this.languages.current());
    if (chosen) {
      void this.languages.choose(chosen.value);
    }
  }
}
