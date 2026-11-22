import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Category, Stream, StreamType } from '@shared/types';
import { byCloseness } from '@shared/xtream/searchRanking';
import { SearchFacets, resultsIn, searchFacets } from '@shared/xtream/searchFacets';
import { catchError, firstValueFrom, of } from 'rxjs';
import { LowerCasePipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowDownUp, lucideArrowLeft, lucideBell, lucideCheck, lucideLoaderCircle, lucideSearch, lucideX } from '@ng-icons/lucide';
import { ChoicePanelService } from '../../ui/choice-panel.service';
import { RemindersService } from '../../services/reminders.service';
import { GuideFind } from '../../utils/guide-search.utils';
import { clockTime, guideDateLabel } from '../../utils/channel-display.utils';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { XtreamService } from '../../services/xtream.service';
import { HELD_BACK, TvNavigationService } from '../../services/tv-navigation.service';
import { CardGesturesDirective } from '../../directives/card-gestures.directive';
import { ChannelMonogramPipe, ChannelTitlePipe, PosterTitlePipe, PosterYearPipe } from '../../pipes/format.pipes';
import { AgeLockService } from '../../services/age-lock.service';
import { AgeCoverComponent } from '../age-cover/age-cover.component';
import { ClockService } from '../../services/clock.service';
import { ToastService } from '../../services/toast.service';
import { describeProviderError } from '../../utils/failure-messages.utils';
import { WIDE_LAYOUT_QUERY, wideLayoutNow } from '../../utils/layout.utils';
import { t } from '../../utils/i18n';
import { TPipe } from '../../pipes/t.pipe';
import { ProviderNamePipe } from '../../pipes/provider-name.pipe';
import { oneCardPerTitle } from '../../utils/one-per-title.utils';
import { RecentSearchesService } from '../../services/recent-searches.service';
import { ItemAction, ItemActionsComponent } from '../item-actions/item-actions.component';
import { BackButtonService } from '../../services/back-button.service';
import { DeviceSyncService } from '../../services/device-sync.service';

/** One library's worth of answers to the query. */
interface ResultSection {
  type: StreamType;
  label: string;
  /** Everything found, after the chosen facet. */
  found: Stream[];
  /** The ones drawn in the row. */
  shown: Stream[];
  /** Where "Show all" goes. */
  path: string;
  /**
   * How many equal columns the row is divided into, Show all included, or 0 on
   * a phone -- whose stylesheet lays the row out as a list or a three-column
   * grid instead.
   */
  columns: number;
  /** Whether there are more than the row shows, so Show all is offered. */
  more: boolean;
  /** True when the search hit its own ceiling, so the count is a floor. */
  capped: boolean;
}

/**
 * A card's width, in rem, and the gap between cards: what a row is measured
 * against to decide how many fit.
 *
 * The row is not a fixed count. It was -- five channels and seven posters --
 * and on a 1920 set that left a third of every row empty to the right of the
 * Show all tile, which is the tile the D-pad is meant to reach by carrying on
 * right. The row is measured now, divided into as many equal columns as cards
 * of this width fit, and Show all takes the last of them, so every row ends at
 * the right edge. These are the widths a card would have had; the columns
 * stretch them a little to use up the remainder.
 */
const CARD_REM: Record<StreamType, number> = { live: 14.25, vod: 9, series: 9 };
const GAP_REM = 0.75;

/**
 * The same, on a phone: two channels and a row of three posters.
 *
 * S-1's phone board chose these as "what fits without either section's Show
 * all being pushed out of reach". A phone turned sideways into the wide layout
 * is measured like any other wide screen instead.
 */
const SHOWN_ON_A_PHONE: Record<StreamType, number> = { live: 2, vod: 3, series: 3 };

/** Where the top bar, and the search field in it, shows (SR-D-1): the `md` of the shell. */
export const TOP_BAR_SEARCH_QUERY = '(min-width: 768px)';

/** Which library the page is narrowed to (SR-TV-3), or null for Everything. */
export type SearchScope = StreamType | null;

/** The `in` of the address, which is how a library's Search button narrows the page. */
export function scopeFrom(asked: string | null): SearchScope {
  return asked === 'live' || asked === 'vod' || asked === 'series' ? asked : null;
}

