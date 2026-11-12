import { ChangeDetectionStrategy, Component, Injectable, computed, inject, signal } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { DescriptionSource } from '@shared/tmdb/describe';
import { BackButtonService } from '../../services/back-button.service';
import { FocusScopeDirective } from '../../directives/focus-scope.directive';
import { TPipe } from '../../pipes/t.pipe';

/** A description to read whole. */
export interface Reading {
  title: string;
  /** "S5 E2 · Episode 2", or nothing. */
  subtitle?: string;
  text: string;
  source: DescriptionSource;
}

/**
 * Opens a description to read whole.
 *
 * Everywhere a description is shown it is cut to a few lines, so that a
 * season's episodes fit a screen; this is where the rest is. Opened by a
 * "More" link, by an episode's Description button where there is a pointer,
 * and by holding an episode -- a long press on a phone, holding OK on a
 * television.
 */
@Injectable({ providedIn: 'root' })
export class DescriptionReaderService {
  readonly reading = signal<Reading | null>(null);

  /** What had focus when it opened, for focus to go back to: an episode card held on a television. */
  private returnTo: HTMLElement | null = null;

  open(reading: Reading): void {
    this.returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.reading.set(reading);
  }

  close(): void {
    this.reading.set(null);
    const back = this.returnTo;
    this.returnTo = null;
    requestAnimationFrame(() => back?.isConnected && back.focus({ preventScroll: true }));
  }
}

/** The description, whole: a sheet on a phone, a dialog elsewhere. Back closes it. */
@Component({
  selector: 'app-description-reader',
  standalone: true,
  imports: [TPipe, HlmButton, FocusScopeDirective],
  template: `
    @if (reader.reading(); as reading) {
      <div
        class="fixed inset-0 z-[60] flex items-end bg-[color-mix(in_oklch,var(--background)_88%,transparent)] md:items-center md:justify-center md:p-4"
        data-focus-scope
        data-description-reader
        data-enter="sheet"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="reading.title"
        (click)="onBackdrop($event)"
      >
        <div class="flex max-h-[85dvh] w-full flex-col gap-4 rounded-t-xl bg-card p-5 md:max-w-2xl md:rounded-lg">
          <div>
            <h2 class="text-xl font-bold tracking-tight">{{ reading.title }}</h2>
            @if (reading.subtitle) {
              <p class="mt-0.5 text-sm text-muted-foreground">{{ reading.subtitle }}</p>
            }
          </div>
          <div class="min-h-0 overflow-y-auto">
            <p class="text-base leading-relaxed whitespace-pre-line">{{ reading.text }}</p>
            @if (reading.source === 'tmdb') {
              <p class="mt-2 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{{ 'describe.fromTmdb' | t }}</p>
            }
          </div>
          <button hlmBtn variant="primary" type="button" class="self-end" data-focus-first (click)="reader.close()">
            {{ 'common.close' | t }}
          </button>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DescriptionReaderComponent {
  readonly reader = inject(DescriptionReaderService);

  constructor() {
    inject(BackButtonService).bindTo(
      computed(() => this.reader.reading() !== null),
      () => this.reader.close()
    );
  }

  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.reader.close();
    }
  }
}
