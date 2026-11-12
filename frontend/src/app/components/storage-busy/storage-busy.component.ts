import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { DatabaseSpaceService } from '../../services/database-space.service';
import { BackButtonService } from '../../services/back-button.service';
import { FocusScopeDirective } from '../../directives/focus-scope.directive';
import { TPipe } from '../../pipes/t.pipe';
import { elapsed } from '../../utils/storage.utils';

/**
 * Over everything while the device's database is being cleaned
 * (DatabaseSpaceService): pressed on Account, or found still running from
 * standby when the app comes back. Every database call of the app waits
 * meanwhile, so this says why nothing else moves. Cancel only where the clean
 * can stop; Back does the same.
 */
@Component({
  selector: 'app-storage-busy',
  standalone: true,
  imports: [TPipe, HlmButton, FocusScopeDirective],
  template: `
    @if (storage.cleaning() !== null) {
      <div
        class="fixed inset-0 z-[1230] flex items-center justify-center bg-background p-6 outline-none"
        tabindex="-1"
        data-focus-scope
        data-storage-busy
        role="status"
        aria-live="polite"
      >
        <div class="flex flex-col items-center gap-4 text-center">
          <h2 class="text-2xl font-bold">{{ 'storage.busy' | t }}</h2>
          <p class="text-lg text-muted-foreground tabular-nums">{{ elapsed(storage.cleaning()!) }}</p>
          @if (storage.cancellable() || stopping()) {
            <button hlmBtn type="button" variant="secondary" data-storage-cancel (click)="stop()">
              {{ (stopping() ? 'storage.stopping' : 'common.cancel') | t }}
            </button>
          }
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StorageBusyComponent {
  readonly storage = inject(DatabaseSpaceService);

  /** Cancel pressed; over when the clean is. */
  readonly stopping = signal(false);

  readonly elapsed = elapsed;

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;

  /** Open or not, without the seconds: the focus below follows this, not the clock. */
  private readonly open = computed(() => this.storage.cleaning() !== null);

  constructor() {
    // Focus off the page behind as the screen opens -- or OK would press
    // whatever had it -- and onto Cancel once it shows, which is a moment
    // later: whether this clean can stop is known from its first word.
    effect(() => {
      const open = this.open();
      const cancellable = this.storage.cancellable();
      if (!open) {
        return;
      }
      requestAnimationFrame(() => {
        const target = this.host.querySelector<HTMLElement>(cancellable ? '[data-storage-cancel]' : '[data-storage-busy]');
        if (target && (cancellable || !this.host.contains(document.activeElement))) {
          target.focus({ preventScroll: true });
        }
      });
    });
    effect(() => {
      if (this.storage.cleaning() === null) {
        this.stopping.set(false);
      }
    });
    inject(BackButtonService).bindTo(
      this.open,
      () => this.stop()
    );
  }

  stop(): void {
    if (!this.storage.cancellable()) {
      return;
    }
    this.stopping.set(true);
    void this.storage.cancel();
  }
}
