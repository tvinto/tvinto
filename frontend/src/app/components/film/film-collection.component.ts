import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideLoaderCircle } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { CollectionPage, FilmLink, FilmService } from '../../services/film.service';
import { ToastService } from '../../services/toast.service';
import { TPipe } from '../../pipes/t.pipe';
import { ChannelMonogramPipe } from '../../pipes/format.pipes';
import { t } from '../../utils/i18n';
import { TMDB_LOGO } from '../description-settings/description-settings.component';
import { filmFromList } from './film.component';

/**
 * A film series in order (round 6, TV-30, D-20, P-18), reached from the
 * "Part of" tile on a film's page.
 *
 * One straight row in series order, each poster headed by its number and
 * year. The films the library lacks are shown, not hidden -- a dashed
 * outline with the title and "Not in your library" -- so a gap in the series
 * is seen before someone watches 4 straight after 3. They take no focus:
 * there is nothing to do with them on a remote.
 */
@Component({
  selector: 'app-film-collection',
  standalone: true,
  imports: [TPipe, NgIcon, HlmButton, ChannelMonogramPipe],
  providers: [provideIcons({ lucideArrowLeft, lucideLoaderCircle })],
  templateUrl: './film-collection.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FilmCollectionComponent {
  private readonly router = inject(Router);
  private readonly films = inject(FilmService);
  private readonly toasts = inject(ToastService);
  private readonly id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));

  readonly logo = TMDB_LOGO;
  readonly collection = signal<CollectionPage | null>(null);
  readonly failed = signal(false);

  /** "7 films · 5 in your library". */
  readonly summary = computed(() => {
    const collection = this.collection();
    return collection
      ? [t('film.filmCount', { count: collection.parts.length }), t('film.inLibrary', { count: collection.parts.filter(part => part.copies > 0).length })].join(' · ')
      : '';
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.failed.set(false);
    try {
      const collection = await this.films.collection(this.id);
      if (!collection) {
        throw new Error(`TMDB has no collection ${this.id}`);
      }
      this.collection.set(collection);
    } catch (error) {
      this.failed.set(true);
      this.toasts.error(t('popular.failed'), t('popular.failedBody'), {
        detail: `GET api.themoviedb.org/3/collection/${this.id} · ${error instanceof Error ? error.message : String(error)}`,
        action: { label: t('popular.tryAgain'), run: () => void this.load() }
      });
    }
  }

  open(link: FilmLink): void {
    filmFromList(this.router, link);
  }

  back(): void {
    history.back();
  }

  readonly failedIcons = signal<ReadonlySet<string>>(new Set());

  iconFailed(url: string | null | undefined): void {
    if (url) {
      this.failedIcons.update(failed => new Set(failed).add(url));
    }
  }
}
