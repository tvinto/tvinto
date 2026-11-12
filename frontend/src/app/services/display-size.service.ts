import { Injectable, computed, inject, signal } from '@angular/core';
import { PlatformService } from './platform.service';
import { TvNavigationService } from './tv-navigation.service';
import { DISPLAY_SIZES, DisplaySize, DisplaySizeOption, displaySizeFrom } from '../utils/display-size.utils';

const KEY = 'xtream.displaySize';

/** What the desktop app's preload offers (electron/src/preload.ts), from desktop 1.0.49. */
interface DisplayBridge {
  setZoom(factor: number): void;
}

const desktopDisplay = (): DisplayBridge | null =>
  (window as { xtreamDesktop?: { display?: DisplayBridge } }).xtreamDesktop?.display ?? null;

/**
 * Draws the whole app bigger or smaller, on this device only.
 *
 * Per device and not on the account: the same person wants a television
 * across the room bigger and a desktop monitor at arm's length smaller.
 *
 * Two different levers, because the layouts are built differently:
 *
 * - **A television** sizes everything from the root font size (styles.css,
 *   "The television scale") -- type, spacing, cards, guide rows. The factor
 *   multiplies that one number, through `--ui-scale`, and the navigation
 *   measures the new scale so the rows it places move with it.
 * - **The desktop app** is laid out in fixed pixels in places, which a root
 *   font size would leave behind: text grown out of a card that did not grow.
 *   So there it is Electron's own page zoom, which is what Ctrl and plus does
 *   in a browser and scales everything alike.
 *
 * Not offered on a phone, whose layout is also fixed pixels in places and
 * which follows Android's own font size and display size already.
 *
 * Smaller is left out where it cannot be drawn. Android's WebView draws no
 * text under 8 CSS pixels, and 8 is exactly a 1080p television's standard
 * root (960 CSS pixels wide, 1rem = 16/1920 of that) -- so Smaller changed
 * nothing there, measured on the emulator. A television's layout already
 * scales with its screen, which is what Smaller is for elsewhere.
 */
@Injectable({ providedIn: 'root' })
export class DisplaySizeService {
  private readonly platform = inject(PlatformService);
  private readonly tv = inject(TvNavigationService);

  private readonly chosen = signal<DisplaySizeOption>(displaySizeFrom(read()));

  /** The sizes this device can actually draw. */
  readonly options = computed(() => {
    const standardRoot = this.tv.isTelevision() ? (window.innerWidth * 16) / 1920 : null;
    return DISPLAY_SIZES.filter(option => standardRoot === null || drawsText(standardRoot * option.factor));
  });

  /** What is in effect: the choice, or standard if this device cannot draw it. */
  readonly current = computed(() => {
    const chosen = this.chosen();
    return this.options().includes(chosen) ? chosen : displaySizeFrom('standard');
  });

  /** Whether this device has a way to apply it. */
  readonly offered = computed(
    () => this.tv.isTelevision() || (this.platform.platform === 'electron' && desktopDisplay() !== null)
  );

  /** Once, at start, before the first screen is drawn if it can be. */
  apply(): void {
    const { factor } = this.current();
    document.documentElement.style.setProperty('--ui-scale', String(factor));
    try {
      desktopDisplay()?.setZoom(factor);
    } catch {
      // An older desktop app: the setting is not offered there anyway.
    }
    this.tv.remeasure();
  }

  choose(id: DisplaySize): void {
    this.chosen.set(displaySizeFrom(id));
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // For this run only.
    }
    this.apply();
  }
}

/**
 * Whether text this small comes out this small, or is held at the WebView's
 * minimum. Asked of the page itself rather than assumed: the minimum is a
 * setting of the app's WebView, and a later APK may lower it.
 */
const drawsText = (px: number): boolean => {
  const probe = document.createElement('span');
  probe.style.fontSize = `${px}px`;
  document.body.appendChild(probe);
  const drawn = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return Math.abs(drawn - px) < 0.1;
};

const read = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
