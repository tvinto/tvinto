import { ChangeDetectionStrategy, Component, DestroyRef, Directive, ElementRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FilmService } from '../../services/film.service';
import { ShowService } from '../../services/show.service';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { TPipe } from '../../pipes/t.pipe';
import { runtimeLabel } from '../film/film.component';
import { t } from '../../utils/i18n';

/**
 * What a card says about itself for the spotlight, read from its attributes:
 * `data-spot-kind` ("vod", "series", or anything else for a card TMDB knows
 * by another name), `data-spot-id`, `data-spot-name`, `data-spot-poster` and
 * an optional `data-spot-line` -- the words to show before any are found.
 */
export interface SpotTarget {
  kind: string;
  id: string;
  name: string;
  poster: string;
  line: string;
}

/** How long focus rests on a card before the top follows it: holding Right loads no backdrop per poster. */
const SPOT_SETTLE_MS = 350;

/**
 * Put on a page that scrolls (For You, a library's front page): on a
 * television, the card focus rests on -- one carrying `data-spot-name` -- is
 * the spotlight's target (NX-TV-2, NX-TV-7). Focus anywhere else clears it,
 * so the billboard and the page's own top come back.
 */
@Directive({
  selector: '[appSpotlightHost]',
  standalone: true,
  exportAs: 'spotlightHost',
  host: { '[attr.data-spot-on]': 'target() ? "" : null' }
})
export class SpotlightHostDirective {
  readonly target = signal<SpotTarget | null>(null);
  /**
   * Keep the last card's title when focus moves to something that is not a
   * card -- for a page whose top is always the spotlight (a library's front
   * page), where clearing it would leave the band empty.
   */
  readonly spotlightKeep = input(false);

  constructor() {
    const host: HTMLElement = inject(ElementRef).nativeElement;
    const tv = inject(TvNavigationService);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFocus = (event: FocusEvent) => {
      if (!tv.isTelevision()) {
        return;
      }
      const card = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-spot-name]');
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!card) {
        if (!this.spotlightKeep()) {
          this.target.set(null);
        }
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        const read = (name: string) => card.getAttribute(`data-spot-${name}`) ?? '';
        const first = !this.target();
        this.target.set({ kind: read('kind'), id: read('id'), name: read('name'), poster: read('poster'), line: read('line') });
        // The page scrolled to the card before the spotlight came, so the card
        // can be under it now; once the spotlight's room is kept, again.
        if (first) {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (card.contains(document.activeElement)) {
                card.scrollIntoView({ block: 'nearest' });
              }
            })
          );
        }
      }, SPOT_SETTLE_MS);
    };
    host.addEventListener('focusin', onFocus);
    inject(DestroyRef).onDestroy(() => {
      host.removeEventListener('focusin', onFocus);
      if (timer) {
        clearTimeout(timer);
      }
    });
  }
}

interface SpotDetails {
  key: string;
  backdrop: string;
  overview: string;
  meta: string;
  rating: string;
  vote: number | null;
}

/**
 * The top of the screen while focus is in the rows (NX-TV-2, NX-TV-7): the
 * focused title's backdrop, its name, one line of details and two lines about
 * it. Held at the top of the page while the rows scroll under it; the page
 * keeps the focused row clear of it with `scroll-padding-top` (styles.css,
 * `[data-spot-on]`). Its details are TMDB's, found by name -- the provider
 * is asked nothing.
 */
@Component({
  selector: 'app-spotlight',
  standalone: true,
  imports: [TPipe],
  template: `
    @if (target(); as spot) {
      <div class="nx-spotlight" data-spotlight aria-hidden="true">
        <div class="nx-hero">
          @if (shown()?.backdrop; as backdrop) {
            <img [src]="backdrop" alt="" />
          } @else if (spot.poster) {
            <img [src]="spot.poster" alt="" data-nx-hero-blur />
          }
        </div>
        <div class="relative flex max-w-[60rem] flex-col gap-3" data-spotlight-words>
          <span class="nx-title" data-spotlight-title>{{ spot.name }}</span>
          @if (shown(); as details) {
            @if (details.meta || details.rating || details.vote !== null) {
              <div class="nx-meta text-base">
                @if (details.meta) {
                  <span>{{ details.meta }}</span>
                }
                @if (details.rating) {
                  <span class="nx-age">{{ details.rating }}+</span>
                }
                @if (details.vote !== null) {
                  <span class="nx-score">{{ 'film.tmdbScore' | t: { score: details.vote } }}</span>
                }
              </div>
            }
            @if (details.overview) {
              <p class="line-clamp-2 max-w-[48rem] text-base leading-relaxed">{{ details.overview }}</p>
            }
          } @else if (spot.line) {
            <span class="nx-meta text-base">{{ spot.line }}</span>
          }
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SpotlightComponent {
  readonly focused = input<SpotTarget | null>(null, { alias: 'target' });
  /** What the band shows before focus has rested on any card: a page's first title. */
  readonly fallback = input<SpotTarget | null>(null);
  private readonly tv = inject(TvNavigationService);
  /** A television's only: elsewhere there is no focus for it to follow. */
  readonly target = computed(() => (this.tv.isTelevision() ? (this.focused() ?? this.fallback()) : null));
  private readonly films = inject(FilmService);
  private readonly shows = inject(ShowService);
  private readonly details = signal<SpotDetails | null>(null);

  readonly shown = computed(() => {
    const spot = this.target();
    const details = this.details();
    return spot && details?.key === spot.kind + spot.id ? details : null;
  });

  private readonly find = effect(() => {
    const spot = this.target();
    if (!spot) {
      return;
    }
    const key = spot.kind + spot.id;
    untracked(() => {
      const done = (found: Omit<SpotDetails, 'key'> | null) => {
        if (found && this.target()?.kind + (this.target()?.id ?? '') === key) {
          this.details.set({ key, ...found });
        }
      };
      if (spot.kind === 'vod') {
        void this.films
          .feature(spot.id, spot.name)
          .then(film =>
            done(
              film && {
                backdrop: film.backdrop,
                overview: film.overview,
                meta: [film.year, runtimeLabel(film.runtime), film.genres.slice(0, 2).join(', ')].filter(Boolean).join(' · '),
                rating: film.rating,
                vote: film.vote
              }
            )
          )
          .catch(() => undefined);
      } else if (spot.kind === 'series') {
        void this.shows
          .feature(spot.id, spot.name)
          .then(show =>
            done(
              show && {
                backdrop: show.backdrop,
                overview: show.overview,
                meta: [show.year, show.genres.slice(0, 2).join(', '), show.seasons ? t('show.seasons', { count: show.seasons }) : ''].filter(Boolean).join(' · '),
                rating: show.rating,
                vote: show.vote
              }
            )
          )
          .catch(() => undefined);
      }
    });
  });
}
