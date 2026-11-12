import { ChangeDetectionStrategy, Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle } from '@ng-icons/lucide';
import { TPipe } from '../../pipes/t.pipe';
import { FamilyProfilesService, ProfileChoice } from '../../services/family-profiles.service';
import { AccountService } from '../../services/account.service';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { t } from '../../utils/i18n';
import { profileFace } from '../../utils/profile-face.utils';

/**
 * "Who's watching?" (board TV-20): the people of this device's household, one
 * straight row, focus on whoever was here last. Asked when the app opens on a
 * device with somebody to choose between and nobody here in the last four
 * hours, and reached from Account at any time.
 *
 * No "add person" here: adding somebody means choosing a password, which is
 * done on Account → Family, not with a remote.
 *
 * Large (NX-TV-10): each person a big round picture -- an animal on a colour
 * of its own, worked out from the name (profileFace), so it is the same on
 * every device with nothing to sync. The one with focus grows and the others
 * dim.
 */

@Component({
  selector: 'app-profile-picker',
  standalone: true,
  imports: [TPipe, NgIcon],
  providers: [provideIcons({ lucideLoaderCircle })],
  template: `
    <main class="flex min-h-dvh flex-col items-center justify-center gap-10 bg-background px-4 py-10" data-profile-picker>
      <h1 class="text-center text-3xl font-bold tracking-tight md:text-4xl">{{ 'profiles.title' | t }}</h1>

      <div class="flex max-w-full flex-wrap justify-center gap-6 md:gap-10" data-profile-row>
        @for (choice of choices(); track choice.username) {
          <button
            type="button"
            class="group flex w-28 flex-col items-center gap-3 rounded-xl p-2 outline-none md:w-40"
            data-profile
            [attr.data-focus-first]="choice.active ? '' : null"
            [attr.data-focus-key]="'profile-' + choice.username"
            [disabled]="profiles.switching() !== null"
            (click)="pick(choice)"
          >
            <span
              class="flex size-20 items-center justify-center overflow-hidden rounded-full text-white md:size-32"
              [style.background]="faceOf(choice.username, choice.picture).background"
              data-profile-face
            >
              @if (profiles.switching() === choice.username) {
                <ng-icon name="lucideLoaderCircle" size="32" class="animate-spin" />
              } @else {
                @let face = faceOf(choice.username, choice.picture);
                <img [src]="face.picture" alt="" [class]="face.own ? 'size-full object-cover' : 'size-[78%] object-contain'" draggable="false" />
              }
            </span>
            <span class="max-w-full truncate text-base font-semibold md:text-lg">{{ choice.username }}</span>
            @if (choice.active) {
              <span class="-mt-2 text-xs text-muted-foreground">{{ 'profiles.lastHere' | t }}</span>
            } @else if (profiles.needsPin(choice)) {
              <span class="-mt-2 text-xs font-semibold text-muted-foreground">{{ 'profiles.pin' | t }}</span>
            }
          </button>
        }
      </div>

      @if (error()) {
        <p class="max-w-md text-center text-sm text-destructive" role="alert">{{ error() }}</p>
      }

    </main>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfilePickerComponent {
  readonly profiles = inject(FamilyProfilesService);
  private readonly accounts = inject(AccountService);
  private readonly router = inject(Router);
  private readonly tv = inject(TvNavigationService);

  readonly choices = computed<ProfileChoice[]>(() => {
    this.accounts.account();
    return this.profiles.choices();
  });

  readonly error = signal('');

  readonly faceOf = profileFace;

  constructor() {
    // Nobody to choose between: nothing to ask.
    if (this.profiles.choices().length < 2) {
      this.profiles.stay();
      void this.router.navigate(['/for-you'], { replaceUrl: true });
      return;
    }
    // On whoever was here last (TV-20). Placed here rather than left to the
    // screen's first focus, which takes the first person in the row.
    afterNextRender(() => {
      document.querySelector<HTMLElement>('[data-profile-picker] [data-focus-first]')?.focus({ preventScroll: true });
      this.tv.focusContentWhenReady();
    });
  }

  async pick(choice: ProfileChoice): Promise<void> {
    this.error.set('');
    try {
      await this.profiles.switchTo(choice);
      if (choice.active) {
        void this.router.navigate(['/for-you'], { replaceUrl: true });
      }
    } catch (error) {
      this.error.set(
        error instanceof Error && error.message === 'not-ready'
          ? t('profiles.notReady', { name: choice.username })
          : this.accounts.describeError(error)
      );
    }
  }
}
