import { ActivityComponent } from '../activity/activity.component';
import { UpdateBarsComponent } from '../update-bars/update-bars.component';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs/operators';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideClapperboard,
  lucideMoon,
  lucideSearch,
  lucideSun,
  lucideTv,
  lucideVideo
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { StreamType } from '@shared/types';
import { RecentSearchesService } from '../../services/recent-searches.service';
import { isEditing } from '../../utils/typing.utils';
import { TOP_BAR_SEARCH_QUERY } from '../search/search.component';
import { ThemeService } from '../../services/theme.service';
import { AccountService } from '../../services/account.service';
import { GuideSourcesService } from '../../services/guide-sources.service';
import { GuideReloadService } from '../../services/guide-reload.service';
import { WebUpdateService } from '../../services/web-update.service';

import { DESTINATIONS, SECTIONS } from '../../utils/navigation.utils';
import { DrawerService } from '../../services/drawer.service';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { BackButtonService } from '../../services/back-button.service';
import { TPipe } from '../../pipes/t.pipe';
import { FamilyService } from '../../services/family.service';
import { RemindersService } from '../../services/reminders.service';
import { DeepLinksService } from '../../services/deep-links.service';
import { HomeScreenService } from '../../services/home-screen.service';
import { FamilyProfilesService } from '../../services/family-profiles.service';
import { profileFace } from '../../utils/profile-face.utils';
import { ChoicePanelService } from '../../ui/choice-panel.service';
import { NgTemplateOutlet } from '@angular/common';
import { ToastService } from '../../services/toast.service';
import { t } from '../../utils/i18n';
import { TvintoMarkComponent } from '../../ui/tvinto-mark.component';

/**
 * The frame every signed-in page sits in.
 *
 * The navbar is the app's top-level navigation: which of the three libraries
 * you are in is a matter of where you are, not of a dropdown's value, so it
 * lives in the URL and every section is linkable and back-button friendly.
 */
