import { DesktopPlayerComponent } from './components/desktop-player/desktop-player.component';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs/operators';
import { TvNavigationService } from './services/tv-navigation.service';
import { BackButtonService } from './services/back-button.service';
import { PlaceMemoryService } from './services/place-memory.service';
import { ToolRequestsService } from './services/tool-requests.service';
import { LocalToolService } from './services/local-tool.service';
import { lastInput, whenQuiet } from './utils/quiet.utils';
import { keepLibrariesFresh } from './utils/library-refresh.utils';
import { GuideService } from './services/guide.service';
import { RecordingsService } from './services/recordings.service';
import { ProviderAccessService } from './services/provider-access.service';
import { DisplaySizeService } from './services/display-size.service';
import { LanguageService } from './services/language.service';
import { LanguagesService } from './services/languages.service';
import { DeviceSyncService } from './services/device-sync.service';
import { WebUpdateService } from './services/web-update.service';
import { ToastsComponent } from './components/toasts/toasts.component';
import { PinDialogComponent } from './components/pin-dialog/pin-dialog.component';
import { TrailerDialogComponent } from './components/trailer-dialog/trailer-dialog.component';
import { DescriptionReaderComponent } from './components/description-reader/description-reader.component';
import { ReminderAlertComponent } from './components/reminder-alert/reminder-alert.component';
import { ErrorDialogComponent } from './components/error-dialog/error-dialog.component';
import { StorageBusyComponent } from './components/storage-busy/storage-busy.component';
import { DatabaseSpaceService } from './services/database-space.service';
import { ChannelPreviewService } from './services/channel-preview.service';
import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { ChoicePanelComponent } from './ui/choice-panel.component';
import { XtreamService } from './services/xtream.service';
import { NativePlayerService } from './services/native-player.service';
import { ErrorReportsService } from './services/error-reports.service';
import { ToastService } from './services/toast.service';
import { t } from './utils/i18n';

@Component({
    selector: 'app-root',
    imports: [DesktopPlayerComponent, RouterOutlet, ToastsComponent, PinDialogComponent, TrailerDialogComponent, DescriptionReaderComponent, ReminderAlertComponent, ErrorDialogComponent, ConfirmDialogComponent, ChoicePanelComponent, StorageBusyComponent],
    template: `
    <div class="app-container">
      <router-outlet></router-outlet>
    </div>
    <app-toasts />
    <app-desktop-player />
    <app-pin-dialog />
    <app-trailer-dialog />
    <app-description-reader />
    <app-reminder-alert />
    <app-confirm-dialog />
    <app-choice-panel />
    <app-error-dialog />
    <app-storage-busy />
  `,
    styles: [`
    .app-container {
      min-height: 100vh;
    }
  `],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent {
  title = 'Tvinto';

  private readonly tv = inject(TvNavigationService);
  private readonly back = inject(BackButtonService);

  /**
   * Injected here so that it exists.
   *
   * A root service is only built when something asks for it, and the only
   * thing asking was the library view -- so syncing happened while you were
   * browsing and at no other time. On the subscription screen it never started
   * at all, which is exactly where a device that has just moved to a new
   * service is parked: it cannot leave until a subscription is stored there,
   * and the thing that would store one is the sync it is not running.
   *
   * Background work belongs to the app, not to whichever screen happens to be
   * open.
   */
  private readonly sync = inject(DeviceSyncService);

  /** For the same reason, and it matters more here. */
  private readonly updates = inject(WebUpdateService);

  constructor() {
    this.back.install();

    // Here, and not on a screen, because two of the three things this does are
    // about the app as a whole: saying that this bundle started (which is what
    // stops it being rolled back), and asking whether there is a newer one.
    // A phone that only ever reaches the sign-in screen still needs both.
    this.updates.start();

    // At the root, not in the shell.
    //
    // The shell only exists once you are signed in, and putting it there left
    // the sign-in form with no way to move between its fields: a remote has no
    // Tab, so "the browser's own focus order will walk it" is true of a
    // keyboard and false of the only input a television has. The result was a
    // form that could be looked at and not filled in.
    this.tv.install();

    // The display size and language chosen for this device, before anything is drawn.
    inject(DisplaySizeService).apply();
    inject(LanguageService).init();
    // Your languages, kept in step with the account from the start: copies are ordered before Account is ever opened.
    inject(LanguagesService);

    // A clean of the database started in standby may still be running when
    // the app comes back; the busy screen says so (DatabaseSpaceService).
    inject(DatabaseSpaceService).watch();

    // From the start, so a stream the full player hands back always finds
    // someone listening, and one left on the screen by a reload is closed.
    const preview = inject(ChannelPreviewService);

    // Back arrives on the card it left from, where it was on screen.
    inject(PlaceMemoryService).install();

    // `tvinto sign-in` opening the desktop app on its request, to be allowed.
    inject(ToolRequestsService).start();
    // And tvinto with no account: this app answers it on 127.0.0.1 (desktop only).
    inject(LocalToolService).start();

    // A film or an episode whose player never closed -- the app or the device
    // went down mid-way -- is saved where it had got to (PlaybackCheckpoint).
    const xtream = inject(XtreamService);
    void inject(NativePlayerService)
      .takeUnfinished()
      .then(entry => entry && xtream.saveProgress(entry).subscribe());

    // Heard from the start, so work waiting for a quiet moment knows when the
    // remote was last used (utils/quiet.utils.ts).
    lastInput();

    // The film and show libraries from the start, not when Movies is first
    // opened: TMDB's rows, the genre pills and For You all match against
    // them (utils/library-refresh.utils.ts). A minute in and half a minute
    // after the last press, never beside a stream or a guide download: while
    // a library is written every database read waits longer, and fifteen
    // seconds in it fell on the person opening Movies (card 35, 25 November).
    // A page that needs a library never held downloads it itself.
    const nativePlayer = inject(NativePlayerService);
    const guide = inject(GuideService);
    const recordings = inject(RecordingsService);
    const provider = inject(ProviderAccessService);
    const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const busy = () =>
      nativePlayer.active() ||
      preview.state() === 'opening' ||
      preview.state() === 'playing' ||
      guide.isLoading() ||
      recordings.running().length > 0 ||
      Array.from(document.querySelectorAll('video')).some(video => !!video.currentSrc && !video.ended);
    void keepLibrariesFresh({
      quiet: () => whenQuiet({ afterStartMs: 60_000, idleMs: 30_000, checkEveryMs: 5_000, now: () => performance.now(), lastInput, stopped: () => false, wait }),
      busy,
      refresh: async () => {
        if (!(await provider.direct())) {
          return false;
        }
        await xtream.refreshLibrariesIfStale(['vod', 'series'], busy);
        return !busy();
      },
      wait,
      stopped: () => false
    });

    // A new screen on a television starts with something focused, or the
    // first press of the D-pad has nothing to move from.
    const router = inject(Router);
    router.events.pipe(filter(event => event instanceof NavigationEnd)).subscribe(() => this.tv.focusContentWhenReady());

    // Error reports, said once on a device that skips the walk-through.
    const reports = inject(ErrorReportsService);
    const toasts = inject(ToastService);
    router.events.pipe(filter(event => event instanceof NavigationEnd)).subscribe(event =>
      reports.noticeIfNeeded(
        event.urlAfterRedirects,
        open => toasts.info(t('errorReports.noticeTitle'), t('errorReports.noticeBody'), { label: t('errorReports.noticeAction'), run: open }),
        () => void router.navigate(['/account'], { queryParams: { section: 'subtitles' } })
      )
    );
  }
}
