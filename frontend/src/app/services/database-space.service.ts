import { Injectable, computed, inject, signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { DeviceDatabaseService } from './device-database.service';
import { ToastService } from './toast.service';
import { BANNER_SNOOZE_MS, LastClean, bannerDue, finishedSince, freed } from '../utils/storage.utils';
import { t } from '../utils/i18n';

interface Space {
  bytes: number;
  freeBytes: number;
  last: LastClean;
  /** Whether a clean is running in the app now. */
  cleaning?: boolean;
}

interface DatabaseSpacePlugin {
  measure(): Promise<Space>;
  clean(): Promise<void>;
  cancel(): Promise<void>;
}

const DatabaseSpace = registerPlugin<DatabaseSpacePlugin>('DatabaseSpace');

const SNOOZE_KEY = 'xtream_storage_banner_until';

/** How long a clean has to begin before "not running" means it never will. */
const GRACE_MS = 3000;

/**
 * The device database's wasted space (DatabaseSpace.java): measured for the
 * Account page and the banner, given back by "Free up space".
 *
 * The space is given back by itself while the device is idle -- a television
 * in standby -- on a connection of its own in the APK. The button runs the same clean
 * now, behind a busy screen, with every database call of the app waiting
 * until it is over (DeviceDatabaseService.hold). Android only: the desktop
 * keeps its data in IndexedDB.
 */
@Injectable({ providedIn: 'root' })
export class DatabaseSpaceService {
  private readonly database = inject(DeviceDatabaseService);
  private readonly toasts = inject(ToastService);

  readonly supported = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('DatabaseSpace');

  readonly space = signal<Space | null>(null);

  /** Seconds since "Free up space", while it runs; null otherwise. */
  readonly cleaning = signal<number | null>(null);

  /** Whether the clean running can stop part way (it cannot while it is a device's first). */
  readonly cancellable = signal(false);

  /** What the last clean asked for here gave back, for the card to say. */
  readonly result = signal<number | null>(null);

  private readonly snoozedUntil = signal(readSnooze());

  readonly bannerDue = computed(() => {
    const space = this.space();
    return !!space && this.cleaning() === null && bannerDue(space.freeBytes, this.snoozedUntil(), Date.now());
  });

  private stopAsked = 0;

  async refresh(): Promise<void> {
    if (!this.supported) {
      return;
    }
    try {
      this.space.set(await DatabaseSpace.measure());
    } catch {
      // An APK without the plugin's measure: nothing to show.
    }
  }

  snoozeBanner(): void {
    const until = Date.now() + BANNER_SNOOZE_MS;
    this.snoozedUntil.set(until);
    try {
      localStorage.setItem(SNOOZE_KEY, String(until));
    } catch {
      // Then it comes back at the next start.
    }
  }

  /**
   * Called at start and whenever the app comes back: a clean started in
   * standby may still be running -- the first on a device cannot stop part
   * way -- and then the busy screen says so, rather than the app freezing.
   */
  watch(): void {
    if (!this.supported) {
      return;
    }
    const check = async () => {
      try {
        const space = await DatabaseSpace.measure();
        this.space.set(space);
        if (space.cleaning && this.cleaning() === null) {
          void this.follow(space.last?.startedAt ?? Date.now(), false);
        }
      } catch {
        // An APK without the plugin: nothing to watch.
      }
    };
    void check();
    void App.addListener('appStateChange', ({ isActive }) => isActive && void check());
  }

  async clean(): Promise<void> {
    if (!this.supported || this.cleaning() !== null) {
      return;
    }
    this.result.set(null);
    await this.follow(Date.now(), true);
  }

  /** The busy screen, held until the clean started at `startedAt` is over. */
  private async follow(startedAt: number, start: boolean): Promise<void> {
    this.stopAsked = 0;
    this.cancellable.set(false);
    this.cleaning.set(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    const release = this.database.hold();
    let last: LastClean = {};
    try {
      if (start) {
        await DatabaseSpace.clean();
      }
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        this.cleaning.set(Math.round((Date.now() - startedAt) / 1000));
        const space = await DatabaseSpace.measure();
        last = space.last ?? {};
        this.cancellable.set(last.state === 'running' && last.mode === 'steps');
        if (finishedSince(last, startedAt)) {
          break;
        }
        // Nothing running and no word from it: it will not come.
        if (space.cleaning === false && Date.now() - startedAt > GRACE_MS) {
          last = this.stopAsked ? { state: 'stopped' } : { state: 'failed', reason: 'gone' };
          break;
        }
      }
    } catch {
      last = { state: 'failed', reason: 'plugin' };
    } finally {
      release();
      this.cleaning.set(null);
      this.cancellable.set(false);
    }

    if (!start) {
      // One that ran in standby: nobody asked, so nothing to report.
      await this.refresh();
      return;
    }
    if (last.state === 'done') {
      this.result.set(freed(last));
    } else if (last.state === 'failed') {
      this.toasts.error(
        t('storage.failed.title'),
        last.reason === 'busy' ? t('storage.failed.busy') : last.reason === 'full' ? t('storage.failed.full') : t('storage.failed.unknown')
      );
    }
    await this.refresh();
  }

  async cancel(): Promise<void> {
    if (this.cleaning() === null || this.stopAsked) {
      return;
    }
    this.stopAsked = Date.now();
    await DatabaseSpace.cancel().catch(() => undefined);
  }
}

function readSnooze(): number {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}
