import { Injectable, inject } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { filter, firstValueFrom } from 'rxjs';
import { SETTING_KEYS } from '@shared/types';
import { lastChannel, opensLastChannel, shouldOpenLastChannel } from '@shared/startup';
import { isStartLink, routeForLink } from '../utils/deep-links.utils';
import { platformSaysTelevision } from './native/television';
import { SettingsService } from './settings.service';
import { XtreamService } from './xtream.service';

/** The launch link already followed in this run of the app. */
const LAUNCH_KEY = 'xtream_launch_link_followed';

/** Set once this run of the app has reached its screens; a reload of the page keeps it. */
const STARTED_KEY = 'xtream_run_started';

/** How long the last channel waits for the account's settings before going on the device's copy. */
const SETTINGS_WAIT_MS = 4000;

/**
 * What the app opens on, past the first page: an tvinto:// link
 * (deep-links.utils.ts) -- the one the app was started with, and any that
 * arrives while it runs -- or, on a television that asked for it, the last
 * channel watched (shared/startup.ts).
 *
 * Started from the shell, so a link that started the app is followed once
 * somebody is signed in and the screens exist -- not on the sign-in page.
 */
@Injectable({ providedIn: 'root' })
export class DeepLinksService {
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsService);
  private readonly xtream = inject(XtreamService);
  private started = false;

  start(): void {
    // Android only: the links come from its notifications and home screen,
    // and a television that opens into a channel is an Android one.
    if (this.started || Capacitor.getPlatform() !== 'android') {
      return;
    }
    this.started = true;
    const firstThisRun = this.firstStartThisRun();

    void App.addListener('appUrlOpen', event => this.follow(event.url));
    void App.getLaunchUrl()
      .then(launch => {
        // Asked again after every restart of the page -- a profile switch
        // reloads it -- and still the link the app was opened with then:
        // followed once per run of the app, not once per page.
        if (launch?.url && !this.followedBefore(launch.url)) {
          this.follow(launch.url);
          return;
        }
        if (firstThisRun) {
          void this.openLastChannel(!!launch?.url);
        }
      })
      .catch(() => undefined);
  }

  /**
   * Plays the last channel watched in place of For You, when the account asked
   * for it, this is a television, and nothing else asked to be shown. Back
   * from the player comes to For You, as from one of its cards.
   */
  private async openLastChannel(openedByLink: boolean): Promise<void> {
    const television = await platformSaysTelevision();
    if (!television) {
      return;
    }
    // The account's word rather than this device's copy of it, which can be
    // from before the setting was changed on another television.
    await this.settingsLoaded(SETTINGS_WAIT_MS);
    const asked = opensLastChannel(this.settings.get(SETTING_KEYS.openLastChannel));
    await this.settled();
    const start = { asked, television, firstThisRun: true, openedByLink, page: this.page() };
    if (!shouldOpenLastChannel(start)) {
      return;
    }

    await this.playLastChannel('/for-you');
  }

  /**
   * The television was turned on and opened the app on `tvinto://start`
   * (device/StartUp.java): For You, or the last channel when Account says so
   * -- from whatever page it was left on, since it may have been running all
   * along behind the screen that went to standby.
   */
  private async openOnStart(): Promise<void> {
    await this.settingsLoaded(SETTINGS_WAIT_MS);
    await this.settled();
    if (opensLastChannel(this.settings.get(SETTING_KEYS.openLastChannel)) && (await this.playLastChannel(null))) {
      return;
    }
    if (this.page() !== '/for-you') {
      void this.router.navigate(['/for-you']);
    }
  }

  /**
   * Plays the newest channel in history, if it is one and not behind a lock.
   * `onlyFrom`: the page the app must still be on once history is read --
   * somebody may have moved on meanwhile -- or null for any. Whether it did.
   */
  private async playLastChannel(onlyFrom: string | null): Promise<boolean> {
    let channel;
    try {
      // The newest entry alone: when it is behind a lock it is left out, and
      // the answer is For You rather than the channel before it.
      channel = lastChannel(await firstValueFrom(this.xtream.getRecentlyWatched('live', 1)));
    } catch {
      return false;
    }
    if (!channel || (onlyFrom !== null && this.page() !== onlyFrom)) {
      return false;
    }
    void this.router.navigate(['/tv'], {
      queryParams: { play: channel.itemId, kind: 'recent', name: channel.name, icon: channel.icon ?? '', return: 1 }
    });
    return true;
  }

  /** Until the account's settings have arrived, or the wait is up (offline, a slow service). */
  private async settingsLoaded(waitMs: number): Promise<void> {
    const until = Date.now() + waitMs;
    while (!this.settings.loaded() && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /** The current page without its query. */
  private page(): string {
    return this.router.url.split('?')[0];
  }

  /** Once the navigation under way, if any, has finished: the shell starts during the first one. */
  private async settled(): Promise<void> {
    if (!this.router.getCurrentNavigation()) {
      return;
    }
    await firstValueFrom(
      this.router.events.pipe(
        filter(event => event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError)
      )
    );
  }

  /** True the first time in this run of the app; a page reload in the same run keeps the mark. */
  private firstStartThisRun(): boolean {
    try {
      if (sessionStorage.getItem(STARTED_KEY)) {
        return false;
      }
      sessionStorage.setItem(STARTED_KEY, '1');
      return true;
    } catch {
      // Storage refused: never rather than at every reload.
      return false;
    }
  }

  private followedBefore(link: string): boolean {
    try {
      if (sessionStorage.getItem(LAUNCH_KEY) === link) {
        return true;
      }
      sessionStorage.setItem(LAUNCH_KEY, link);
    } catch {
      // Followed, at worst once more than it should be.
    }
    return false;
  }

  private follow(link: string): void {
    if (isStartLink(link)) {
      void this.openOnStart();
      return;
    }
    const target = routeForLink(link);
    if (target) {
      void this.router.navigate(target.path, { queryParams: target.queryParams });
    }
  }
}
