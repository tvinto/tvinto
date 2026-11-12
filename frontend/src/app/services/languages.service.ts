import { Injectable, computed, effect, inject } from '@angular/core';
import { SETTING_KEYS } from '@shared/types';
import { readLanguages, writeLanguages } from '@shared/languages';
import { SettingsService } from './settings.service';
import { currentLanguage } from '../utils/i18n';
import { preferredLanguages, setPreferredLanguages } from '../utils/languages';

/**
 * Your languages (Account, Playback): the order copies and trailers are
 * offered in, an account setting. Keeps `preferredLanguages()` in step with
 * it, for the code that orders copies without injecting anything.
 */
@Injectable({ providedIn: 'root' })
export class LanguagesService {
  private readonly settings = inject(SettingsService);

  /** Whether the person has chosen, rather than taking the default. */
  readonly chosen = computed(() => !!this.settings.get(SETTING_KEYS.languages));

  readonly languages = computed(() => {
    const raw = this.settings.get(SETTING_KEYS.languages);
    return raw ? readLanguages(raw, currentLanguage()) : preferredLanguages();
  });

  constructor() {
    effect(() => {
      const raw = this.settings.get(SETTING_KEYS.languages);
      setPreferredLanguages(raw ? readLanguages(raw, currentLanguage()) : null);
    });
  }

  save(list: string[]): void {
    this.settings.set(SETTING_KEYS.languages, writeLanguages(list));
  }
}
