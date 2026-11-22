import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal, output, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideChevronLeft,
  lucideChevronRight,
  lucideLoaderCircle,
  lucideSearch,
  lucideTrash2
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { OpenSubtitlesError, SubtitleResult } from '@shared/opensubtitles/client';
import { SubtitleIdentity, titleSuggestions } from '@shared/opensubtitles/identify';
import { MAX_SUBTITLE_OFFSET_MS, SUBTITLE_OFFSET_STEP_MS, SavedSubtitle } from '@shared/subtitles';
import { FocusScopeDirective } from '../../directives/focus-scope.directive';
import { OpenSubtitlesService } from '../../services/opensubtitles.service';
import { PlayerPreferencesService } from '../../services/player-preferences.service';
import { SubtitleIdentityService } from '../../services/subtitle-identity.service';
import { SubtitleItem, SubtitleLibraryService } from '../../services/subtitle-library.service';
import { t } from '../../utils/i18n';
import { LANGUAGE_NAMES } from '../../utils/language-names';
import { LanguageNamePipe, SubtitleOffsetPipe } from '../../pipes/format.pipes';
import { TPipe } from '../../pipes/t.pipe';

/** What the screen is doing, which is also what it is saying (ST-TV-2). */
export type PickerPhase =
  | 'searching'
  | 'results'
  | 'nothing-found'
  | 'not-linked'
  | 'no-allowance'
  | 'downloading'
  | 'added'
  | 'failed';

/** The languages searched at once, so the chips can be counted without searching again. */
const ALWAYS = ['en', 'hr'];
const ALSO = ['sr', 'bs'];


/**
 * Choosing a subtitle for one film or episode: ST-TV-1 on a television, ST-D-2
 * as a dialog on a desktop, ST-P-1 as a sheet on a phone -- one component,
 * because the contents, the order and the wording are the same on all three and
 * a household should learn them once.
 *
 * Searching is free; only choosing a row spends one of the day's downloads, so
 * the allowance is stated next to the thing that spends it and nowhere else.
 */
