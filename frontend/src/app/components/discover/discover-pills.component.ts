import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TmdbGenre, TmdbKind } from '@shared/tmdb/client';
import { HlmButton } from '@spartan-ng/helm/button';
import { DiscoverService } from '../../services/discover.service';
import { TPipe } from '../../pipes/t.pipe';
import { lastInput, whenQuiet } from '../../utils/quiet.utils';

/**
 * The TMDB half of the pills at the head of Movies and TV Shows (14
 * November): Top rated, then the genres the library has enough of, each
 * opening that list in full. Drawn into the page's own row of pills, after
 * "All categories"; nothing without a TMDB key.
 */
@Component({
  selector: 'app-discover-pills',
  standalone: true,
  imports: [RouterLink, HlmButton, TPipe],
  host: { class: 'contents' },
  template: `
    @if (genres().length) {
      <a hlmBtn size="sm" class="shrink-0" [routerLink]="link('top')" data-focus-key="discover-chip-top" data-discover-chip data-front-pill>
        {{ 'discover.topRated' | t }}
      </a>
      @for (genre of genres(); track genre.id) {
        <a hlmBtn size="sm" class="shrink-0" [routerLink]="link('genre-' + genre.id)" [attr.data-focus-key]="'discover-chip-' + genre.id" data-discover-chip data-front-pill>
          {{ genre.name }}
        </a>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DiscoverPillsComponent {
  readonly kind = input.required<TmdbKind>();

  private readonly discover = inject(DiscoverService);
  readonly genres = signal<TmdbGenre[]>([]);
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.gone = true));
    effect(() => {
      const kind = this.kind();
      untracked(() => void this.load(kind));
    });
  }

  private async load(kind: TmdbKind): Promise<void> {
    this.genres.set([]);
    if (!(await this.discover.genres(kind)).length || this.gone) {
      return;
    }
    this.genres.set(await this.discover.offered(kind));

    // Which genres the library has enough of: counted in a quiet moment, once a week.
    if (await whenQuiet({ afterStartMs: 30_000, idleMs: 10_000, checkEveryMs: 5_000, now: () => performance.now(), lastInput, stopped: () => this.gone, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) })) {
      const stop = () => this.gone || performance.now() - lastInput() < 5_000;
      if ((await this.discover.countGenres(kind, stop)) && !this.gone && this.kind() === kind) {
        this.genres.set(await this.discover.offered(kind));
      }
    }
  }

  link(list: string): string[] {
    return ['/discover', this.kind(), list];
  }
}
