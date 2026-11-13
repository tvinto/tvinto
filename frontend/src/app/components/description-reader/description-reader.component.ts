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
        (focusin)="toTop(card)"
      >
        <!-- The card scrolls as a whole, Close held at its foot: on a television
             Close is the one place for focus, and Up and Down on it scroll
             the nearest scroller -- this one -- so a description longer than
             the screen can be read with the remote. -->
        <div class="flex max-h-[85dvh] w-full flex-col gap-4 overflow-y-auto rounded-t-xl bg-card p-5 pb-0 md:max-w-2xl md:rounded-lg" data-reader-card #card>
          <div>
            <h2 class="text-xl font-bold tracking-tight" data-reader-title>{{ reading.title }}</h2>
            @if (reading.subtitle) {
              <p class="mt-0.5 text-sm text-muted-foreground" data-reader-subtitle>{{ reading.subtitle }}</p>
            }
          </div>
          <div>
            <p class="text-base leading-relaxed whitespace-pre-line" data-reader-text>{{ reading.text }}</p>
            @if (reading.source === 'tmdb') {
              <p class="mt-2 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase" data-reader-source>{{ 'describe.fromTmdb' | t }}</p>
            }
          </div>
          <div class="sticky bottom-0 -mx-5 mt-auto flex justify-end bg-card px-5 pt-2 pb-5" data-reader-foot>
            <button hlmBtn variant="primary" type="button" data-focus-first (click)="reader.close()">
              {{ 'common.close' | t }}
            </button>
          </div>
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

  /**
   * Back to the start of the text when Close takes focus as the reader opens:
   * focusing Close, held at the foot, scrolled the card to bring it into
   * view, and the reader opened with its first lines and the name cut off.
   */
  toTop(card: HTMLElement): void {
    if (!card.dataset['opened']) {
      card.dataset['opened'] = '1';
      card.scrollTop = 0;
    }
  }

  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.reader.close();
    }
  }
}
