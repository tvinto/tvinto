import { ConfirmService } from '../../services/confirm.service';
import { ChangeDetectionStrategy, Component, computed, inject, signal, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideLoaderCircle,
  lucideRefreshCw,
  lucideTrash2,
  lucideTriangleAlert
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { ProviderSubscription } from '@shared/types';
import { AccountService, SubscriptionCheck } from '../../services/account.service';
import { ProviderAccessService } from '../../services/provider-access.service';
import { ProvidersService } from '../../services/providers.service';
import { CarryOverService } from '../../services/carry-over.service';
import { GuideSourcesService } from '../../services/guide-sources.service';
import { t } from '../../utils/i18n';
import { TDatePipe, TPipe } from '../../pipes/t.pipe';

/**
 * Where the Xtream credentials live.
 *
 * Separate from signing in on purpose. These expire and get reissued; entering
 * the new ones here updates one record and leaves favourites, arranging and
 * history exactly where they are.
 */
@Component({
  selector: 'app-subscription',
  standalone: true,
  imports: [TPipe, TDatePipe, ReactiveFormsModule, NgTemplateOutlet, NgIcon, HlmButton, HlmInput, HlmLabel],
  providers: [
    provideIcons({
      lucideCheck,
      lucideLoaderCircle,
      lucideRefreshCw,
      lucideTrash2,
      lucideTriangleAlert
    })
  ],
  templateUrl: './subscription.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SubscriptionComponent {
  private readonly accounts = inject(AccountService);
  private readonly confirm = inject(ConfirmService);

  /** Whether a subscription may be added or changed here: not by a kid at its own device. */
  readonly canChangeSetup = this.accounts.canChangeSetup;
  private readonly router = inject(Router);
  private readonly providerAccess = inject(ProviderAccessService);

  private readonly providers = inject(ProvidersService);
  private readonly carry = inject(CarryOverService);
  private readonly guideSources = inject(GuideSourcesService);

  /**
   * The account's subscription rows, less the other providers': those are
   * rows too, and are the Other providers card's to show.
   */
  readonly subscriptions = computed(() =>
    this.accounts
      .subscriptions()
      // A playlist as the main provider is the Providers card's to show and
      // replace: it has no login for this form.
      .filter(subscription => !this.providers.otherIds().has(String(subscription.id)) && subscription.serverUrl !== '')
  );
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly notice = signal('');

  /** What is known about the subscription just saved, if one just was. */
  readonly check = signal<SubscriptionCheck | null>(null);

  readonly isFirstOne = computed(() => this.subscriptions().length === 0);

  /** Drawn as the Account page's right-hand column rather than a page (D-10). */
  readonly embedded = input(false);

  readonly showPassword = signal(false);

  readonly form = new FormGroup({
    serverUrl: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    username: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    label: new FormControl('', { nonNullable: true })
  });

  private readonly serverUrl = toSignal(this.form.controls.serverUrl.valueChanges, { initialValue: '' });

  /** An address that is plain http, which is what puts the warning under it. */
  readonly plainHttp = computed(() => /^\s*http:\/\//i.test(this.serverUrl() ?? ''));

  /** What a stored subscription is called: its label, or failing that something that is not blank. */
  constructor() {
    this.loading.set(true);
    this.accounts.loadSubscriptions().subscribe({
      next: () => {
        this.loading.set(false);
        void this.showStored();
      },
      error: () => this.loading.set(false)
    });
  }

  /**
   * Fills the form with the subscription this device uses, so the address,
   * username and password are there to read and correct rather than blank.
   * Left alone if somebody has already started typing.
   */
  private async showStored(): Promise<void> {
    const stored = await this.providerAccess.currentCredentials();
    if (!stored || this.form.dirty) {
      return;
    }
    const active = this.subscriptions().find(subscription => subscription.active);
    this.form.patchValue({
      serverUrl: stored.serverUrl,
      username: stored.username,
      password: stored.password,
      label: active?.label ?? ''
    });
  }

  /** Fills the form from an existing subscription, ready for renewed details. */
  renew(subscription: ProviderSubscription): void {
    this.form.patchValue({
      serverUrl: subscription.serverUrl,
      username: subscription.xtreamUsername,
      password: '',
      label: subscription.label ?? ''
    });
    this.notice.set(t('sub.enterNewPassword'));
    this.error.set('');
    this.check.set(null);
  }

  async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.error.set(t('sub.allNeeded'));
      return;
    }

    // What the account refers to under the subscription being replaced, read
    // while it is still the one in use (CarryOverService). Null on a first
    // subscription, and on a browser, which keeps no catalogue.
    const snapshot = this.isFirstOne() ? null : await this.carry.snapshot('').catch(() => null);

    const { serverUrl, username, password, label } = this.form.getRawValue();

    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    this.check.set(null);

    this.accounts
      .saveSubscription({
        serverUrl: serverUrl.trim(),
        username: username.trim(),
        password,
        label: label.trim() || undefined
      })
      .subscribe({
        next: result => {
          this.saving.set(false);
          // Left in the form, which is what was just saved: the page shows
          // the subscription in use rather than going blank.
          this.form.markAsPristine();
          this.check.set(result.check);

          this.accounts.loadSubscriptions().subscribe();

          // Its own guide comes with it (GuideSourcesService.addGuidesOf).
          void this.guideSources.addGuidesOf('').catch(() => 0);

          if (snapshot) {
            void this.carry.carryOver(snapshot).then(moved => {
              if (moved) {
                this.notice.set(t('providers.carried', { count: moved }));
              }
            });
          }

          if (result.check === 'confirmed') {
            // Nothing more to decide -- take them to what they came for.
            void this.router.navigate(['/for-you']);
          }
        },
        error: (err: unknown) => {
          this.saving.set(false);
          this.error.set(this.accounts.describeError(err));
        }
      });
  }

  async remove(subscription: ProviderSubscription): Promise<void> {
    // By its name, or the server it is on: the username was empty for a
    // subscription the sync service keeps sealed, and asked "Remove the
    // subscription for ""?" -- and it is half of a login besides.
    const name = subscription.label?.trim() || hostOf(subscription.serverUrl);
    const sure = await this.confirm.ask({
      title: name ? t('sub.confirmRemove', { name }) : t('sub.confirmRemoveThis'),
      confirmLabel: t('common.remove'),
      destructive: true
    });
    if (!sure) {
      return;
    }

    this.accounts.removeSubscription(subscription.id).subscribe({
      next: () => this.notice.set(t('sub.removed')),
      error: (err: unknown) => this.error.set(this.accounts.describeError(err))
    });
  }

  /** Available once something works, so the setup page is not a dead end. */
  goToLibrary(): void {
    void this.router.navigate(['/for-you']);
  }
}

/** "mag.example.com" from a server address, or nothing when it is not one. */
const hostOf = (address: string): string => {
  try {
    return new URL(address).hostname;
  } catch {
    return '';
  }
};
