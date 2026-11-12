import { Injectable, computed, inject, signal } from '@angular/core';
import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { updatesBaseUrl } from './api-url';
import { feedAddress, readFeedJson } from './native/updateFeed';
import { PlatformService } from './platform.service';
import { TvNavigationService } from './tv-navigation.service';
import { WEB_UPDATE_PLUGIN } from './native/webUpdate';
import { platformSaysTelevision } from './native/television';
import { ApkManifest, megabytes, newerApp, parseApkManifest } from '../utils/app-update.utils';
import { t } from '../utils/i18n';

/** The native half, from APK 1.0.32 (AppUpdatePlugin.java). */
interface AppUpdatePlugin {
  download(options: { url: string; sha256: string; version: string }): Promise<{ version: string }>;
  install(options: { version: string }): Promise<{ needsPermission: boolean }>;
  downloaded(options: { version: string }): Promise<{ ready: boolean }>;
  addListener(event: 'progress', listener: (progress: { received: number; total: number }) => void): Promise<PluginListenerHandle>;
}

const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate');

export type AppUpdatePhase = 'idle' | 'downloading' | 'ready' | 'browser' | 'manual' | 'failed';

/** How often a copy left open asks again. */
const EVERY = 6 * 60 * 60 * 1000;

const LATER_KEY = 'xtream.appUpdate.later';

