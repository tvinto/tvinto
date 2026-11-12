import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { TPipe } from '../../pipes/t.pipe';
import { AccountService } from '../../services/account.service';
import { ProvidersService } from '../../services/providers.service';
import { ProvidersComponent } from '../providers/providers.component';
import { SubscriptionComponent } from '../subscription/subscription.component';

/**
 * Where somebody with nothing to watch lands: the first provider.
 *
 * On a device that is the Providers card, an Xtream subscription or an M3U
 * playlist alike, and for somebody new it is the first screen of all -- no
 * account first, with signing in to sync as a link beside it. The library opens
 * once there is something in it.
 *
 * A browser keeps nothing itself and goes through the backend, so it keeps
 * the single-subscription form.
 */
@Component({
  selector: 'app-first-provider',
  standalone: true,
  imports: [TPipe, RouterLink, HlmButton, ProvidersComponent, SubscriptionComponent],
  template: `
    @if (providers.supported) {
      <div class="h-full overflow-y-auto">
        <div class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6" data-first-provider>
          <div class="flex flex-col gap-1">
            <h1 class="text-2xl font-bold tracking-tight">{{ 'local.firstTitle' | t }}</h1>
            <p class="text-sm text-muted-foreground">{{ 'local.firstLead' | t }}</p>
          </div>
          <app-providers />
          @if (accounts.localProfile.active()) {
            <div class="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground" data-sign-in-to-sync>
              <span>{{ 'local.syncLead' | t }}</span>
              <a hlmBtn variant="quiet" size="sm" class="px-1" routerLink="/sign-in">{{ 'local.signInToSync' | t }}</a>
            </div>
          }
        </div>
      </div>
    } @else {
      <app-subscription />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FirstProviderComponent {
  readonly accounts = inject(AccountService);
  readonly providers = inject(ProvidersService);
  private readonly router = inject(Router);

  /** How many providers there were once they had been read, so only one added here moves on. */
  private readonly baseline = signal<number | null>(null);

  constructor() {
    void this.providers.load().then(records => this.baseline.set(records.length));
    // Into the library as soon as there is something in it.
    effect(() => {
      const count = this.providers.all().length;
      const before = this.baseline();
      if (before !== null && count > before) {
        untracked(() => void this.router.navigate(['/for-you'], { replaceUrl: true }));
      }
    });
  }
}
