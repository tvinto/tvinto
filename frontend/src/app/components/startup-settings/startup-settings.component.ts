import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, computed, signal } from '@angular/core';
import { App } from '@capacitor/app';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { ChoiceChipsComponent } from '../../ui/choice-chips.component';
import { SETTING_KEYS } from '@shared/types';
import { openLastChannelValue, opensLastChannel } from '@shared/startup';
import { SettingsService } from '../../services/settings.service';
import { ToastService } from '../../services/toast.service';
import { startUp } from '../../services/native/startUp';
import { TPipe } from '../../pipes/t.pipe';
import { t } from '../../utils/i18n';

/**
 * How a television starts: whether the app opens when the television is
 * turned on, as TiviMate offers (device/StartUp.java), and what it opens on
 * -- For You, or the last channel watched (shared/startup.ts). Shown only on
 * a television.
 *
 * Opening by itself is this device's own: Android needs "Display over other
 * apps" granted on it, so turning it on goes to that page, and it stays off
 * when the permission is not given. What it opens on is the account's, like
 * the picture settings.
 */
@Component({
  selector: 'app-startup-settings',
  standalone: true,
  imports: [TPipe, SettingGroupComponent, SettingRowComponent, ChoiceChipsComponent],
  host: { class: 'contents' },
  template: `
    <!-- On Account a group of its own; inside the first launch's Starting up
         step, just its rows (OnboardingComponent). -->
    <app-setting-group [heading]="embedded() ? '' : ('startup.title' | t)" [attr.data-tv-only-block]="embedded() ? null : ''" data-startup-settings>
      @if (canOpenByItself) {
        <app-setting-row
          [label]="'startup.turnOn' | t"
          kind="switch"
          [checked]="opensByItself()"
          focusKey="startup-turn-on"
          data-startup-turn-on
          (activate)="toggleOpensByItself()"
        />
      }
      <app-setting-row [label]="'startup.openOn' | t" kind="static">
        <app-choice-chips
          rowEnd
          [label]="'startup.openOn' | t"
          [choices]="openOnChoices()"
          [value]="lastChannel() ? 'last' : 'forYou'"
          (valueChange)="openOn($event === 'last')"
          focusKey="startup-open-on"
        />
      </app-setting-row>
    </app-setting-group>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StartupSettingsComponent {
  /** What it opens on: For You, or the channel last watched. */
  readonly openOnChoices = computed(() => [
    { value: 'forYou', label: t('nav.forYou') },
    { value: 'last', label: t('startup.lastChannel') }
  ]);

  private readonly settings = inject(SettingsService);
  private readonly toasts = inject(ToastService);

  /** Its rows only, without the card and its heading: inside the first launch. */
  readonly embedded = input(false);

  /** Whether this APK can open the app by itself at all (1.0.121 and later). */
  readonly canOpenByItself = startUp !== null;

  readonly opensByItself = signal(false);

  readonly lastChannel = computed(() => opensLastChannel(this.settings.get(SETTING_KEYS.openLastChannel)));

  /** Turned on, and gone to Android's page for the permission: decided when the app is back. */
  private askedForPermission = false;

  constructor() {
    if (!startUp) {
      return;
    }
    void startUp.state().then(state => this.opensByItself.set(state.enabled && state.allowed)).catch(() => undefined);
    const listening = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive && this.askedForPermission) {
        this.askedForPermission = false;
        void this.afterAsking();
      }
    });
    inject(DestroyRef).onDestroy(() => void listening.then(handle => handle.remove()));
  }

  openOn(lastChannel: boolean): void {
    this.settings.set(SETTING_KEYS.openLastChannel, openLastChannelValue(lastChannel));
  }

  async toggleOpensByItself(): Promise<void> {
    if (!startUp) {
      return;
    }
    if (this.opensByItself()) {
      await startUp.set({ enabled: false });
      this.opensByItself.set(false);
      return;
    }
    const state = await startUp.set({ enabled: true });
    if (state.allowed) {
      this.opensByItself.set(true);
      return;
    }
    if (state.canAsk && (await startUp.ask()).opened) {
      this.askedForPermission = true;
      return;
    }
    await this.notAllowed();
  }

  /** Back from Android's page: on if the permission was given, off and said why if not. */
  private async afterAsking(): Promise<void> {
    const state = await startUp!.state();
    if (state.allowed) {
      this.opensByItself.set(state.enabled);
      return;
    }
    await this.notAllowed();
  }

  private async notAllowed(): Promise<void> {
    await startUp!.set({ enabled: false });
    this.opensByItself.set(false);
    this.toasts.error(t('startup.notAllowed'), t('startup.notAllowedBody'));
  }
}
