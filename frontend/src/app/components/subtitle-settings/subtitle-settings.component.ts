import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { ChoiceChipsComponent } from '../../ui/choice-chips.component';
import { ChoicePanelService } from '../../ui/choice-panel.service';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { t } from '../../utils/i18n';
import { PlayerPreferences, SUBTITLE_SCALES, SubtitleBackground, SubtitleEdge } from '@shared/player';
import { PlayerPreferencesService } from '../../services/player-preferences.service';
import { TPipe } from '../../pipes/t.pipe';

/** A language as the players are asked for it: an ISO 639 code, or empty for none in particular. */
interface LanguageChoice {
  code: string;
  name: string;
}

/**
 * The languages offered. The ones this provider's line-up carries, and the
 * few a viewer here is likely to want next; a free text field would take
 * codes nobody remembers.
 */
const LANGUAGES: readonly LanguageChoice[] = [
  { code: '', name: 'languages.any' },
  { code: 'hr', name: 'languages.hr' },
  { code: 'en', name: 'languages.en' },
  { code: 'sr', name: 'languages.sr' },
  { code: 'bs', name: 'languages.bs' },
  { code: 'sl', name: 'languages.sl' },
  { code: 'de', name: 'languages.de' },
  { code: 'it', name: 'languages.it' },
  { code: 'fr', name: 'languages.fr' },
  { code: 'es', name: 'languages.es' }
];

const COLOURS: readonly { value: string; name: string }[] = [
  { value: '#ffffff', name: 'subs.white' },
  { value: '#ffff00', name: 'subs.yellow' },
  { value: '#00ffff', name: 'subs.cyan' }
];

const BACKGROUNDS: readonly { value: SubtitleBackground; name: string }[] = [
  { value: 'none', name: 'subs.none' },
  { value: 'translucent', name: 'subs.translucent' },
  { value: 'solid', name: 'subs.solid' }
];

const EDGES: readonly { value: SubtitleEdge; name: string }[] = [
  { value: 'none', name: 'subs.none' },
  { value: 'outline', name: 'subs.outline' },
  { value: 'shadow', name: 'subs.shadow' }
];

/**
 * How subtitles look and when they come on, for every player on the account.
 *
 * The preferences always existed -- Media3, VLC and mpv all read them -- but
 * nothing could set them, so every device played with the defaults. They are
 * an account setting, so a choice made on the phone is how the television
 * opens too. A film's own remembered tracks still win over these for that film.
 */
@Component({
  selector: 'app-subtitle-settings',
  standalone: true,
  imports: [TPipe, HlmButton, ChoiceChipsComponent, SettingGroupComponent, SettingRowComponent],
  host: { class: 'contents' },
  templateUrl: './subtitle-settings.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SubtitleSettingsComponent {
  private readonly preferences = inject(PlayerPreferencesService);

  readonly current = this.preferences.preferences;

  readonly languages = LANGUAGES;
  readonly scales = SUBTITLE_SCALES;
  readonly colours = COLOURS;
  readonly backgrounds = BACKGROUNDS;
  readonly edges = EDGES;

  /** The sample line, drawn the way the players will draw it, near enough. */
  private readonly panels = inject(ChoicePanelService);

  /** Whether How subtitles look has its choices open under it. */
  readonly lookOpen = signal(false);

  readonly scaleChoices = computed(() => this.scales.map(scale => ({ value: scale, label: `${scale}%` })));
  readonly colourChoices = computed(() => this.colours.map(colour => ({ value: colour.value, label: t(colour.name) })));
  readonly backgroundChoices = computed(() => this.backgrounds.map(background => ({ value: background.value, label: t(background.name) })));
  readonly edgeChoices = computed(() => this.edges.map(edge => ({ value: edge.value, label: t(edge.name) })));

  /** "100% · White · Outline": what How subtitles look is set to. */
  readonly lookLine = computed(() => {
    const chosen = this.current();
    const colour = this.colours.find(one => one.value === chosen.subtitleColour);
    const edge = this.edges.find(one => one.value === chosen.subtitleEdge);
    return [`${chosen.subtitleScale}%`, colour ? t(colour.name) : chosen.subtitleColour, edge ? t(edge.name) : ''].filter(Boolean).join(' · ');
  });

  languageName(code: string): string {
    return t(this.languages.find(language => language.code === code)?.name ?? 'languages.any');
  }

  async chooseLanguage(key: 'subtitleLanguage' | 'audioLanguage'): Promise<void> {
    const title = t(key === 'subtitleLanguage' ? 'subs.subtitleLanguage' : 'subs.audioLanguage');
    const choices = this.languages.map(language => ({ value: language.code, label: t(language.name) }));
    const chosen = await this.panels.choose(title, choices, this.current()[key]);
    if (chosen) {
      this.set(key, chosen.value);
    }
  }

  readonly previewStyle = computed(() => {
    const chosen = this.current();
    const background =
      chosen.subtitleBackground === 'solid'
        ? '#000000'
        : chosen.subtitleBackground === 'translucent'
          ? 'rgba(0, 0, 0, 0.63)'
          : 'transparent';
    const shadow =
      chosen.subtitleEdge === 'outline'
        ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
        : chosen.subtitleEdge === 'shadow'
          ? '2px 2px 3px rgba(0, 0, 0, 0.9)'
          : 'none';
    return {
      color: chosen.subtitleColour,
      'background-color': background,
      'text-shadow': shadow,
      'font-size': `${(chosen.subtitleScale / 100) * 1.125}rem`
    };
  });

  set<K extends keyof PlayerPreferences>(key: K, value: PlayerPreferences[K]): void {
    this.preferences.update({ [key]: value } as Partial<PlayerPreferences>);
  }

  reset(): void {
    this.preferences.reset();
  }
}
