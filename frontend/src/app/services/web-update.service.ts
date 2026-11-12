import { Injectable, Injector, inject, signal } from '@angular/core';
import { App } from '@capacitor/app';
import { updatesBaseUrl } from './api-url';
import { feedAddress, readFeedJson } from './native/updateFeed';
import { PlatformService } from './platform.service';
import { WEB_UPDATE_PLUGIN, WebBundleState } from './native/webUpdate';
import { decideUpdate, momentToApply, parseBundleManifest } from '../utils/web-update.utils';
import { NativePlayerService } from './native-player.service';

/**
 * The phone replacing its own web bundle.
 *
 * Almost every change to this app is a change to files a WebView loads, and a
 * Capacitor app can be told to load them from somewhere other than the APK. So
 * a fix reaches a phone across the country without anybody plugging it in, and
 * the APK is sideloaded once rather than every time.
 *
 * What is downloaded is the app's own code, which is the whole of the risk: a
 * server that can publish a bundle can make the app do anything, on a device
 * that holds the provider password. It is the same server that already holds
 * the account, so nothing new is being trusted -- but it is worth writing down
 * that this is what was chosen, over updates that arrive by hand.
 *
 * Three rules make it survivable, and all three are here or beside it:
 *
 * - **Nothing swaps while the app is open.** A bundle is unpacked and used
 *   from the next launch.
 * - **A bundle must say which APK it needs** (`minNative`). Web code calling a
 *   plugin the installed APK has not got fails later, somewhere else, looking
 *   like anything but an update.
 * - **A bundle that does not start is rolled back.** This service says "it
 *   started" a few seconds after the app is up; a bundle that white-screens
 *   never gets that far, and the device goes back to the one in the APK.
 */

/** How long after start a bundle is taken to have started properly. */
const CONFIRM_AFTER = 15_000;

/**
 * How often a copy left open goes back and asks.
 *
 * It was six hours, and a television never closes the app: Android keeps it
 * in the background, so an update took days to arrive (2 October).
 * The question is one small file, so asking often costs nothing.
 */
const EVERY = 30 * 60 * 1000;

/** How often an app left alone looks at whether this is a moment to take a waiting update. */
const IDLE_CHECK = 60 * 1000;

/** How soon after coming back an update that has just arrived may still be taken without asking. */
const STILL_ARRIVING = 30 * 1000;

@Injectable({ providedIn: 'root' })
export class WebUpdateService {
  private readonly platform = inject(PlatformService);
  private readonly plugin = inject(WEB_UPDATE_PLUGIN);

  /** The version unpacked and waiting for the next launch, if any. */
  readonly waiting = signal<string | null>(null);

  /**
   * The version being fetched right now, if one is.
   *
   * Shown, because an update arriving was invisible: a user could not tell
   * whether one was happening, had happened, or was waiting for a restart.
   */
  readonly downloading = signal<string | null>(null);

  /** Whether "Later" was pressed on the waiting update, for this run. */
  readonly dismissed = signal(false);

  /** Set while a restart is under way, so the button cannot be pressed twice. */
  readonly restarting = signal(false);

  /** What is running, once it has been asked. Null in a browser. */
  readonly state = signal<WebBundleState | null>(null);

  private started = false;
  private readonly injector = inject(Injector);

  /** When the app last went out of sight, unless its own player took the screen. */
  private hiddenAt: number | null = null;
  /** When it last came back, and after how long away. */
  private returned: { at: number; afterMs: number } | null = null;
  /** The last key press or touch. */
  private lastInput = Date.now();

  /**
   * Begin. Called once, from the app itself rather than from a screen.
   *
   * A root service is only built when something asks for it, and background
   * work that belongs to the app must not depend on which page is open --
   * a lesson this codebase has already paid for once, in `AppComponent`.
   */
  start(): void {
    if (this.started || this.platform.platform !== 'android') {
      return;
    }
    this.started = true;

    // Late, and deliberately: being here at all means the bundle loaded, but
    // "loaded" and "works" are not the same, and the few seconds in between
    // are where a broken release shows itself.
    setTimeout(() => void this.confirm(), CONFIRM_AFTER);

    void this.check();
    const timer = setInterval(() => void this.check(), EVERY);
    // A browser has no such thing; a test does.
    (timer as unknown as { unref?: () => void }).unref?.();

    // Coming back to the app -- a television woken from standby, another app
    // left -- is when an update is both most likely to be missed and least
    // in anybody's way, so it asks then, and takes one already waiting.
    void App.addListener('appStateChange', ({ isActive }) => (isActive ? this.cameBack() : this.wentAway()));

    // Not passive: zone.js, while the app had it, gave every listener for an
    // event on a target the options of the first, and a passive keydown here once stopped the TV
    // navigation preventing anything (ParentalLockService).
    const touched = () => (this.lastInput = Date.now());
    document.addEventListener('keydown', touched, true);
    document.addEventListener('pointerdown', touched, true);

    const idle = setInterval(() => void this.applyIfQuiet(), IDLE_CHECK);
    (idle as unknown as { unref?: () => void }).unref?.();
  }