/** How the results are ordered. Best match first, as the board has it. */
export type SearchSort = 'closest' | 'name_asc' | 'name_desc';

/**
 * How deep each library is searched.
 *
 * The catalogue's own default is 100, which is too few to say "of 340" with a
 * straight face. It is still a ceiling rather than a count -- nothing here
 * knows how many a query really matches without counting them -- so a section
 * that comes back full says "300+" instead of pretending to a total it does not
 * have.
 */
const SEARCH_DEPTH = 300;

/**
 * The search results page (S-1).
 *
 * Results used to live on the front page as three rails under the greeting:
 * nothing could be sorted or filtered, nothing said the rails had been cut
 * short at twelve, and there was no way to ask for the rest. A search that
 * reaches the whole library deserves the same page a category gets.
 *
 * Three sections, each one horizontal line of equal-height cards, so Down moves
 * between libraries and Left/Right along one. Channels are the 16:9 logo card
 * and films the 2:3 poster; that difference is the section label doing work,
 * which is why the two are never mixed in one grid. Every section says its own
 * truncation in words and ends with a Show all tile that is the last card in
 * the row -- so a remote reaches it by carrying on right rather than hunting
 * for a control.
 */
@Component({
  selector: 'app-search',
  standalone: true,
  imports: [AgeCoverComponent, TPipe, ProviderNamePipe, ChannelTitlePipe, ChannelMonogramPipe, PosterTitlePipe, PosterYearPipe, NgIcon, HlmButton, HlmInput, RouterLink, CardGesturesDirective, LowerCasePipe, ItemActionsComponent],
  providers: [provideIcons({ lucideArrowDownUp, lucideArrowLeft, lucideBell, lucideCheck, lucideLoaderCircle, lucideSearch, lucideX })],
  templateUrl: './search.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SearchComponent {
  private readonly xtream = inject(XtreamService);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  readonly reminders = inject(RemindersService);
  readonly recent = inject(RecentSearchesService);

  /**
   * Programmes in this device's guides whose titles match (feature 7): on
   * now, then coming. Read from the device alone, so they arrive at once,
   * beside the libraries that are still being looked through.
   */
  readonly inGuide = signal<GuideFind[]>([]);
  private readonly route = inject(ActivatedRoute);
  readonly tv = inject(TvNavigationService);

  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  readonly query = signal('');

  /** The library the page is narrowed to, from the address; null is Everything. */
  readonly scope = signal<SearchScope>(null);
  /** Which library is being looked through, or null when nothing is. */
  readonly working = signal<string | null>(null);

  private readonly live = signal<Stream[]>([]);
  private readonly vod = signal<Stream[]>([]);
  private readonly series = signal<Stream[]>([]);
  private readonly categories = signal<Category[]>([]);

  /** Logos that would not load, drawn as a monogram instead. */
  readonly failedIcons = signal<Set<string>>(new Set());

  private readonly now = inject(ClockService).minute;

  /** The family chip chosen, if a family is what narrows the results. */
  readonly chosenFamily = computed(() => {
    const chosen = this.facetChosen();
    return chosen?.kind === 'family' ? chosen.key : null;
  });

  /** Programmes found in the guide, with when each is and whether a reminder is set. */
  readonly guideRows = computed(() => {
    // Read for the minute's turn: "today" and "on now" move with it.
    this.now();
    return this.inGuide().map(find => ({
      find,
      when: this.whenOf(find),
      reminded: !find.onNow && this.reminders.has(find.stream.stream_id, find.start)
    }));
  });

  /** Each section of results, with how much of it is shown, in both forms. */
  readonly sectionRows = computed(() =>
    this.sections().map(section => ({
      section,
      truncation: section.found.length ? this.truncation(section) : t('cat.positionOf', { position: 0, total: 0 }),
      phoneTruncation: section.found.length ? this.phoneTruncation(section) : t('cat.positionOf', { position: 0, total: 0 })
    }))
  );

  /** Which facet chip is on, or null for All. */
  readonly facetChosen = signal<{ kind: 'family' | 'category'; key: string } | null>(null);

  /**
   * The order, which both S-1 boards put beside the chips "with its current
   * value spelled out". Best match by default: a search is a question, and
   * alphabetical order is the wrong answer to one.
   */
  readonly sort = signal<SearchSort>('closest');

  constructor() {
    // The query lives in the address, so the page can be returned to, linked
    // to, and left with the back button meaning what it looks like it means.
    // `queryParamMap` fires once on subscribe, which is also the first search.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(params => {
      this.scope.set(scopeFrom(params.get('in')));
      const asked = params.get('q') ?? '';
      // A chip changed, or the words were put back as they were: the search
      // that ran for them stands.
      if (asked === this.ran) {
        return;
      }
      this.ran = asked;
      this.query.set(asked);
      void this.run(asked);
    });

    this.arrive();
  }

  /**
   * Focus on the field, as SR-TV-2 and SR-P-2 have it: the one thing anybody
   * arriving here came to do.
   *
   * On a television held back, so the keyboard is one OK away rather than
   * over the page -- Down goes past it to the chips. On a phone with the
   * keyboard up, as every search tab has it. Not on a computer, where the field
   * is the one in the top bar and already has the caret.
   */
  private arrive(): void {
    if (this.tv.isTelevision()) {
      this.parkOnField();
    } else if (!window.matchMedia(TOP_BAR_SEARCH_QUERY).matches && !this.query()) {
      requestAnimationFrame(() => this.field()?.nativeElement.focus({ preventScroll: true }));
    }
  }

  /**
   * The three libraries, one at a time, and each shown the moment it answers.
   *
   * One at a time because the subscription allows a single connection, and a
   * library that has not been indexed on this device yet is fetched whole by
   * the first search that needs it. Asking for all three at once is three
   * whole-library fetches racing each other down one wire -- which on a cold
   * index left the page saying "Searching…" for minutes with nothing to show
   * for it, measured on the emulator.
   *
   * Sequential also means the first library's results are on screen while the
   * others are still working, so `working` names which one rather than a
   * spinner that could mean anything.
   */
  private async run(query: string): Promise<void> {
    const term = query.trim();
    const mine = ++this.latest;

    this.live.set([]);
    this.vod.set([]);
    this.series.set([]);
    this.categories.set([]);
    this.inGuide.set([]);

    if (term.length < 3) {
      this.working.set(null);
      return;
    }

    void this.xtream
      .searchGuide(term)
      .then(found => {
        if (mine === this.latest) {
          this.inGuide.set(found);
        }
      })
      // The libraries are still searched; the guide's part is simply absent.
      .catch((error: unknown) => console.warn('Guide search failed', error));

    // S-1 opens with "focus on the first channel result": once, for the
    // first library that finds anything, and only if nobody has moved since.
    let landing = this.tv.isTelevision();

    const streams = (type: StreamType): Promise<Stream[]> =>
      firstValueFrom(
        this.xtream.searchStreams(term, type, SEARCH_DEPTH).pipe(
          // A library that could not be fetched is not a library with no
          // matches: said, rather than shown as "Nothing matches".
          catchError((error: unknown) => {
            const said = describeProviderError(error, t(type === 'live' ? 'search.channels' : type === 'vod' ? 'search.films' : 'search.shows').toLowerCase());
            this.toasts.error(said.title, said.message, { detail: said.detail });
            return of([] as Stream[]);
          })
        )
      );
    const categoriesOf = (type: StreamType): Promise<Category[]> =>
      firstValueFrom(this.xtream.getCategories(type).pipe(catchError(() => of([] as Category[]))));

    // The library the page is narrowed to first: one at a time, so the one
    // asked about is not left waiting behind the other two.
    const libraries = [
      ['live', this.live, 'channels'],
      ['vod', this.vod, 'films'],
      ['series', this.series, 'shows']
    ] as const;
    const narrowed = untracked(() => this.scope());
    const inOrder = [...libraries].sort((a, b) => Number(b[0] === narrowed) - Number(a[0] === narrowed));
    for (const [type, into, label] of inOrder) {
      this.working.set(t('search.' + label).toLowerCase());
      const found = await streams(type);
      const categories = await categoriesOf(type);

      // A newer query started while this one was waiting; its own pass owns
      // the page now.
      if (mine !== this.latest) {
        return;
      }

      into.set(found);
      if (found.length && landing) {
        landing = false;
        this.landOnFirstResult();
      }
      // One list across the three libraries. Ids are only unique within a
      // library, but a chip filters by the ids it was built from, so a
      // collision would at worst offer one chip covering two libraries'
      // categories of the same name -- which is what somebody asking for
      // "Netflix" meant anyway.
      this.categories.update(known => [...known, ...categories]);
    }

    this.working.set(null);
  }

  /**
   * Focus on the first result, as S-1 draws it, once it is drawn.
   *
   * Not if somebody has gone anywhere meanwhile: only from nothing, or from the
   * query field while it is still held back -- read-only until OK raises the
   * keyboard, so nobody is typing in it. Without this a television arrived on
   * the query, or on nothing when the results were slow, and the QA walk found
   * Down from the field went nowhere while they were loading.
   */
  private landOnFirstResult(tries = 20): void {
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      const field = this.field()?.nativeElement;
      const idle = !active || active === document.body || (active === field && field.readOnly);
      if (!idle) {
        return;
      }
      const first = document.querySelector<HTMLElement>('[data-search-results] [data-search-card]');
      if (first) {
        first.focus({ preventScroll: true });
      } else if (tries > 0) {
        this.landOnFirstResult(tries - 1);
      }
    });
  }

  /**
   * Somewhere to be while the results come: the query, held back.
   *
   * Channels take seconds to answer and films longer, and until then the page
   * had nothing focusable on a television but the field -- so it opened with
   * nothing focused (the QA walk). Read-only, as `TvNavigationService` holds
   * every field the remote lands on, so the keyboard does not rise over a page
   * nobody has asked to type on; OK lets it in.
   */
  private parkOnField(): void {
    requestAnimationFrame(() => {
      const field = this.field()?.nativeElement;
      const active = document.activeElement;
      if (field && (!active || active === document.body)) {
        field.readOnly = true;
        field.setAttribute(HELD_BACK, '');
        field.focus({ preventScroll: true });
      }
    });
  }

  /** The words the last search was run for. */
  private ran: string | null = null;

  /** Counts the passes, so a slow one cannot overwrite a newer one's results. */
  private latest = 0;

  private readonly everything = computed(() => [...this.live(), ...this.vod(), ...this.series()]);

  /** What the chosen library chip leaves: the counts and families below it are of these alone. */
  private readonly inScope = computed(() => {
    const scope = this.scope();
    return scope === 'live' ? this.live() : scope === 'vod' ? this.vod() : scope === 'series' ? this.series() : this.everything();
  });

  readonly facets = computed<SearchFacets>(() =>
    searchFacets(this.inScope(), this.categories())
  );

  readonly total = computed(() => this.inScope().length);

  /** What the heading counts: the libraries' results and the guide's programmes, which are results too. */
  readonly counted = computed(() => this.total() + (this.guideShown() ? this.inGuide().length : 0));

  // --- Filling the row ----------------------------------------------------

  private readonly results = viewChild<ElementRef<HTMLElement>>('results');

  /** The width the rows have to fill, and a rem in pixels, both measured. */
  private readonly rowWidth = signal(0);
  private readonly remPx = signal(16);

  /** Whether this is the wide layout, where rows are filled; a phone lists. */
  private readonly wide = signal(wideLayoutNow());

  private readonly measuresRows = effect(onCleanup => {
    const element = this.results()?.nativeElement;
    if (!element) {
      return;
    }

    // The content box, which is the width the rows actually get once the
    // results' own padding is taken off. The observer reports it on its first
    // call as well as on every change, so there is no separate first reading --
    // `clientWidth` would include the padding and overcount by a column.
    const observer = new ResizeObserver(entries => {
      this.remPx.set(parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
      this.rowWidth.set(entries[0].contentRect.width);
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  private readonly followsLayout = effect(onCleanup => {
    const media = window.matchMedia(WIDE_LAYOUT_QUERY);
    const onChange = () => this.wide.set(wideLayoutNow());
    media.addEventListener('change', onChange);
    onCleanup(() => media.removeEventListener('change', onChange));
  });

  /**
   * How much of a library the row holds, and how it is divided.
   *
   * Wide: as many columns as cards fit, and if there are more results than
   * columns the last one is Show all -- so the row always ends at the right
   * edge. Before the first measurement there is no width to go on, and a row's
   * worth is guessed from a 1920 set rather than drawn empty.
   *
   * A phone: the two channels and three posters the board chose, laid out by
   * the stylesheet; the full-width Show all beneath says the rest.
   */
  private fit(type: StreamType, ranked: Stream[]): Pick<ResultSection, 'shown' | 'columns' | 'more'> {
    if (!this.wide()) {
      const shown = ranked.slice(0, SHOWN_ON_A_PHONE[type]);
      return { shown, columns: 0, more: ranked.length > shown.length };
    }

    const rem = this.remPx();
    const width = this.rowWidth() || 1920;
    const card = CARD_REM[type] * rem;
    const gap = GAP_REM * rem;
    const columns = Math.max(2, Math.floor((width + gap) / (card + gap)));

    const more = ranked.length > columns;
    return { shown: more ? ranked.slice(0, columns - 1) : ranked, columns, more };
  }

  /** The three sections, filtered by the chosen chip and ordered by closeness. */
  readonly ages = inject(AgeLockService);

  /** The age lock's covers on the films and shows drawn (TV-31), looked up only while the lock is on. */
  private readonly lockedPosters = effect(() => {
    const drawn = this.sections().filter(section => section.type !== 'live');
    if (this.ages.engaged()) {
      untracked(() => {
        for (const section of drawn) {
          void this.ages.learnStreams(section.type, section.shown);
        }
      });
    }
  });

  readonly sections = computed<ResultSection[]>(() => {
    const chosen = this.facetChosen();
    const ids = chosen
      ? chosen.kind === 'category'
        ? [chosen.key]
        : (this.facets().families.find(family => family.key === chosen.key)?.categoryIds ?? [])
      : null;

    const order = this.sort();
    const byName = (a: Stream, b: Stream) =>
      (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' });

    const section = (type: StreamType, label: string, path: string, all: Stream[]): ResultSection => {
      const kept = ids ? resultsIn(all, ids) : all;
      const sorted =
        order === 'closest'
          ? byCloseness(kept, this.query())
          : [...kept].sort((a, b) => (order === 'name_asc' ? byName(a, b) : byName(b, a)));
      const ranked = type === 'live' ? sorted : oneCardPerTitle(sorted, stream => stream.name);
      return {
        type,
        label,
        found: ranked,
        ...this.fit(type, ranked),
        path,
        capped: all.length >= SEARCH_DEPTH
      };
    };

    return [
      section('live', t('search.channels'), '/tv', this.live()),
      section('vod', t('search.films'), '/movies', this.vod()),
      section('series', t('search.shows'), '/shows', this.series())
    ];
  });

  /** The sections the chosen chip shows: every library, or the one narrowed to. */
  readonly shownSections = computed(() => {
    const scope = this.scope();
    return this.sectionRows().filter(row => !scope || row.section.type === scope);
  });

  /** The guide's programmes are channels' results: shown with Everything and Live TV. */
  readonly guideShown = computed(() => this.scope() === null || this.scope() === 'live');

  /**
   * Where to look (SR-TV-3): Everything, or one library, each with what it
   * found -- so a search that found nothing here says at once where it did.
   * No counts until there is a search to count.
   */
  readonly scopeChips = computed(() => {
    const counting = this.query().trim().length >= 3;
    const found = (type: StreamType) => this.sections().find(section => section.type === type)?.found.length ?? 0;
    const programmes = this.inGuide().length;
    const chip = (scope: SearchScope, label: string, count: number) => ({
      scope,
      label,
      count: counting ? count : null,
      chosen: this.scope() === scope
    });
    return [
      chip(null, t('search.everything'), found('live') + found('vod') + found('series') + programmes),
      chip('live', t('nav.liveTv'), found('live') + programmes),
      chip('vod', t('nav.movies'), found('vod')),
      chip('series', t('nav.shows'), found('series'))
    ];
  });

  chooseScope(scope: SearchScope): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { in: scope },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  /** A recent search, asked again. */
  searchAgain(term: string): void {
    this.recent.remember(term);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: term },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  /** Enter in the field: the words are what was meant, so they are kept for next time. */
  onQueryEnter(): void {
    this.recent.remember(this.query());
  }

  /**
   * The end of that press. On a television it is the keyboard's "done": focus
   * goes to the first result, which takes the keyboard down with it -- it
   * stayed up over the results it had just found. Not before the key comes
   * up: moved on the way down, the same press came up on the card and opened
   * it.
   */
  onQueryEnterUp(): void {
    if (this.tv.isTelevision()) {
      document.querySelector<HTMLElement>('[data-search-results] [data-search-card]')?.focus({ preventScroll: true });
    }
  }

  /**
   * Escape, on a keyboard: the words first, then the page -- back to wherever
   * it was opened from (SR-D-2). A television's Back is its own matter.
   */
  onQueryEscape(event: Event): void {
    if (this.tv.isTelevision()) {
      return;
    }
    event.preventDefault();
    if (this.query()) {
      this.clear();
    } else {
      this.back();
    }
  }

  readonly nothingFound = computed(
    () => !this.working() && this.query().trim().length >= 3 && this.counted() === 0
  );

  /** A programme found: watched when it is on, a reminder set or taken away when it is still to come. */
  openFind(find: GuideFind): void {
    this.recent.remember(this.query());
    if (find.onNow) {
      this.open('live', find.stream);
      return;
    }
    this.reminders.toggleProgramme(find.stream, find);
  }

  /** "On now, until 21:30", "Today 21:00", "Tomorrow 06:30", "SAT 11 OCT 20:15". */
  private whenOf(find: GuideFind): string {
    if (find.onNow) {
      return t('search.onNowUntil', { time: clockTime(find.stop) });
    }
    const day = (ms: number) => new Date(ms).toDateString();
    const now = Date.now();
    const time = clockTime(find.start);
    if (day(find.start) === day(now)) {
      return t('search.todayAt', { time });
    }
    if (day(find.start) === day(now + 24 * 60 * 60 * 1000)) {
      return t('search.tomorrowAt', { time });
    }
    return `${guideDateLabel(find.start)} ${time}`;
  }

  /** "showing 5 of 137", or "of 300+" when the search stopped counting. */
  private truncation(section: ResultSection): string {
    return t('search.showing', { shown: section.shown.length, total: this.countOf(section) });
  }

  /**
   * The phone's shorter form, "2 of 137", which fits to the right of a heading
   * where the television's longer phrase would not. What it counts is what the
   * phone shows, not what the row holds: the row is drawn with the television's
   * number and the stylesheet hides the rest.
   */
  private phoneTruncation(section: ResultSection): string {
    return t('cat.positionOf', { position: this.phoneShown(section), total: this.countOf(section) });
  }

  phoneShown(section: ResultSection): number {
    return Math.min(section.found.length, SHOWN_ON_A_PHONE[section.type]);
  }

  private readonly panels = inject(ChoicePanelService);

  /** The sorts, as the panel lists them. */
  private readonly sorts = computed(() => [
    { value: 'closest' as SearchSort, label: t('search.best') },
    { value: 'name_asc' as SearchSort, label: t('search.az') },
    { value: 'name_desc' as SearchSort, label: t('search.za') }
  ]);

  /** The sort in use, on its pill. */
  readonly sortLabel = computed(() => this.sorts().find(sort => sort.value === this.sort())?.label ?? '');

  /** The sort, through the panel (DS-TV-4) rather than a dropdown. */
  async chooseSort(): Promise<void> {
    const chosen = await this.panels.choose(t('search.sort'), this.sorts(), this.sort());
    if (chosen) {
      this.sort.set(chosen.value);
    }
  }


  /** How many there are, or a floor with a plus when the search stopped counting. */
  private countOf(section: ResultSection): string {
    return section.capped ? `${section.found.length}+` : String(section.found.length);
  }

  chooseFacet(kind: 'family' | 'category', key: string): void {
    const chosen = this.facetChosen();
    this.facetChosen.set(chosen && chosen.kind === kind && chosen.key === key ? null : { kind, key });
  }

  onQueryInput(event: Event): void {
    const asked = (event.target as HTMLInputElement).value;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: asked },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  clear(): void {
    this.field()?.nativeElement.focus();
    void this.router.navigate([], { relativeTo: this.route, queryParams: { q: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** "Show all": the search was meant, and goes on in the library's own list. */
  showAll(): void {
    this.recent.remember(this.query());
  }

  /** To the page Search was opened from -- it is in the menu, so any -- or For You when there is none. */
  back(): void {
    if (history.length > 1) {
      history.back();
    } else {
      void this.router.navigate(['/for-you']);
    }
  }

  // --- Holding OK on a result ---------------------------------------------------

  private readonly deviceSync = inject(DeviceSyncService);
  readonly menu = signal<{ type: StreamType; stream: Stream; found: Stream[]; starred: boolean } | null>(null);
  /** Back closes the panel before it leaves the page. */
  private readonly menuOnBack = inject(BackButtonService).bindTo(
    computed(() => this.menu() !== null),
    () => this.closeMenu()
  );

  readonly menuActions = computed<ItemAction[]>(() => {
    const target = this.menu();
    if (!target) {
      return [];
    }
    const actions: ItemAction[] = [
      {
        id: 'open',
        icon: 'lucidePlay',
        label: target.type === 'live' ? t('actions.playLive') : target.type === 'vod' ? t('actions.filmPage') : t('actions.openShow')
      },
      { id: 'favourite', icon: 'lucideStar', label: target.starred ? t('actions.unstar') : t('actions.addFavourite') }
    ];
    return actions;
  });

  /** The actions panel for a result, starred or not as the library has it. */
  openMenu(type: StreamType, stream: Stream, found: Stream[]): void {
    this.menu.set({ type, stream, found, starred: false });
    this.xtream.getFavoriteIds(type).subscribe({
      next: ids => {
        const target = this.menu();
        if (target?.stream === stream) {
          this.menu.set({ ...target, starred: ids.map(String).includes(String(stream.stream_id)) });
        }
      },
      error: () => undefined
    });
  }

  closeMenu(): void {
    const target = this.menu();
    this.menu.set(null);
    if (target) {
      const key = `search-${target.type}-${target.stream.stream_id}`;
      setTimeout(() => document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true }));
    }
  }

  onMenu(id: string): void {
    const target = this.menu();
    if (!target) {
      return;
    }
    if (id === 'open') {
      this.menu.set(null);
      this.open(target.type, target.stream, target.found);
      return;
    }
    if (id === 'favourite') {
      const starred = !target.starred;
      this.xtream.setFavorite(target.stream, target.type, starred).subscribe(() => this.deviceSync.syncNow());
      this.closeMenu();
    }
  }

  /**
   * A result opens where it lives: a film its own page (TV-27), a show its
   * page, a channel plays -- in the live layout, its channel keys stepping
   * through the channels this search found (31 October).
   */
  open(type: StreamType, stream: Stream, found: Stream[] = []): void {
    this.recent.remember(this.query());
    if (type === 'vod') {
      void this.router.navigate(['/film', `s${stream.stream_id}`], {
        queryParams: { name: stream.name },
        state: { film: { name: stream.name, poster: stream.stream_icon ?? '' } }
      });
      return;
    }
    if (type === 'series') {
      void this.router.navigate(['/series', stream.stream_id], {
        queryParams: { name: stream.name }
      });
      return;
    }

    const path = type === 'live' ? '/tv' : '/movies';
    void this.router.navigate([path], {
      queryParams: {
        play: String(stream.stream_id),
        kind: 'search',
        name: stream.name,
        icon: stream.stream_icon ?? '',
        return: 1
      },
      state: type === 'live' ? { channels: found.slice(0, 200) } : undefined
    });
  }

  iconFailed(url: string | null | undefined): void {
    if (url) {
      this.failedIcons.update(failed => new Set(failed).add(url));
    }
  }

}
