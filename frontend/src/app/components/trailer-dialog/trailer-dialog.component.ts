import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { HlmButton } from '@spartan-ng/helm/button';
import { trailerEmbed } from '@shared/tmdb/trailers';
import { TrailerService } from '../../services/trailer.service';
import { BackButtonService } from '../../services/back-button.service';
import { FocusScopeDirective } from '../../directives/focus-scope.directive';
import { TPipe } from '../../pipes/t.pipe';

/**
 * A trailer (D-22, P-21): YouTube's player at 16:9 over the page, playing
 * on open, with the other trailers as chips beneath it. Esc, Back or Close
 * shuts it. On a television, the panel shown while the trailer is handed to
 * YouTube's app instead (TV-33).
 */
@Component({
  selector: 'app-trailer-dialog',
  standalone: true,
  imports: [HlmButton, FocusScopeDirective, TPipe],
  template: `
    @if (trailers.request(); as request) {
      <div
        class="fixed inset-0 z-[65] flex items-center justify-center bg-[color-mix(in_oklch,var(--background)_88%,transparent)] p-0 sm:p-6"
        data-focus-scope
        data-trailer-dialog
        data-enter="dialog"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'trailer.title' | t"
        (click)="onBackdrop($event)"
        (keydown.escape)="trailers.close()"
      >
        <div class="flex h-full w-full max-w-5xl flex-col gap-4 bg-background p-4 sm:h-auto sm:rounded-2xl sm:p-6">
          <div class="flex items-center gap-3">
            <div class="min-w-0 flex-1">
              <h2 class="text-lg font-bold">{{ 'trailer.title' | t }}</h2>
              <p class="truncate text-sm text-muted-foreground">{{ request.title }}</p>
            </div>
            <button hlmBtn type="button" data-trailer-close (click)="trailers.close()">{{ 'trailer.close' | t }}</button>
          </div>
          <div class="relative aspect-video w-full overflow-hidden rounded-md bg-black">
            <iframe
              class="absolute inset-0 h-full w-full"
              [src]="embed()"
              [title]="request.current.name"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowfullscreen
              referrerpolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation"
              data-trailer-player
            ></iframe>
          </div>
          @if (request.trailers.length > 1) {
            <div class="flex flex-wrap gap-2" role="group" [attr.aria-label]="'trailer.title' | t" data-trailer-chips>
              @for (trailer of request.trailers; track trailer.key) {
                <button class="chip"
                  type="button"
                  [attr.aria-pressed]="trailer.key === request.current.key"
                  (click)="trailers.choose(trailer)"
                >
                  {{ trailer.name || ('trailer.title' | t) }}
                </button>
              }
            </div>
          }
          <p class="text-xs text-muted-foreground">{{ 'trailer.fromYouTube' | t }}</p>
        </div>
      </div>
    }

    @if (trailers.opening(); as opening) {
      <!-- TV-33: the second or so a television takes to hand the trailer over, so it never looks frozen. -->
      <div class="fixed inset-0 z-[65] flex items-center justify-center bg-[color-mix(in_oklch,var(--background)_88%,transparent)]" data-trailer-opening role="status">
        <div class="flex flex-col items-center gap-2 rounded-2xl bg-card px-10 py-8 text-center">
          <p class="text-xl font-bold">{{ 'trailer.opening' | t }}</p>
          <p class="text-muted-foreground">{{ opening.title }}@if (opening.name) { · {{ opening.name }} }</p>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TrailerDialogComponent {
  readonly trailers = inject(TrailerService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly back = inject(BackButtonService);
  private release: (() => void) | null = null;

  /** YouTube's player for the trailer chosen: an address built here from a checked id, never one from a response. */
  readonly embed = computed<SafeResourceUrl | null>(() => {
    const current = this.trailers.request()?.current;
    return current ? this.sanitizer.bypassSecurityTrustResourceUrl(trailerEmbed(current.key)) : null;
  });

  constructor() {
    // Back closes the dialog before it leaves the page.
    effect(() => {
      const open = this.trailers.request() !== null;
      if (open && !this.release) {
        this.release = this.back.whileOpen(() => this.trailers.close());
        setTimeout(() => document.querySelector<HTMLElement>('[data-trailer-close]')?.focus({ preventScroll: true }));
      } else if (!open && this.release) {
        this.release();
        this.release = null;
      }
    });
  }

  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.trailers.close();
    }
  }
}
