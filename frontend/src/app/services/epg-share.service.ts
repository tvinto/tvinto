import { Injectable, computed, inject, signal } from '@angular/core';
import { EpgShareSuggestion, epgShareCountries, epgShareFor } from '@shared/xtream/epgShare';
import { ChoicePanelService } from '../ui/choice-panel.service';
import { countryName, deviceCountry, epgShareName } from '../utils/epg-share.utils';
import { locale, t } from '../utils/i18n';

/**
 * The EPG Share guide suggested in onboarding and on the Guides page: for the
 * device's country (`deviceCountry`), or the one picked in the panel. Picked
 * for this launch only, and shared by both places, so a country chosen in
 * onboarding is the one the Guides page offers afterwards.
 */
@Injectable({ providedIn: 'root' })
export class EpgShareService {
  private readonly panels = inject(ChoicePanelService);

  readonly country = signal<string | null>(deviceCountry());

  /** Null when EPG Share has nothing for the country: then nothing is suggested. */
  readonly suggestion = computed<EpgShareSuggestion | null>(() => epgShareFor(this.country()));

  /** "EPG Share · Kroatien", in the language in use. */
  readonly name = computed(() => {
    const suggestion = this.suggestion();
    return suggestion ? epgShareName(suggestion.country) : null;
  });

  /** The countries in the panel, by name in the language in use. Resolves true when one was chosen. */
  async chooseCountry(): Promise<boolean> {
    const collator = new Intl.Collator(locale(), { sensitivity: 'base' });
    const choices = epgShareCountries()
      .map(code => ({ value: code, label: countryName(code) }))
      .sort((a, b) => collator.compare(a.label, b.label));
    const chosen = await this.panels.choose(t('guides.country'), choices, this.suggestion()?.country ?? null);
    if (chosen) {
      this.country.set(chosen.value);
    }
    return !!chosen;
  }
}
