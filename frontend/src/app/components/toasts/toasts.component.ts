import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleAlert, lucideCircleCheck, lucideInfo, lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { Toast, ToastService } from '../../services/toast.service';
import { BackButtonService } from '../../services/back-button.service';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { TPipe } from '../../pipes/t.pipe';

/**
 * Where toasts are drawn: the bottom right, over everything, in the root.
 *
 * In the root rather than the shell, so the sign-in screen has them too.
 * `role="status"` for most and `alert` for errors, so a screen reader says the
 * failures at once and the rest when it is quiet.
 *
 * A toast that offers something -- "Play the HD version" -- takes focus on a
 * television, since a remote cannot reach a corner of the screen that nothing
 * leads to, and the offer is the whole point of that toast. Back dismisses it,
 * and focus goes back to where it was taken from.
 */
@Component({
  selector: 'app-toasts',
  standalone: true,
  imports: [TPipe, NgIcon, HlmButton],
  providers: [provideIcons({ lucideCircleAlert, lucideCircleCheck, lucideInfo, lucideX })],
  template: `
    <div class="pointer-events-none fixed right-4 bottom-4 z-[1300] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2" data-toasts>
      @for (toast of toasts(); track toast.id) {
        <div
          class="pointer-events-auto flex items-start gap-3 rounded-lg border bg-card p-4 shadow-2xl"
          [class]="toast.kind === 'error' ? 'border-destructive/50' : toast.kind === 'success' ? 'border-live/50' : 'border-border-2'"
          [attr.role]="toast.kind === 'error' ? 'alert' : 'status'"
          [attr.data-toast]="toast.kind"
        >
          <ng-icon
            [name]="toast.kind === 'error' ? 'lucideCircleAlert' : toast.kind === 'success' ? 'lucideCircleCheck' : 'lucideInfo'"
            size="20"
            class="mt-0.5 shrink-0"
            [class]="toast.kind === 'error' ? 'text-destructive' : toast.kind === 'success' ? 'text-live' : 'text-muted-foreground'"
          />
          <div class="min-w-0 flex-1">
            <p class="font-semibold">{{ toast.title }}</p>
            @if (toast.message) {
              <p class="mt-0.5 text-sm text-muted-foreground">{{ toast.message }}</p>
            }
            @if (toast.action; as action) {
              <button hlmBtn variant="primary" size="sm" type="button" class="mt-3" data-toast-action (click)="act(toast)">
                {{ action.label }}
              </button>
            }
          </div>
          <button
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            [attr.aria-label]="'toast.dismiss' | t"
            data-toast-dismiss
            (click)="toastService.dismiss(toast.id)"
          >
            <ng-icon name="lucideX" size="16" />
          </button>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ToastsComponent {
  readonly toastService = inject(ToastService);
  private readonly back = inject(BackButtonService);
  private readonly tv = inject(TvNavigationService);

  readonly toasts = this.toastService.toasts;

  /** The newest toast with something to offer, which is the one that takes focus. */
  private readonly offering = computed(() => [...this.toasts()].reverse().find(toast => toast.action) ?? null);

  /** What had focus before a toast took it. */
  private focusedBefore: HTMLElement | null = null;

  constructor() {
    this.back.bindTo(
      computed(() => this.offering() !== null),
      () => {
        const toast = this.offering();
        if (toast) {
          this.toastService.dismiss(toast.id);
        }
      }
    );

    let focusedFor: number | null = null;
    effect(() => {
      const toast = this.offering();
      untracked(() => {
        if (toast && toast.id !== focusedFor && this.tv.isTelevision()) {
          focusedFor = toast.id;
          const active = document.activeElement as HTMLElement | null;
          if (!active?.closest('[data-toasts]')) {
            this.focusedBefore = active && active !== document.body ? active : null;
          }
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>('[data-toasts] [data-toast-action]')?.focus()
          );
        }
        if (!toast && focusedFor !== null) {
          focusedFor = null;
          this.giveFocusBack();
        }
      });
    });
  }

  act(toast: Toast): void {
    this.toastService.dismiss(toast.id);
    // What it does next may open a player or a page, which places focus itself.
    this.focusedBefore = null;
    toast.action?.run();
  }

  private giveFocusBack(): void {
    const before = this.focusedBefore;
    this.focusedBefore = null;
    const active = document.activeElement;
    // Only if focus was left on the toast, or on nothing when it went.
    if (!active || active === document.body || active.closest('[data-toasts]')) {
      if (before?.isConnected) {
        before.focus({ preventScroll: true });
      } else {
        this.tv.focusContentWhenReady();
      }
    }
  }
}
