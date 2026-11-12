import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { SETTING_KEYS } from '@shared/types';
import { ChannelPreviewService } from '../../services/channel-preview.service';
import { SettingsService } from '../../services/settings.service';
import { TPipe } from '../../pipes/t.pipe';

/**
 * Whether a television plays the channel in focus above the guide
 * (ChannelPreviewService). Shown only where it can: a television whose APK
 * has the preview window.
 */
@Component({
  selector: 'app-preview-settings',
  standalone: true,
  imports: [TPipe, SettingGroupComponent, SettingRowComponent],
  host: { class: 'contents' },
  template: `
    @if (preview.supported) {
      <app-setting-group [heading]="'preview.heading' | t" data-tv-only-block data-preview-settings>
        <app-setting-row [label]="'preview.title' | t" kind="switch" [checked]="preview.enabled()" focusKey="preview-on" (activate)="toggle()" />
      </app-setting-group>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PreviewSettingsComponent {
  readonly preview = inject(ChannelPreviewService);
  private readonly settings = inject(SettingsService);

  toggle(): void {
    this.settings.set(SETTING_KEYS.channelPreview, this.preview.enabled() ? 'off' : 'on');
  }
}
