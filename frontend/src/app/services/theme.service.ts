import { Injectable, effect, inject, signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { SETTING_KEYS } from '@shared/types';
import { SettingsService } from './settings.service';

/** The Android window behind the status and navigation bars (SystemColorsPlugin). */
const SystemColors = registerPlugin<{ set(options: { background: string; dark: boolean }): Promise<void> }>('SystemColors');

export type Theme = 'light' | 'dark';

/**
 * Light/dark selection, applied as the `dark` class on the root element to
 * match the token setup in styles.css.
 *
 * The choice belongs to the account, so it follows you between devices rather
 * than being remade on each one. SettingsService keeps a copy in localStorage
 * where index.html reads it before Angular boots, which is what stops a
 * light-mode user seeing a dark flash on the way in.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly settings = inject(SettingsService);
  private readonly current = signal<Theme>(this.read());

  readonly theme = this.current.asReadonly();

  constructor() {
    effect(() => {
      const theme = this.current();
      document.documentElement.classList.toggle('dark', theme === 'dark');
      this.paintSystemBars(theme);
    });
    if (Capacitor.isPluginAvailable('SystemColors')) {
      // Android may set the bars back on the way out and in again.
      void App.addListener('appStateChange', ({ isActive }) => isActive && this.paintSystemBars(this.current()));
    }

    // A theme arriving from another device applies here without being pushed
    // back, which would otherwise have the two devices trading writes.
    effect(() => {
      if (!this.settings.loaded()) {
        return;
      }
      const stored = this.settings.get(SETTING_KEYS.theme);
      if (stored === 'light' || stored === 'dark') {
        this.current.set(stored);
      }
    });
  }

  isDark(): boolean {
    return this.current() === 'dark';
  }

  toggle(): void {
    this.set(this.current() === 'dark' ? 'light' : 'dark');
  }

  set(theme: Theme): void {
    this.current.set(theme);
    this.settings.set(SETTING_KEYS.theme, theme);
  }

  /**
   * The phone's status and navigation bars in the page's own background, with
   * icons that read on it: they were light grey around the dark app.
   * The colour is read from the page once the
   * theme's class has applied, so the bars cannot drift from the tokens.
   */
  private paintSystemBars(theme: Theme): void {
    if (!Capacitor.isPluginAvailable('SystemColors')) {
      return;
    }
    requestAnimationFrame(() => {
      const background = asHex(getComputedStyle(document.body).backgroundColor);
      if (background) {
        void SystemColors.set({ background, dark: theme === 'dark' }).catch(() => undefined);
      }
    });
  }

  private read(): Theme {
    const stored = this.settings.get(SETTING_KEYS.theme);
    return stored === 'light' || stored === 'dark' ? stored : 'dark';
  }
}

/** Any CSS colour (the tokens are oklch) as #rrggbb, by letting a canvas resolve it. */
function asHex(colour: string): string | null {
  const canvas = document.createElement('canvas').getContext('2d');
  if (!canvas) {
    return null;
  }
  canvas.fillStyle = colour;
  canvas.fillRect(0, 0, 1, 1);
  const [red, green, blue] = canvas.getImageData(0, 0, 1, 1).data;
  return '#' + [red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('');
}
