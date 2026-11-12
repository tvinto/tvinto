import { Injectable, signal } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeHr from '@angular/common/locales/hr';
import localeEnGb from '@angular/common/locales/en-GB';
import localeBs from '@angular/common/locales/bs';
import localeSr from '@angular/common/locales/sr-Latn';
import localeSl from '@angular/common/locales/sl';
import localeMk from '@angular/common/locales/mk';
import localeSq from '@angular/common/locales/sq';
import localeDe from '@angular/common/locales/de';
import localeEs from '@angular/common/locales/es';
import localeFr from '@angular/common/locales/fr';
import localeIt from '@angular/common/locales/it';
import localeNl from '@angular/common/locales/nl';
import localePl from '@angular/common/locales/pl';
import localePt from '@angular/common/locales/pt';
import localeRu from '@angular/common/locales/ru';
import localeTr from '@angular/common/locales/tr';
import { bindLanguageTracking, Language, LANGUAGES, loadLanguage, setCurrentLanguage } from '../utils/i18n';

const KEY = 'xtream.language';

/** Angular's name for each language's dates (formatDate, the tdate pipe). Its "pt" is Brazil's. */
const ANGULAR_LOCALES: Record<Language, string> = {
  en: 'en-GB',
  hr: 'hr',
  bs: 'bs',
  sr: 'sr-Latn',
  sl: 'sl',
  mk: 'mk',
  sq: 'sq',
  de: 'de',
  es: 'es',
  fr: 'fr',
  it: 'it',
  nl: 'nl',
  pl: 'pl',
  pt: 'pt',
  ru: 'ru',
  tr: 'tr'
};

registerLocaleData(localeEnGb, 'en-GB');
registerLocaleData(localeHr, 'hr');
registerLocaleData(localeBs, 'bs');
registerLocaleData(localeSr, 'sr-Latn');
registerLocaleData(localeSl, 'sl');
registerLocaleData(localeMk, 'mk');
registerLocaleData(localeSq, 'sq');
registerLocaleData(localeDe, 'de');
registerLocaleData(localeEs, 'es');
registerLocaleData(localeFr, 'fr');
registerLocaleData(localeIt, 'it');
registerLocaleData(localeNl, 'nl');
registerLocaleData(localePl, 'pl');
registerLocaleData(localePt, 'pt');
registerLocaleData(localeRu, 'ru');
registerLocaleData(localeTr, 'tr');

/** Angular's locale for a language's dates. */
export const angularLocale = (language: Language): string => ANGULAR_LOCALES[language] ?? 'en-GB';

/**
 * The language this device shows the app in (26 September; fourteen more on
 * 11 November). Per device, like the display size. On first start it follows
 * the device -- a television set to German opens in German -- and from then
 * on what was chosen on Account. The native player is told with every film it
 * opens, and given its words in that language.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  readonly languages = LANGUAGES;
  private readonly language = signal<Language>('en');
  readonly current = this.language.asReadonly();
  private started: Promise<void> | null = null;

  constructor() {
    // Every `t` reads this signal, so whatever asked for words is asked again.
    bindLanguageTracking(() => this.language());
  }

  /**
   * Once, at start, before anything is drawn (an app initializer waits for
   * it): a language not in the main bundle is read first, so the first screen
   * is not drawn in English and then again.
   */
  init(): Promise<void> {
    this.started ??= this.apply(stored() ?? fromDevice());
    return this.started;
  }

  choose(language: Language): Promise<void> {
    try {
      localStorage.setItem(KEY, language);
    } catch {
      // For this run only.
    }
    return this.apply(language);
  }

  private async apply(language: Language): Promise<void> {
    // A file that could not be read leaves the app in English rather than blank.
    const usable = (await loadLanguage(language)) ? language : 'en';
    setCurrentLanguage(usable);
    this.language.set(usable);
    document.documentElement.setAttribute('lang', usable);
  }
}

const isLanguage = (value: string | null | undefined): value is Language =>
  LANGUAGES.some(language => language.id === value);

const stored = (): Language | null => {
  try {
    const value = localStorage.getItem(KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * The first of the device's languages the app speaks. Serbian in either
 * script, and Serbo-Croatian, open in Serbian (Latin); any Portuguese in
 * Brazil's; anything else unknown in English.
 */
export function languageFor(deviceLanguages: readonly (string | null | undefined)[]): Language {
  for (const tag of deviceLanguages) {
    const base = (tag ?? '').toLowerCase().split(/[-_]/)[0];
    if (base === 'sh') {
      return 'sr';
    }
    if (isLanguage(base)) {
      return base;
    }
  }
  return 'en';
}

const fromDevice = (): Language =>
  languageFor(typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language]);
