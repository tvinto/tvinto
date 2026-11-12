import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DisplaySizeService } from '../../services/display-size.service';
import { t } from '../../utils/i18n';
import { ChoiceChipsComponent } from '../../ui/choice-chips.component';
import { SettingRowComponent } from '../../ui/setting-row.component';

/**
 * Display size, on Account: a row with its steps as chips (DS-TV-2), applied
 * the moment one is pressed so the choice is judged on the real screen rather
 * than on a preview.
 */
@Component({
  selector: 'app-display-size',
  standalone: true,
  imports: [SettingRowComponent, ChoiceChipsComponent],
  host: { class: 'contents' },
  template: `
    @if (size.offered()) {
      <app-setting-row [label]="title()" kind="static" data-display-size>
        <app-choice-chips
          rowEnd
          [label]="title()"
          [choices]="choices()"
          [value]="size.current().id"
          (valueChange)="$event && size.choose($event)"
          focusKey="display-size"
        />
      </app-setting-row>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DisplaySizeComponent {
  readonly size = inject(DisplaySizeService);

  readonly title = computed(() => t('display.title'));
  readonly choices = computed(() => this.size.options().map(option => ({ value: option.id, label: t('display.' + option.id) })));
}