/**
 * Saying when a newer Android app is out, and fetching it on request.
 *
 * Web code updates itself (WebUpdateService); native code cannot, so a change
 * to the player needs the APK installed. Before this, nothing in the app said
 * so and the person had to know to go to the downloads page. Now a notice says
 * which version is out, "Download update" fetches it inside the app and opens
 * Android's installer -- which still asks, as it should.
 *
 * An APK older than 1.0.32 has no native downloader; there the button hands
 * the file's address to the system, which downloads it in the browser. A
 * television without a browser needs 1.0.32 once, by hand.
 *
 * On a television the download is not asked for: it starts by itself as soon
 * as a newer app is seen, shown as it goes, so what is left is one press of
 * Install (26 September -- a notice to press, a download to wait
 * for and an installer to confirm was three steps for what the web code does
 * in none). Not on a phone or a tablet, which may be on mobile data, and the
 * APK is well over a hundred megabytes.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly platform = inject(PlatformService);
  private readonly webUpdate = inject(WEB_UPDATE_PLUGIN);
  private readonly tv = inject(TvNavigationService);

  /**
   * The address the Downloader app can be given: a sync service's short `/a`,
   * or the APK's own address on any other feed.
   */
  readonly shortLink = computed(() => {
    const feed = this.updatesBase();
    const update = this.available();
    if (feed?.endsWith('/updates')) {
      return feed.replace(/\/updates$/, '/a');
    }
    return feed && update ? feedAddress(feed, update.file) : '';
  });

  /** The newer app, when there is one. */
  readonly available = signal<ApkManifest | null>(null);
  readonly phase = signal<AppUpdatePhase>('idle');
  /** 0 to 1 while downloading, when the size is known. */
  readonly progress = signal<number | null>(null);
  readonly message = signal('');
  private readonly laterFor = signal<string | null>(readLater());

  readonly size = computed(() => megabytes(this.available()?.size ?? 0));

  /** "45%", or "…" while the size is unknown. */
  readonly percent = computed(() => {
    const progress = this.progress();
    return progress === null ? '…' : `${Math.round(progress * 100)}%`;
  });

  /** Whether to show the notice: something newer, and not put off for this version. */
  readonly showing = computed(() => {
    const available = this.available();
    return !!available && this.laterFor() !== available.version;
  });

  /**
   * Whether a web update waits its turn behind this notice.
   *
   * One notice at a time, the app's first. Installing the app throws away any
   * web update already downloaded (Capacitor does, whenever the app's version
   * changes), so a restart before it is wasted; a newer web update comes again
   * by itself after the install. Two notices -- "Restart" and "Download" --
   * left a user not knowing which to do first (26 September, and again on
   * 25 October with the web update the newer of the two). Put off with Later,
   * the web update's notice shows instead.
   */
  readonly holdsBackWebUpdate = computed(() => this.showing());

  private started = false;

  start(): void {
    if (this.started || this.platform.platform !== 'android') {
      return;
    }
    this.started = true;
    void this.check();
    const timer = setInterval(() => void this.check(), EVERY);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  async check(): Promise<void> {
    let installed: string;
    try {
      installed = (await this.webUpdate.state()).app;
    } catch {
      return;
    }

    let published: ApkManifest | null = null;
    try {
      const feed = this.updatesBase();
      const body = feed ? await readFeedJson(feedAddress(feed, 'android-apk.json')) : null;
      published = body ? parseApkManifest(body) : null;
    } catch {
      return;
    }

    const newer = newerApp(published, installed);
    this.available.set(newer);
    if (newer && this.native() && this.phase() === 'idle') {
      try {
        if ((await AppUpdate.downloaded({ version: newer.version })).ready) {
          this.phase.set('ready');
          return;
        }
      } catch {
        // Asked again when the button is pressed.
      }
      if (this.tv.isTelevision() || (await platformSaysTelevision())) {
        await this.fetch(newer);
      }
    }
  }

  /** "Download update". Inside the app where it can, in the browser where it cannot. */
  async download(): Promise<void> {
    const update = this.available();
    if (!update || this.phase() === 'downloading') {
      return;
    }
    const feed = this.updatesBase();
    if (!feed) {
      return;
    }
    const url = feedAddress(feed, update.file);
    this.message.set('');

    if (!this.native() && this.tv.isTelevision()) {
      // A television on an older APK: no downloader in the app, and usually
      // no browser to hand the file to. Say where to get it instead.
      this.phase.set('manual');
      return;
    }

    if (!this.native()) {
      // A navigation away from the app is handed to the system, which
      // downloads an APK in the browser.
      this.phase.set('browser');
      window.location.href = url;
      return;
    }

    if (await this.fetch(update)) {
      await this.install();
    }
  }

  /** Brings the APK onto the device, showing how far it has got. True once it is here and checked. */
  private async fetch(update: ApkManifest): Promise<boolean> {
    if (this.phase() === 'downloading') {
      return false;
    }
    this.phase.set('downloading');
    this.progress.set(0);
    this.message.set('');
    const listener = await AppUpdate.addListener('progress', ({ received, total }) =>
      this.progress.set(total > 0 ? received / total : null)
    );
    try {
      const feed = this.updatesBase();
      if (!feed) {
        throw new Error(t('update.downloadFailed'));
      }
      await AppUpdate.download({ url: feedAddress(feed, update.file), sha256: update.sha256, version: update.version });
      this.phase.set('ready');
      return true;
    } catch (error) {
      this.phase.set('failed');
      this.message.set(error instanceof Error ? error.message : t('update.downloadFailed'));
      return false;
    } finally {
      void listener.remove();
      this.progress.set(null);
    }
  }

  /** Opens Android's installer on the downloaded app. */
  async install(): Promise<void> {
    const update = this.available();
    if (!update) {
      return;
    }
    try {
      const { needsPermission } = await AppUpdate.install({ version: update.version });
      this.message.set(
        needsPermission ? t('update.allowInstall') : ''
      );
    } catch (error) {
      this.phase.set('failed');
      this.message.set(error instanceof Error ? error.message : t('update.installerFailed'));
    }
  }

  /** "Later": hidden until a newer version than this one is out. */
  later(): void {
    const version = this.available()?.version ?? null;
    this.laterFor.set(version);
    // A download under way carries on, so Install is there when it is wanted.
    if (this.phase() !== 'downloading' && this.phase() !== 'ready') {
      this.phase.set('idle');
    }
    try {
      if (version) {
        localStorage.setItem(LATER_KEY, version);
      }
    } catch {
      // Only a convenience; the notice returns next launch.
    }
  }

  private native(): boolean {
    return Capacitor.isPluginAvailable('AppUpdate');
  }

  /** The build's own feed, whichever server the account is on (updatesBaseUrl). */
  private updatesBase(): string | null {
    return updatesBaseUrl();
  }
}

const readLater = (): string | null => {
  try {
    return localStorage.getItem(LATER_KEY);
  } catch {
    return null;
  }
};
