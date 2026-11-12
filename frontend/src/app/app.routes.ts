import { RecordingsComponent } from './components/recordings/recordings.component';
import { Routes } from '@angular/router';
import { LoginComponent } from './components/login/login.component';
import { GuidesComponent } from './components/guides/guides.component';
import { SectionComponent } from './components/section/section.component';
import { SeriesDetailComponent } from './components/series-detail/series-detail.component';
import { ShellComponent } from './components/shell/shell.component';
import { AccountComponent } from './components/account/account.component';
import { FirstProviderComponent } from './components/first-provider/first-provider.component';
import { ForYouComponent } from './components/for-you/for-you.component';
import { SearchComponent } from './components/search/search.component';
import { PopularComponent } from './components/popular/popular.component';
import { FilmComponent } from './components/film/film.component';
import { FilmCopiesComponent } from './components/film/film-copies.component';
import { FilmCollectionComponent } from './components/film/film-collection.component';
import { authGuard, subscriptionGuard, whoIsWatchingGuard } from './guards/auth.guard';
import { ProfilePickerComponent } from './components/profile-picker/profile-picker.component';
import { OnboardingComponent } from './components/onboarding/onboarding.component';

/**
 * Which library you are looking at is part of the address.
 *
 * The three sections share one component and differ only by the type in their
 * route data, so each is bookmarkable, the back button moves between them, and
 * the navbar can show which one is current without holding any state.
 *
 * Two guards, because being signed in and being able to watch anything are
 * different things: account and subscription pages need only the first, since
 * they are where the second gets fixed.
 */
export const routes: Routes = [
  { path: '', component: LoginComponent, pathMatch: 'full' },
  // The same page reached on purpose from a device used without an account,
  // to start syncing it; '' passes such a device straight through.
  { path: 'sign-in', component: LoginComponent },
  // The first launch on a device with nothing in it yet (OnboardingService).
  { path: 'welcome', component: OnboardingComponent },
  // "Who's watching?" (TV-20): a page of its own, before the shell, because
  // nothing behind it is anybody's yet.
  { path: 'profiles', component: ProfilePickerComponent, canActivate: [authGuard] },
  {
    path: '',
    component: ShellComponent,
    canActivate: [authGuard, whoIsWatchingGuard],
    children: [
      // The home page: what you were doing, across all three libraries.
      { path: 'for-you', component: ForYouComponent, canActivate: [subscriptionGuard] },
      // Popular films or shows, all of the week's list: For You's rows carried
      // on, under For You so the navigation still says where you are.
      { path: 'for-you/popular/:kind', component: PopularComponent, canActivate: [subscriptionGuard] },
      // Top rated and a genre's lists, from Movies and TV Shows (TV-32): the same page.
      { path: 'discover/:kind/:list', component: PopularComponent, canActivate: [subscriptionGuard] },
      // A film's own page (TV-27) -- by its TMDB id, or "s" and a library stream id -- choosing
      // where to play it from (TV-28), and the series it is part of (TV-30).
      { path: 'film/collection/:id', component: FilmCollectionComponent, canActivate: [subscriptionGuard] },
      { path: 'film/:id', component: FilmComponent, canActivate: [subscriptionGuard] },
      { path: 'film/:id/copies', component: FilmCopiesComponent, canActivate: [subscriptionGuard] },
      { path: 'tv', component: SectionComponent, data: { type: 'live' }, canActivate: [subscriptionGuard] },
      { path: 'movies', component: SectionComponent, data: { type: 'vod' }, canActivate: [subscriptionGuard] },
      { path: 'shows', component: SectionComponent, data: { type: 'series' }, canActivate: [subscriptionGuard] },
      { path: 'series/:id', component: SeriesDetailComponent, canActivate: [subscriptionGuard] },
      // The copies of a show, to choose which one its episodes play in (TV-29).
      { path: 'series/:id/copies', component: FilmCopiesComponent, data: { kind: 'show' }, canActivate: [subscriptionGuard] },
      // Search across all three libraries, with the query in the address so a
      // result page can be linked to and returned to (S-1).
      { path: 'search', component: SearchComponent, canActivate: [subscriptionGuard] },
      { path: 'guides', component: GuidesComponent },
      { path: 'recordings', component: RecordingsComponent },
      // Where the one-off guide loader used to be. It fetched a feed, showed
      // it and forgot it; guides are kept now.
      { path: 'external-epg', redirectTo: 'guides' },
      { path: 'account', component: AccountComponent },
      { path: 'subscription', component: FirstProviderComponent }
    ]
  },
  // Where the single browse page used to live.
  { path: 'dashboard', redirectTo: 'for-you' },
  { path: '**', redirectTo: '' }
];
