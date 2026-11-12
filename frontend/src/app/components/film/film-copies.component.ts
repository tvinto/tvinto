import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideLoaderCircle } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { FilmCopy, FilmService } from '../../services/film.service';
import { ShowService } from '../../services/show.service';
import { ToastService } from '../../services/toast.service';
import { TPipe } from '../../pipes/t.pipe';
import { ProviderNamePipe } from '../../pipes/provider-name.pipe';
import { ChannelMonogramPipe } from '../../pipes/format.pipes';
import { preferredLanguages } from '../for-you/popular-cards';
import { t } from '../../utils/i18n';
import { FilmHint } from './film.component';

/** A language's copies, for the list. */
interface LanguageGroup {
  key: string;
  name: string;
  copies: FilmCopy[];
}

/** How many other languages show before the rest fold into one row. */
const OTHER_SHOWN = 2;

/**
 * Choosing where to play a film from (round 6, TV-28): a page of its own,
 * reached from the copy button on the film's page, with room for twenty
 * rows and nothing overlapping the grid.
 *
 * Your languages first, in your order; within a language the best picture.
 * The rarer languages fold into one row, and cinema recordings into one
 * dimmed row at the end that says what they are. OK on a row plays that copy
 * and makes it this film's choice; Back changes nothing.
 */
@Component({
  selector: 'app-film-copies',
  standalone: true,
  imports: [NgTemplateOutlet, TPipe, NgIcon, HlmButton, ProviderNamePipe, ChannelMonogramPipe],
  providers: [provideIcons({ lucideArrowLeft, lucideLoaderCircle })],
  templateUrl: './film-copies.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FilmCopiesComponent {
  private readonly router = inject(Router);
  private readonly films = inject(FilmService);
  private readonly toasts = inject(ToastService);

  /** What the page lists: a film's copies, or a show's (TV-29, one choice per show). */
  readonly page = signal<{ ref: string; title: string; poster: string; copies: FilmCopy[]; tmdbId: number } | null>(null);
  private readonly shows = inject(ShowService);
  private readonly kind: 'film' | 'show' = inject(ActivatedRoute).snapshot.data['kind'] === 'show' ? 'show' : 'film';
  readonly failed = signal(false);
  readonly moreLanguagesOpen = signal(false);
  readonly cinemaOpen = signal(false);
  private readonly ref = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';
  private readonly hint: FilmHint = (history.state as { film?: FilmHint } | null)?.film ?? {};

  private readonly preferred = preferredLanguages();

  /** Copies in the person's languages, cinema recordings left out. */
  readonly yours = computed(() => (this.page()?.copies ?? []).filter(copy => !copy.cinema && this.preferred.includes(copy.language)));

  /** Every other language, a group each, most copies first. */
  private readonly others = computed<LanguageGroup[]>(() => {
    const groups = new Map<string, LanguageGroup>();
    for (const copy of this.page()?.copies ?? []) {
      if (copy.cinema || this.preferred.includes(copy.language)) {
        continue;
      }
      const key = copy.language || 'unknown';
      const group = groups.get(key) ?? { key, name: copy.languageName || t('film.unknownLanguage'), copies: [] };
      group.copies.push(copy);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.copies.length - a.copies.length);
  });

  readonly othersShown = computed(() => (this.moreLanguagesOpen() ? this.others() : this.others().slice(0, OTHER_SHOWN)));
  readonly othersFolded = computed(() => (this.moreLanguagesOpen() ? [] : this.others().slice(OTHER_SHOWN)));
  readonly foldedCount = computed(() => this.othersFolded().reduce((sum, group) => sum + group.copies.length, 0));
  readonly foldedNames = computed(() => this.othersFolded().map(group => group.name).join(', '));

  readonly cinema = computed(() => (this.page()?.copies ?? []).filter(copy => copy.cinema));
  readonly cinemaLanguages = computed(() => [...new Set(this.cinema().map(copy => copy.languageName).filter(Boolean))].join(', '));

  /** "20 copies in 9 languages". */
  readonly countLine = computed(() => {
    const copies = this.page()?.copies ?? [];
    const languages = new Set(copies.map(copy => copy.language || copy.stream.name)).size;
    return [t('film.copyCount', { count: copies.length }), t('film.inLanguages', { count: languages })].join(' ');
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.failed.set(false);
    try {
      if (this.kind === 'show') {
        const show = await this.shows.cached(this.ref);
        if (!show) {
          throw new Error('The show page was not open');
        }
        this.page.set({ ref: show.seriesId, title: show.title, poster: show.poster, copies: show.copies, tmdbId: show.tmdbId });
      } else {
        const film = await this.films.open(this.ref, this.hint);
        this.page.set({ ref: film.ref, title: film.title, poster: film.poster, copies: film.copies, tmdbId: film.id });
      }
    } catch (error) {
      this.failed.set(true);
      this.toasts.error(t('popular.failed'), t('popular.failedBody'), {
        detail: `GET api.themoviedb.org/3/movie/${this.ref} · ${error instanceof Error ? error.message : String(error)}`,
        action: { label: t('popular.tryAgain'), run: () => void this.load() }
      });
    }
  }

  /** A film: plays this copy and makes it the film's choice. A show: opens that copy's page and makes it the show's. */
  choose(copy: FilmCopy): void {
    if (this.kind === 'show') {
      const page = this.page();
      if (page) {
        this.shows.choose(page.tmdbId, copy.stream.stream_id);
      }
      void this.router.navigate(['/series', copy.stream.stream_id], { queryParams: { name: copy.stream.name }, replaceUrl: true });
      return;
    }
    this.films.choose(this.page()?.ref ?? this.ref, copy.stream.stream_id);
    void this.router.navigate(['/movies'], {
      queryParams: { play: String(copy.stream.stream_id), kind: 'stream', name: copy.stream.name, icon: copy.stream.stream_icon ?? '', return: 1 }
    });
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