  private wentAway(): void {
    // The app's own player taking the screen is not leaving: its closing is
    // a return to the page somebody was on, which must not restart under them.
    this.hiddenAt = this.player().active() ? null : Date.now();
  }

  private async cameBack(): Promise<void> {
    const away = this.hiddenAt === null ? null : Date.now() - this.hiddenAt;
    this.hiddenAt = null;
    this.returned = away === null ? null : { at: Date.now(), afterMs: away };
    if (await this.applyIfQuiet()) {
      return;
    }
    await this.check();
    await this.applyIfQuiet();
  }

  /**
   * Takes a waiting update now if this is a moment that costs nobody anything
   * (`momentToApply`): just back after a while away and nothing pressed
   * since, or untouched for a long time. True when it restarts.
   */
  private async applyIfQuiet(): Promise<boolean> {
    const now = Date.now();
    const returned = this.returned;
    const justBack = returned !== null && now - returned.at < STILL_ARRIVING && this.lastInput < returned.at;
    const moment = momentToApply({
      waiting: this.waiting() !== null,
      playing: this.player().active(),
      returnedAfterMs: justBack ? returned.afterMs : null,
      idleMs: now - this.lastInput,
      visible: document.visibilityState === 'visible'
    });
    if (!moment) {
      return false;
    }
    await this.restart();
    return true;
  }

  /** Asked for when needed: the player service is built late, and this one early. */
  private player(): NativePlayerService {
    return this.injector.get(NativePlayerService);
  }

  /**
   * Ask what has been published, and take it if the rules allow.
   *
   * Never throws, and says nothing when there is nothing to say. Every reason
   * for not updating -- offline, nothing published, not newer, needs a newer
   * APK -- is an ordinary state of affairs, not a fault to report.
   */
  async check(): Promise<void> {
    // Asked again here rather than only in `start`, because this is public and
    // the cost of getting it wrong is asking a plugin that does not exist: in
    // a browser that is a rejected promise in the console, every launch.
    if (this.platform.platform !== 'android') {
      return;
    }

    let state: WebBundleState;

    try {
      state = await this.plugin.state();
    } catch {
      // No plugin: an older APK, or a build where it was not registered. The
      // app is untouched and works; it simply cannot update itself.
      return;
    }

    this.state.set(state);
    // Downloaded on an earlier run and not yet in use: it is waiting just the
    // same, and restarting is what brings it in.
    if (state.pending) {
      this.waiting.set(state.pending);
    }

    const decision = decideUpdate({
      manifest: await this.published(),
      running: state.version,
      app: state.app,
      // A bridge that has nothing to say for a field leaves it out rather than
      // sending null, and "no version has been refused" must not arrive here
      // as undefined and be compared against.
      refused: state.refused ?? null,
      pending: state.pending ?? null
    });

    if (!decision.take) {
      return;
    }

    const feed = this.updatesBase();
    if (!feed) {
      return;
    }
    this.downloading.set(decision.manifest.version);
    try {
      await this.plugin.download({
        url: feedAddress(feed, decision.manifest.file),
        version: decision.manifest.version,
        sha256: decision.manifest.sha256
      });

      this.waiting.set(decision.manifest.version);
      this.dismissed.set(false);
    } catch {
      // A failed download is tomorrow's problem. The bundle in use is
      // untouched, and the next check asks again.
    } finally {
      this.downloading.set(null);
    }
  }

  /**
   * Start the app again, taking any waiting update with it.
   *
   * A reload in place on APK 1.0.36 and later. An older APK has no way to do
   * that, and there the app closes instead: opened again, it starts on the
   * waiting bundle, which is the same result for one more step.
   */
  async restart(): Promise<void> {
    if (this.restarting()) {
      return;
    }
    this.restarting.set(true);

    try {
      await this.plugin.restart();
    } catch {
      await App.exitApp();
    }
  }

  later(): void {
    this.dismissed.set(true);
  }

  /** Tell the device this bundle started, which is what stops a rollback. */
  private async confirm(): Promise<void> {
    try {
      await this.plugin.confirm();
    } catch {
      // Nothing to do about it, and nothing to warn about: the cost of a
      // missed confirmation is a rollback to a bundle that also worked.
    }
  }

  /** What the service says the current bundle is, or null. */
  private async published(): Promise<ReturnType<typeof parseBundleManifest>> {
    const feed = this.updatesBase();
    if (!feed) {
      return null;
    }
    try {
      const body = await readFeedJson(feedAddress(feed, 'android-latest.json'));
      return body ? parseBundleManifest(body) : null;
    } catch {
      return null;
    }
  }

  /**
   * Where updates are served from: the build's own feed, not the server the
   * account is on, which may be somebody's own with no builds (updatesBaseUrl).
   */
  private updatesBase(): string | null {
    return updatesBaseUrl();
  }
}
