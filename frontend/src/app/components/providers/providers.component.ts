import { normaliseMac } from '@shared/stalker/client';
import { PhoneFormOfferComponent } from '../phone-form-offer/phone-form-offer.component';
import { ConfirmService } from '../../services/confirm.service';
import { ChangeDetectionStrategy, Component, Injector, afterNextRender, inject, signal, computed } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideListVideo, lucidePlus, lucideSatelliteDish, lucideTrash2 } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { ToastService } from '../../services/toast.service';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { ProviderRecord } from '@shared/providers/providerRecord';
import { TPipe } from '../../pipes/t.pipe';
import { ProviderInput, ProvidersService } from '../../services/providers.service';
import { AccountService } from '../../services/account.service';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { t } from '../../utils/i18n';

/** What the form is doing: adding one of a kind, or replacing a provider's login. */
type Editing = { mode: 'add'; kind: 'xtream' | 'm3u' | 'stalker' } | { mode: 'replace'; record: ProviderRecord };

/**
 * The account's providers, on the Account page, every one alike.
 *
 * Everything from them shows side by side in the libraries, grouped under
 * each one's label as TiviMate groups playlists. Replace is for a
 * subscription that ran out: the new login goes into the same place, and
 * favourites, history and guide matches stay with it.
 */
@Component({
  selector: 'app-providers',
  standalone: true,
  imports: [PhoneFormOfferComponent, TPipe, ReactiveFormsModule, NgIcon, HlmButton, HlmInput, HlmLabel, SettingGroupComponent, SettingRowComponent],
  host: { class: 'contents' },
  providers: [provideIcons({ lucideListVideo, lucidePlus, lucideSatelliteDish, lucideTrash2 })],
  templateUrl: './providers.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProvidersComponent {
  readonly providers = inject(ProvidersService);
  private readonly accounts = inject(AccountService);
  private readonly confirm = inject(ConfirmService);
  private readonly tv = inject(TvNavigationService);
  private readonly injector = inject(Injector);

  readonly editing = signal<Editing | null>(null);
  readonly busy = signal(false);
  private readonly toast = inject(ToastService);
  readonly showPassword = signal(false);

  readonly form = new FormGroup({
    label: new FormControl('', { nonNullable: true }),
    serverUrl: new FormControl('', { nonNullable: true }),
    username: new FormControl('', { nonNullable: true }),
    password: new FormControl('', { nonNullable: true }),
    url: new FormControl('', { nonNullable: true }),
    portalUrl: new FormControl('', { nonNullable: true }),
    mac: new FormControl('', { nonNullable: true })
  });

  constructor() {
    void this.providers.load();
  }

  readonly kindOf = computed((): 'xtream' | 'm3u' | 'stalker' | null => {
    const editing = this.editing();
    return editing ? (editing.mode === 'add' ? editing.kind : editing.record.kind) : null;
  });

  /** What was typed on a phone (PhoneFormOfferComponent): into the form, saved only with Save. */
  fromPhone(fields: Record<string, string>): void {
    if (this.kindOf() === 'm3u') {
      this.form.patchValue({ url: fields['playlist'] ?? '' });
    } else if (this.kindOf() === 'stalker') {
      this.form.patchValue({ portalUrl: fields['server'] ?? '', mac: fields['mac'] ?? '' });
    } else {
      this.form.patchValue({ serverUrl: fields['server'] ?? '', username: fields['username'] ?? '', password: fields['password'] ?? '' });
    }
  }

  startAdding(kind: 'xtream' | 'm3u' | 'stalker'): void {
    this.form.reset();
    this.editing.set({ mode: 'add', kind });
    this.focusForm();
  }

  startReplacing(record: ProviderRecord): void {
    this.form.reset({
      label: record.label,
      serverUrl: record.kind === 'xtream' ? record.serverUrl : '',
      username: record.kind === 'xtream' ? record.username : '',
      password: '',
      url: record.kind === 'm3u' ? record.url : '',
      portalUrl: record.kind === 'stalker' ? record.portalUrl : '',
      // The MAC is a password: shown again only as typed anew.
      mac: ''
    });
    this.editing.set({ mode: 'replace', record });
    this.focusForm();
  }

  /**
   * Into the form's first field on a television. The button that opened it
   * is gone once it opens, and focus went with it: nothing was lit until an
   * arrow was pressed. Not elsewhere, where focusing a field raises the
   * keyboard before anybody asked for it.
   */
  private focusForm(): void {
    if (!this.tv.isTelevision()) {
      return;
    }
    afterNextRender(() => document.querySelector<HTMLElement>('[data-provider-form] input')?.focus({ preventScroll: false }), {
      injector: this.injector
    });
  }

  cancel(): void {
    this.editing.set(null);
  }

  async submit(): Promise<void> {
    const editing = this.editing();
    const kind = this.kindOf();
    if (!editing || !kind) {
      return;
    }
    const value = this.form.getRawValue();
    const input: ProviderInput =
      kind === 'xtream'
        ? { kind, label: value.label, serverUrl: value.serverUrl, username: value.username, password: value.password }
        : kind === 'stalker'
          ? { kind, label: value.label, portalUrl: value.portalUrl, mac: value.mac }
          : { kind, label: value.label, url: value.url };

    const missing =
      input.kind === 'xtream'
        ? !input.serverUrl.trim() || !input.username.trim() || !input.password
        : input.kind === 'stalker'
          ? !input.portalUrl.trim() || !normaliseMac(input.mac)
          : !/^https?:\/\/\S+$/i.test(input.url.trim());
    if (missing) {
      this.failed(t(kind === 'xtream' ? 'sub.allNeeded' : kind === 'stalker' ? 'providers.portalNeeded' : 'providers.urlNeeded'));
      return;
    }

    this.busy.set(true);
    try {
      if (editing.mode === 'add') {
        await this.providers.add(input);
      } else {
        const moved = await this.providers.replace(editing.record, input);
        this.toast.success(t(moved ? 'providers.carried' : 'providers.replaced', { count: moved }));
      }
      this.editing.set(null);
      this.form.reset();
    } catch (error) {
      this.failed(this.accounts.describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async toggle(record: ProviderRecord): Promise<void> {
    await this.run(() => this.providers.setEnabled(record, !record.enabled));
  }

  async remove(record: ProviderRecord): Promise<void> {
    const sure = await this.confirm.ask({
      title: t('providers.confirmRemove', { name: record.label }),
      confirmLabel: t('common.remove'),
      destructive: true
    });
    if (!sure) {
      return;
    }
    await this.run(() => this.providers.remove(record));
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await work();
    } catch (error) {
      this.failed(this.accounts.describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** A failure, in the error dialog as everywhere (5 October). */
  private failed(message: string): void {
    this.toast.error(t('providers.failed'), message);
  }
}
