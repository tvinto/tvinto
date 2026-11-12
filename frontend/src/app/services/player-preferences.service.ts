import { Injectable, computed, inject } from '@angular/core';
import { SETTING_KEYS } from '@shared/types';
import {
  DEFAULT_PLAYER_PREFERENCES,
  PlayerPreferences,
  readPlayerPreferences,
  writePlayerPreferences
} from '@shared/player';
import { SettingsService } from './settings.service';

/**
 * How playback should look and sound, for whichever player is running.
 *
 * A thin reading of one account setting, and thin on purpose: the model and its
 * parsing are shared with everything else that has to honour them, and this
 * only decides where the string is kept.
 *
 * Being an account setting is the point. Subtitle size set on the television
 * arrives on the phone through the same change feed that carries favourites --
 * the players cannot be shared across the four screens, but what you asked of
 * them can be.
 */
@Injectable({ providedIn: 'root' })
export class PlayerPreferencesService {
  private readonly settings = inject(SettingsService);

  /**
   * Recomputed when the stored value changes, including when a pull brings one
   * from another device, since SettingsService holds it in a signal.
   */
  readonly preferences = computed<PlayerPreferences>(() =>
    readPlayerPreferences(this.settings.get(SETTING_KEYS.player))
  );

  /** Changes some of them, leaving the rest as they were. */
  update(changes: Partial<PlayerPreferences>): void {
    const next: PlayerPreferences = { ...this.preferences(), ...changes };
    this.settings.set(SETTING_KEYS.player, writePlayerPreferences(next));
  }

  reset(): void {
    this.settings.set(SETTING_KEYS.player, writePlayerPreferences(DEFAULT_PLAYER_PREFERENCES));
  }
}