@Component({
  selector: 'app-subtitle-picker',
  standalone: true,
  imports: [TPipe, LanguageNamePipe, SubtitleOffsetPipe, NgIcon, HlmButton, HlmInput, FocusScopeDirective],
  providers: [
    provideIcons({ lucideArrowLeft, lucideChevronLeft, lucideChevronRight, lucideLoaderCircle, lucideSearch, lucideTrash2 })
  ],
  templateUrl: './subtitle-picker.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SubtitlePickerComponent implements OnInit {
  /** The film or episode subtitles are being added to. */
  readonly item = input.required<SubtitleItem>();
  /** What to call it on screen. */
  readonly name = input.required<string>();
  readonly poster = input<string | null>(null);
  /** For an episode: what the show page already fetched, so nothing is asked twice. */
  readonly seriesInfo = input<unknown>(null);

  /**
   * Opened over a film that is playing (the player's "Find subtitles…"):
   * what is chosen shows at once, and the words say so.
   */
  readonly playing = input(false);

  readonly closed = output<void>();
  /** A subtitle saved, or its timing changed: for a player that is showing it now. */
  readonly added = output<SavedSubtitle>();

  private readonly identityService = inject(SubtitleIdentityService);
  private readonly library = inject(SubtitleLibraryService);
  private readonly preferences = inject(PlayerPreferencesService);
  readonly subtitles = inject(OpenSubtitlesService);

  readonly phase = signal<PickerPhase>('searching');
  readonly identity = signal<SubtitleIdentity | null>(null);
  readonly results = signal<SubtitleResult[]>([]);
  readonly saved = signal<SavedSubtitle[]>([]);
  readonly language = signal<string>('');
  readonly searchText = signal('');
  readonly message = signal('');
  /** The row being downloaded, so only it shows a spinner. */
  readonly working = signal<number | null>(null);
  readonly justAdded = signal<SavedSubtitle | null>(null);
  /** The subtitle whose timing is being changed, so its buttons wait. */
  readonly nudging = signal<string | null>(null);

  /** What was actually searched for, which is what "nothing found" is about. */
  private searched = '';

  readonly languages = computed(() => {
    const preferred = this.preferences.preferences().subtitleLanguage;
    return [...new Set([preferred, ...ALWAYS, ...ALSO].filter(Boolean))].slice(0, 5);
  });

  /** A chip per language present in the results, with its count, plus All. */
  readonly chips = computed(() => {
    const counts = new Map<string, number>();
    for (const result of this.results()) {
      counts.set(result.language, (counts.get(result.language) ?? 0) + 1);
    }
    const preferred = this.languages();
    const ordered = [...counts.entries()].sort(
      ([a, countA], [b, countB]) => preferred.indexOf(a) - preferred.indexOf(b) || countB - countA
    );
    return [
      ...ordered.map(([code, count]) => ({ code, name: LANGUAGE_NAMES[code] ?? code.toUpperCase(), count })),
      { code: '', name: t('common.all'), count: this.results().length }
    ];
  });

  /** The rows on screen: the chosen language, most downloaded first. */
  readonly shown = computed(() => {
    const language = this.language();
    return this.results()
      .filter(result => !language || result.language === language)
      .sort((a, b) => b.downloads - a.downloads);
  });

  /** Two things worth trying when a search by name found nothing (ST-TV-2). */
  readonly suggestions = computed(() => {
    const identity = this.identity();
    return identity ? titleSuggestions(identity, this.searched) : [];
  });

  readonly matchedByTitle = computed(() => this.identity()?.matchedBy === 'title');

  /** The title as a person would say it: the provider's tags and year taken off. */
  readonly heading = computed(() => {
    const identity = this.identity();
    if (!identity) {
      return this.name();
    }
    return identity.year ? `${identity.title} (${identity.year})` : identity.title;
  });

  /** One press of Earlier or Later, as ST-TV-3 draws it. */
  readonly step = SUBTITLE_OFFSET_STEP_MS;

  /**
   * Moves a saved subtitle earlier or later.
   *
   * Saved on the account, so the television plays it as nudged on the phone.
   * The cue times themselves are shifted when a player is handed the file --
   * Media3 has no subtitle delay to ask for.
   */
  async nudge(saved: SavedSubtitle, byMs: number): Promise<void> {
    const wanted = Math.max(-MAX_SUBTITLE_OFFSET_MS, Math.min(MAX_SUBTITLE_OFFSET_MS, saved.offsetMs + byMs));
    if (wanted === saved.offsetMs || this.nudging()) {
      return;
    }

    this.nudging.set(saved.id);
    try {
      const updated = await this.library.setOffset(saved.id, wanted);
      this.saved.update(all => all.map(one => (one.id === updated.id ? updated : one)));
      if (this.justAdded()?.id === updated.id) {
        this.justAdded.set(updated);
      }
      this.added.emit(updated);
    } catch (error) {
      this.message.set(this.subtitles.describe(error));
    } finally {
      this.nudging.set(null);
    }
  }

  ngOnInit(): void {
    void this.start();
  }

  async start(): Promise<void> {
    this.phase.set('searching');
    this.message.set('');
    await this.subtitles.load();

    if (this.subtitles.state() !== 'linked') {
      this.phase.set('not-linked');
      return;
    }

    const identity =
      this.item().type === 'series'
        ? await this.identityService.episode(
            this.item().seriesId ?? this.item().itemId,
            this.name(),
            { season: this.item().season ?? 0, episode: this.item().episodeNum ?? 0 },
            this.seriesInfo()
          )
        : await this.identityService.film(this.item().itemId, this.name());

    this.identity.set(identity);
    // The allowance belongs beside the thing that spends it, so it is fetched
    // when the picker opens rather than only on the Account page.
    if (!this.subtitles.allowance()) {
      void this.subtitles.refreshAllowance();
    }
    this.searchText.set(identity.title);
    void this.loadSaved();
    await this.runSearch();
  }

  /** Searches again for what the person typed. */
  async searchAgain(text?: string): Promise<void> {
    const wanted = (text ?? this.searchText()).trim();
    if (!wanted) {
      return;
    }
    this.searchText.set(wanted);
    await this.runSearch(wanted);
  }

  private async runSearch(query?: string): Promise<void> {
    const identity = this.identity();
    if (!identity) {
      return;
    }

    this.phase.set('searching');
    this.searched = query ?? (identity.matchedBy === 'title' ? identity.title : '');

    try {
      const found = await this.library.search(identity, this.languages(), { query });
      this.results.set(found.results);
      this.language.set(this.firstLanguage(found.results));
      this.phase.set(found.results.length ? 'results' : 'nothing-found');
    } catch (error) {
      this.fail(error);
    }
  }

  /** The language chip to start on: the account's, if anything came back in it. */
  private firstLanguage(results: SubtitleResult[]): string {
    const preferred = this.preferences.preferences().subtitleLanguage;
    if (preferred && results.some(result => result.language === preferred)) {
      return preferred;
    }
    return results[0]?.language ?? '';
  }

  private async loadSaved(): Promise<void> {
    try {
      this.saved.set(await this.library.saved(this.item().type, String(this.item().itemId)));
    } catch {
      // The list of what is already added is a courtesy, not the point.
    }
  }

  /** Spends a download and keeps the file on the account. */
  async choose(result: SubtitleResult): Promise<void> {
    const identity = this.identity();
    if (!identity || this.working() !== null) {
      return;
    }

    this.working.set(result.fileId);
    this.phase.set('downloading');
    this.message.set('');

    try {
      const saved = await this.library.add(identity, { ...this.item(), name: this.item().name ?? this.name() }, result);
      this.justAdded.set(saved);
      this.phase.set('added');
      this.added.emit(saved);
      void this.loadSaved();
    } catch (error) {
      this.fail(error);
    } finally {
      this.working.set(null);
    }
  }

  async remove(saved: SavedSubtitle): Promise<void> {
    try {
      await this.library.remove(saved.id);
      this.saved.update(all => all.filter(one => one.id !== saved.id));
      if (this.justAdded()?.id === saved.id) {
        this.justAdded.set(null);
      }
    } catch (error) {
      this.message.set(this.subtitles.describe(error));
    }
  }

  /**
   * "Try again" after a failure.
   *
   * Searches again rather than merely putting the list back: what failed was
   * usually the search itself -- OpenSubtitles asking us to slow down, or a
   * moment without a network -- and showing an empty list would be answering
   * a question nobody asked.
   */
  async retry(): Promise<void> {
    this.message.set('');
    if (this.results().length) {
      this.backToResults();
      return;
    }
    await (this.identity() ? this.runSearch() : this.start());
  }

  /** Back to the list, after adding one or after a failure. */
  backToResults(): void {
    this.phase.set(this.results().length ? 'results' : 'nothing-found');
    this.message.set('');
  }

  close(): void {
    this.closed.emit();
  }

  onSearchInput(event: Event): void {
    this.searchText.set((event.target as HTMLInputElement).value);
  }

  private fail(error: unknown): void {
    this.message.set(this.subtitles.describe(error));

    if (error instanceof OpenSubtitlesError) {
      if (error.problem === 'allowance-used') {
        this.phase.set('no-allowance');
        return;
      }
      if (error.problem === 'signed-out' || error.problem === 'bad-login' || error.problem === 'no-key') {
        this.phase.set('not-linked');
        return;
      }
    }
    this.phase.set('failed');
  }
}
