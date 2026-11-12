import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, effect, inject, signal, untracked, output, input } from '@angular/core';
import { ChosenDescription } from '@shared/tmdb/describe';
import { DescriptionsService } from '../../services/descriptions.service';
import { DescriptionReaderService } from '../description-reader/description-reader.component';
import { CutOffDirective } from '../../directives/cut-off.directive';
import { NgTemplateOutlet } from '@angular/common';
import { FocusScopeDirective } from '../../directives/focus-scope.directive';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCaptions,
  lucideListVideo,
  lucidePlay,
  lucideStar,
  lucideTrash2,
  lucideTv,
  lucideX,
  lucideCircleDot,
  lucideCircleStop
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { TPipe } from '../../pipes/t.pipe';

/** One thing that can be done to whatever the panel is about. */
export interface ItemAction {
  /** What the caller gets back. Nothing here knows what any of them mean. */
  id: string;
  label: string;
  /** A second line, for anything a label cannot carry on its own. */
  hint?: string;
  /** An `@ng-icons/lucide` name, from the set registered below. */
  icon: string;
  /** Draws it as a removal. Nothing here confirms anything. */
  danger?: boolean;
  /** A few words at the right-hand end: "OK" on the primary action, "matched" on a guide. */
  badge?: string;
}

/** The programme on air, for the head of a channel's panel (TV-3). */
/** A film the panel is about, for its description. */
export interface DescribedFilm {
  streamId: string | number;
  name: string;
}

export interface ItemNowPlaying {
  title: string;
  time: string;
  left: string | null;
  percent: number;
}

/**
 * Everything you can do to one channel, film or show, on one panel.
 *
 * It exists because of the television. A card used to carry its own controls --
 * a star, a cross, a guide button -- and on a remote each of those is a
 * separate small target reached by pressing Down and hoping. They were also
 * each focusable, which is why a focused card wore a ring around itself and
 * another around whichever control was picked out inside it.
 *
 * A panel costs one press more than a control on a card and gives back the
 * whole screen to aim at. Rows are full width and tall enough to be read from
 * across a room, and there is never more than one of them under the ring.
 *
 * It knows nothing about channels. The caller says what can be done and is told
 * which one was chosen, so the same panel serves a grid card, a favourite and
 * something half-watched, which have different answers.
 */
@Component({
  selector: 'app-item-actions',
  standalone: true,
  imports: [TPipe, NgIcon, HlmButton, FocusScopeDirective, NgTemplateOutlet, CutOffDirective],
  providers: [
    provideIcons({ lucideCircleDot, lucideCircleStop, lucideCaptions, lucideListVideo, lucidePlay, lucideStar, lucideTrash2, lucideTv, lucideX })
  ],
  templateUrl: './item-actions.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ItemActionsComponent {
  readonly name = input.required<string>();
  readonly subtitle = input('');
  /** The channel's own logo, if it has one. */
  readonly icon = input<string | null>(null);
  readonly actions = input<ItemAction[]>([]);
  /** Stands in for the logo when there is none, as the guide's tiles do. */
  readonly monogram = input('');
  readonly nowPlaying = input<ItemNowPlaying | null>(null);

  /**
   * A column beside the list rather than a sheet over it (TV-3, D-3).
   *
   * Nothing is covered, so the arrows can leave it: Left from the panel lands
   * on the programme it is about. That is why a docked panel is not a focus
   * scope -- a scope keeps focus in, which is right for a sheet over a page
   * and wrong for a column in one. It still takes focus when it opens.
   */
  readonly docked = input(false);

  /**
   * The film the panel is about, if it is one: its description is shown
   * under the name -- the provider's, or TMDB's. Nothing
   * else in the app described a film.
   */
  readonly film = input<DescribedFilm | null>(null);
  private readonly descriptions = inject(DescriptionsService);
  readonly description = signal<ChosenDescription | null>(null);

  private readonly reader = inject(DescriptionReaderService);

  readDescription(described: ChosenDescription): void {
    this.reader.open({ title: this.name(), text: described.text, source: described.source });
  }

  private readonly fetchDescription = effect(() => {
    const film = this.film();
    this.description.set(null);
    if (!film) {
      return;
    }
    untracked(() => {
      void this.descriptions
        .film(film.streamId, film.name)
        .then(found => {
          // Still the same film: a panel moved on to another card keeps its own.
          if (this.film() === film) {
            this.description.set(found);
          }
        })
        .catch(() => undefined);
    });
  });

  readonly chosen = output<string>();
  readonly closed = output<void>();

  /**
   * Left, from inside a docked panel.
   *
   * TV-3: "left from the panel lands on the block it belongs to". Left by
   * geometry lands on whatever programme happens to be nearest the panel's
   * edge, which is a different channel more often than not -- so the panel
   * says Left was pressed and the page puts focus back where the panel came
   * from.
   */
  readonly leave = output<void>();

  // Opening with focus on the first action is `FocusScopeDirective`'s doing,
  // pointed there by the `data-focus-first` on the list in the template. It was
  // an `ngAfterViewInit` here until every other dialog in the app turned out to
  // want the same thing, and one of them had been shipped without it.

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;

  constructor() {
    // The sheet's focus scope does this for it; a docked panel has no scope.
    afterNextRender(() => {
      if (this.docked() && !this.host.contains(document.activeElement)) {
        this.host.querySelector<HTMLElement>('[data-focus-first] button')?.focus({ preventScroll: true });
      }
    });

    // On the window, in the capture phase: TvNavigationService listens on the
    // document, and the window hears a key before the document does.
    const onKey = (event: KeyboardEvent) => {
      if (this.docked() && event.key === 'ArrowLeft' && this.host.contains(document.activeElement)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.leave.emit();
      }
    };
    window.addEventListener('keydown', onKey, true);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('keydown', onKey, true));
  }

  choose(action: ItemAction): void {
    this.chosen.emit(action.id);
  }

  /** A click on the backdrop, which is everywhere the panel is not. */
  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closed.emit();
    }
  }

  hideBrokenIcon(event: Event): void {
    (event.target as HTMLElement).style.display = 'none';
  }
}
