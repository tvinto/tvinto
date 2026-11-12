import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { SETTING_KEYS } from '@shared/types';
import {
  CopyChoices,
  CopyKind,
  copyChoice,
  fromDeviceRecords,
  mergeCopyChoices,
  readCopyChoices,
  withCopyChoice,
  writeCopyChoices
} from '@shared/copyChoices';
import { SettingsService } from './settings.service';

/** Where this device kept the choices before the account did. */
const DEVICE_KEYS: Record<CopyKind, string> = { films: 'xtream_copy_choice', shows: 'xtream_show_copy_choice' };

/**
 * The copy chosen for each film and show (TV-28, TV-29), kept for the
 * account, so the television plays the copy chosen on the desktop. Choices
 * this device made before are carried over once the account's settings have
 * arrived -- under the account's own, so nothing newer is overwritten.
 */
@Injectable({ providedIn: 'root' })
export class CopyChoicesService {
  private readonly settings = inject(SettingsService);

  private readonly choices = computed<CopyChoices>(() =>
    mergeCopyChoices(readCopyChoices(this.settings.get(SETTING_KEYS.copyChoices)), deviceChoices())
  );

  constructor() {
    effect(() => {
      if (this.settings.loaded()) {
        untracked(() => this.carryOver());
      }
    });
  }

  chosen(kind: CopyKind, key: string | number): string | null {
    return copyChoice(this.choices(), kind, String(key));
  }

  choose(kind: CopyKind, key: string | number, id: string | number): void {
    this.settings.set(SETTING_KEYS.copyChoices, writeCopyChoices(withCopyChoice(this.choices(), kind, String(key), String(id))));
  }

  private carryOver(): void {
    const device = deviceChoices();
    if (!device.films.length && !device.shows.length) {
      return;
    }
    this.settings.set(SETTING_KEYS.copyChoices, writeCopyChoices(this.choices()));
    try {
      localStorage.removeItem(DEVICE_KEYS.films);
      localStorage.removeItem(DEVICE_KEYS.shows);
    } catch {
      // Storage unavailable: carried over again next time, to the same result.
    }
  }
}

function deviceChoices(): CopyChoices {
  const read = (key: string): Record<string, string> => {
    try {
      const held = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown;
      return held && typeof held === 'object' ? (held as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  return fromDeviceRecords(read(DEVICE_KEYS.films), read(DEVICE_KEYS.shows));
}