@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [TPipe, RouterOutlet, RouterLink, RouterLinkActive, NgIcon, HlmButton, HlmInput, NgTemplateOutlet, TvintoMarkComponent, ActivityComponent, UpdateBarsComponent],
  providers: [
    provideIcons({
      lucideClapperboard,
      lucideMoon,
      lucideSearch,
      lucideSun,
      lucideTv,
      lucideVideo
    })
  ],
  templateUrl: './shell.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ShellComponent {
  readonly theme = inject(ThemeService);
  readonly accounts = inject(AccountService);
  readonly faceOf = profileFace;
  /**
   * Injected, though the shell draws nothing from it any more.
   *
   * The service is what notices that a guide this account uses is missing from
   * this device, and it starts when something asks for it. The shell is the one
   * thing always on screen, so it is what keeps it running for the Guides page
   * to find its answer ready.
   */
  readonly guideSources = inject(GuideSourcesService);

  constructor() {
    // Here because the shell exists exactly while somebody is signed in, which
    // is when there are guides to keep from running out.
    inject(GuideReloadService).start();

    // The family's background work: this device saying it is in use, for
    // "Who's watching?"; and, a little after start so it does not compete
    // with the first screen, keys made and handed up, and members kept in
    // step with this account's subscription and guides.
    this.profiles.start();
    // Reminders from the guide go off wherever somebody is in the app.
    inject(RemindersService).start();
    // Links from outside the app -- a reminder's notification, the
    // television's home screen -- once there is somebody signed in to open.
    inject(DeepLinksService).start();
    // The television's home screen: favourite channels, and "Play next".
    inject(HomeScreenService).start();
    setTimeout(() => void this.family.start(), 4000);

    // Back closes the navigation on every screen, not only the three that have
    // categories: elsewhere it went past the open panel to the screen before,
    // and the panel was left over whatever that was.
    inject(BackButtonService).bindTo(
      computed(() => this.drawer.level() === 'navigation'),
      () => this.drawer.shallower()
    );

    document.addEventListener('keydown', this.onSearchKey);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', this.onSearchKey));
  }

  readonly profiles = inject(FamilyProfilesService);
  private readonly panel = inject(ChoicePanelService);
  private readonly toasts = inject(ToastService);

  /** Somebody else in the household to switch to. */
  readonly hasProfiles = computed(() => {
    this.accounts.account();
    return this.profiles.choices().length > 1;
  });

  /** The chip with a household: whoever else is here, and Account. */
  async openProfiles(): Promise<void> {
    const choices = this.profiles.choices();
    const picked = await this.panel.choose<string>(
      t('profiles.title'),
      [
        ...choices.map(choice => ({
          value: `profile:${choice.username}`,
          label: choice.username,
          face: profileFace(choice.username, choice.picture)
        })),
        { value: 'account', label: t('nav.account'), face: 'settings' as const }
      ],
      `profile:${choices.find(choice => choice.active)?.username ?? ''}`
    );
    if (!picked) {
      return;
    }
    if (picked.value === 'account') {
      void this.router.navigate(['/account']);
      return;
    }
    const choice = choices.find(one => `profile:${one.username}` === picked.value);
    if (choice && !choice.active) {
      try {
        await this.profiles.switchTo(choice);
      } catch (error) {
        this.toasts.error(t('profiles.failed'), error instanceof Error && error.message === 'not-ready'
          ? t('profiles.notReady', { name: choice.username })
          : this.accounts.describeError(error));
      }
    }
  }
  private readonly family = inject(FamilyService);

  /** This app's own code updating over the air, and restarting into it. */
  readonly webUpdate = inject(WebUpdateService);

  readonly sections = SECTIONS;
  readonly destinations = DESTINATIONS;

  readonly drawer = inject(DrawerService);
  readonly tv = inject(TvNavigationService);

  /**
   * Left, anywhere the page underneath did not want it.
   *
   * The same rule the browse screen uses, for the same reason:
   * `TvNavigationService` calls `preventDefault` when it moves focus, so a
   * press arriving here unprevented is one that found nothing further left. On
   * the browse screen that is the edge of a guide row; on Guides or Account it
   * is the edge of the page. Either way it is the press that means "out of
   * here", and with no bar along the top the navigation is what out means.
   */
  onShellKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || !this.tv.isTelevision() || event.key !== 'ArrowLeft') {
      return;
    }
    // Left while typing moves the caret: it is what the on-screen keyboard's
    // "<" sends. Read as "out of here", it opened the menu behind the keyboard
    // on Search, and the two fought over every press until the television was
    // unplugged (29 October). A field held back from the keyboard
    // is read-only and is not being typed in: Left from it still opens.
    if (isEditing(event.target)) {
      return;
    }

    // The browse screen answers Left from its guide itself, and a press it
    // answered arrives here prevented. One that was not came from somewhere
    // else on that screen -- the channel Sort and Arrange above the guide --
    // and opens the same next level, whichever it is: the categories, whose
    // focus the browse screen places, or the navigation, whose focus is here.
    if (this.drawer.deeper()) {
      event.preventDefault();
      if (this.drawer.level() === 'navigation') {
        requestAnimationFrame(() => this.focusCurrentSection());
      }
    }
  }

  /** Right or Back inside the panel: one level back, never two. */
  onPanelKey(event: KeyboardEvent): void {
    if (event.defaultPrevented) {
      return;
    }

    if (event.key === 'ArrowRight' || event.key === 'Escape' || event.key === 'Backspace') {
      event.preventDefault();
      this.drawer.shallower();
    }
  }

  private focusCurrentSection(): void {
    const panel = document.querySelector('[data-tv-nav-panel]');
    const here = panel?.querySelector<HTMLElement>('[data-tv-nav-here]');
    (here ?? panel?.querySelector<HTMLElement>('[data-tv-nav-item]'))?.focus({
      preventScroll: true
    });
  }

  /**
   * The bottom tabs on a phone: the libraries and Search (SR-P-1).
   *
   * Search took Guides' place. Guides is set up once and seldom visited, and
   * it is a row on Account now; Search is the tab a thumb looks for.
   */
  readonly tabs = [
    { path: '/for-you', label: 'nav.forYou', dot: 'bg-primary-bright' },
    { path: '/tv', label: 'nav.liveTv', dot: 'bg-live' },
    { path: '/movies', label: 'nav.movies', dot: 'bg-vod' },
    { path: '/shows', label: 'nav.showsShort', dot: 'bg-series' },
    { path: '/search', label: 'nav.search', dot: 'bg-primary-bright' }
  ];

  // --- Search, from anywhere (round 11) -------------------------------------

  readonly recent = inject(RecentSearchesService);
  private readonly topSearch = viewChild<ElementRef<HTMLInputElement>>('topSearch');

  private readonly onSearchPage = computed(() => this.url().split(/[?#]/)[0].startsWith('/search'));

  /** What the top bar's field shows: the search page's words, while it is open. */
  readonly topQuery = computed(() => (this.onSearchPage() ? (this.router.parseUrl(this.url()).queryParams['q'] ?? '') : ''));

  /**
   * Typing in the top bar (SR-D-2). The first key opens the search page,
   * narrowed to the library it was typed on, as a page of its own -- so Back
   * returns to that library; every key after it changes the words in place.
   */
  onTopSearchInput(event: Event): void {
    const q = (event.target as HTMLInputElement).value;
    if (this.onSearchPage()) {
      void this.router.navigate(['/search'], { queryParams: { q }, queryParamsHandling: 'merge', replaceUrl: true });
      return;
    }
    void this.router.navigate(['/search'], { queryParams: { q, in: LIBRARY_OF_SECTION[this.here()] ?? null } });
  }

  /** Escape: the words first, then the page, back to wherever it was started on. */
  onTopSearchEscape(event: Event): void {
    event.preventDefault();
    if (!this.onSearchPage()) {
      this.topSearch()?.nativeElement.blur();
    } else if (this.topQuery()) {
      void this.router.navigate(['/search'], { queryParams: { q: null }, queryParamsHandling: 'merge', replaceUrl: true });
    } else {
      this.topSearch()?.nativeElement.blur();
      history.back();
    }
  }

  /**
   * Search from wherever somebody is: Ctrl K or / on a keyboard, the remote's
   * own search key (SR-TV-1) -- which `MainActivity` hands the page as
   * "BrowserSearch", as a PC keyboard's search key already arrives.
   */
  private readonly onSearchKey = (event: KeyboardEvent): void => {
    const typing = isTypingIn(event.target);
    const asked =
      event.key === 'BrowserSearch' ||
      (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) ||
      (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey);
    if (!asked || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    this.openSearch();
  };

  /** The top bar's field where there is one; elsewhere the search page, with its field in focus. */
  private openSearch(): void {
    const field = this.topSearch()?.nativeElement;
    if (!this.tv.isTelevision() && field && window.matchMedia(TOP_BAR_SEARCH_QUERY).matches) {
      field.focus();
      field.select();
      return;
    }
    this.drawer.shut();
    const onPage = document.querySelector<HTMLInputElement>('[data-search-field] input');
    if (this.onSearchPage() && onPage) {
      if (this.tv.isTelevision()) {
        this.tv.focusAsIfMoved(onPage);
      } else {
        onPage.focus();
      }
      return;
    }
    void this.router.navigate(['/search']);
  }

  private readonly router = inject(Router);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map(event => event.urlAfterRedirects)
    ),
    { initialValue: this.router.url }
  );

  /** What the phone's top bar says: the page you are on. */
  readonly pageTitle = computed(() => titleFor(this.url()));

  /**
   * Which section the page belongs to, for the tab lit up: a film's page,
   * a show's, Top rated and the genres light Movies or TV Shows, where the
   * address alone lit nothing (19 October).
   */
  private readonly here = computed(() => SECTION_OF_TITLE[this.pageTitle()] ?? '');

  isHere(path: string): boolean {
    return this.here() === path;
  }

  toggleTheme(): void {
    this.theme.toggle();
  }
}

/** The library a section's search starts narrowed to; the others start on Everything. */
const LIBRARY_OF_SECTION: Record<string, StreamType> = {
  '/tv': 'live',
  '/movies': 'vod',
  '/shows': 'series'
};

/** Whether a key press is somebody typing, which / must not interrupt. */
function isTypingIn(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
}

/** The section each page title belongs to, by the path of its tab. */
const SECTION_OF_TITLE: Record<string, string> = {
  'nav.forYou': '/for-you',
  'nav.liveTv': '/tv',
  'nav.movies': '/movies',
  'nav.shows': '/shows',
  'nav.guides': '/guides',
  'nav.account': '/account',
  'nav.search': '/search'
};

/** The key for the page's title, which the template puts in the language in use. */
function titleFor(url: string): string {
  const path = url.split(/[?#]/)[0];
  if (path.startsWith('/for-you')) return 'nav.forYou';
  if (path.startsWith('/movies') || path.startsWith('/film') || path.startsWith('/discover/movie')) return 'nav.movies';
  if (path.startsWith('/shows') || path.startsWith('/series') || path.startsWith('/discover/tv')) return 'nav.shows';
  if (path.startsWith('/guides')) return 'nav.guides';
  // The first provider's page is what somebody new sees first, with no
  // account at all: "Account" over "Add your provider" said the opposite.
  if (path.startsWith('/subscription')) return 'account.sections.providers';
  if (path.startsWith('/account')) return 'nav.account';
  // Before the fall-through, which is Live TV: the search page arrived after
  // this list was written and said "Live TV" at the top of a phone, and on the
  // television's rail, for results from all three libraries.
  if (path.startsWith('/search')) return 'nav.search';
  return 'nav.liveTv';
}
