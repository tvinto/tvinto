import { Injectable, effect, inject, signal } from '@angular/core';
import { GuideService } from './guide.service';
import { NativePlayerService } from './native-player.service';

/** What the Electron preload offers about updates. Absent everywhere else. */
interface UpdateBridge {
  ready(): Promise<string | null>;
  onReady(listener: (version: string) => void): void;
  install(): Promise<boolean>;
  setBusy(reason: string | null): void;
}

const bridge = (): UpdateBridge | null =>
  (window as { xtreamDesktop?: { updates?: UpdateBridge } }).xtreamDesktop?.updates ?? null;

/** How often the page tells the desktop whether it is busy. */
const REPORT_EVERY_MS = 30 * 1000;

/**
 * The page's half of getting a downloaded desktop update installed.
 *
 * The desktop installed updates only when the app was closed, and a PC wired
 * to a television is not closed -- one sat on 1.0.10 for four days with newer
 * versions waiting. The main process now installs by itself once the machine
 * has been left alone (`electron/src/installWhen.ts`); this does the two
 * things only the page can:
 *
 * - offers the restart, so somebody at the app need not wait for idleness;
 * - says when it is in the middle of something an idle restart would spoil.
 *   Idle is measured from the last key press, and a film in the page's own
 *   player -- paused, even -- or a guide half downloaded looks exactly like a
 *   machine nobody is using.
 *
 * Does nothing outside the desktop app.
 */
@Injectable({ providedIn: 'root' })
export class DesktopUpdateService {
  private readonly guide = inject(GuideService);
  private readonly nativePlayer = inject(NativePlayerService);

  /** The version waiting to install, or null. */
  readonly ready = signal<string | null>(null);

  /** Whether "Later" was pressed. For this run only; the idle install still happens. */
  readonly dismissed = signal(false);

  readonly installing = signal(false);

  private started = false;
  private lastReported: string | null | undefined = undefined;

  constructor() {
    // A guide starting to load is reported at once rather than at the next
    // poll, since a restart then would throw the download away.
    effect(() => {
      this.guide.isLoading();
      this.nativePlayer.active();
      this.report();
    });
  }

  /** Begins listening, once per app run. Safe to call more than once. */
  start(): void {
    const updates = bridge();
    if (this.started || !updates) {
      return;
    }
    this.started = true;

    updates.onReady(version => this.ready.set(version));
    // Downloaded before this page was listening -- before sign-in, or before a
    // reload of the page.
    void updates.ready().then(version => {
      if (version) {
        this.ready.set(version);
      }
    });

    this.report();
    setInterval(() => this.report(), REPORT_EVERY_MS);
  }

  async restart(): Promise<void> {
    const updates = bridge();
    if (!updates || this.installing()) {
      return;
    }
    this.installing.set(true);
    try {
      if (!(await updates.install())) {
        this.installing.set(false);
      }
    } catch {
      this.installing.set(false);
    }
  }

  later(): void {
    this.dismissed.set(true);
  }

  /** What the page is in the middle of, or null for nothing. */
  busy(): string | null {
    if (this.guide.isLoading()) {
      return 'loading a guide';
    }
    if (this.nativePlayer.active() || this.pageVideoOpen()) {
      return 'something is open to watch';
    }
    return null;
  }

  /** Any film in the page's player that has not finished, playing or paused. */
  private pageVideoOpen(): boolean {
    return Array.from(document.querySelectorAll('video')).some(
      video => !!video.currentSrc && !video.ended
    );
  }

  private report(): void {
    const updates = this.started ? bridge() : null;
    if (!updates) {
      return;
    }
    const reason = this.busy();
    if (reason !== this.lastReported) {
      this.lastReported = reason;
      updates.setBusy(reason);
    }
  }
}
