import { ChangeDetectionStrategy, Component, inject, computed } from '@angular/core';
import { SKIP_INTROS, SkipIntros } from '@shared/player';
import { ChoiceChipsComponent } from '../../ui/choice-chips.component';
import { t } from '../../utils/i18n';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { PlayerPreferencesService } from '../../services/player-preferences.service';
import { TPipe } from '../../pipes/t.pipe';

/**
 * The picture on a television: whether it switches its refresh rate to the
 * video's. Shown only on a television, the one
 * device whose player acts on it; an account setting like the subtitle ones.
 */
@Component({
  selector: 'app-picture-settings',
  standalone: true,
  imports: [TPipe, SettingGroupComponent, SettingRowComponent, ChoiceChipsComponent],
  host: { class: 'contents' },
  template: `
    <app-setting-group [heading]="'picture.title' | t" data-tv-only-block data-picture-settings>
      <app-setting-row [label]="'picture.matchRate' | t" [sub]="'picture.matchRateHelp' | t" kind="switch" [checked]="matching()" focusKey="picture-match" (activate)="toggle()" />
    </app-setting-group>

    <!-- Every device's player skips, so this is not the television's alone. -->
    <app-setting-group [heading]="'player.skipIntros' | t" data-skip-settings>
      <app-setting-row [label]="'player.skipIntrosSub' | t" [sub]="'player.skipIntrosHelp' | t" kind="static">
        <app-choice-chips
          rowEnd
          [label]="'player.skipIntros' | t"
          [choices]="skipChoices()"
          [value]="skipping()"
          (valueChange)="$event && choose($event)"
          focusKey="player-skip-intros"
        />
      </app-setting-row>
    </app-setting-group>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PictureSettingsComponent {
  private readonly preferences = inject(PlayerPreferencesService);

  readonly matching = computed(() => this.preferences.preferences().matchFrameRate);

  toggle(): void {
    this.preferences.update({ matchFrameRate: !this.matching() });
  }

  readonly skipping = computed(() => this.preferences.preferences().skipIntros);
  readonly skipChoices = computed(() =>
    SKIP_INTROS.map(value => ({ value, label: t(value === 'button' ? 'player.skipButton' : value === 'auto' ? 'player.skipAuto' : 'player.skipOff') }))
  );

  choose(value: SkipIntros): void {
    this.preferences.update({ skipIntros: value });
  }
}
