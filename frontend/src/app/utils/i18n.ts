import en from '../i18n/en.json';
import hr from '../i18n/hr.json';

/**
 * The app's words, in the language chosen for this device.
 *
 * The shape follows GPSya and MeteoDrive -- one JSON file per language, keys
 * grouped by screen -- with two differences, both for this app's sake:
 *
 * - **Shipped with the app, not fetched.** The web code runs from the APK,
 *   from a bundle downloaded over the air, and from Electron's own scheme.
 *   English and Croatian are in the main bundle; every other language is a
 *   chunk of its own beside it, loaded once chosen (`loadLanguage`), so
 *   fourteen languages nobody on this device reads cost it nothing.
 * - **A function as well as a pipe.** Much of what the app says is put
 *   together in plain TypeScript -- "28 min left", why a film would not play
 *   -- which runs in tests with no Angular at all. `t()` works there, in
 *   English, with nothing set up.
 *
 * Plurals by the language's own rules: English has one and other, Croatian
 * one, few and other (1 kanal, 2 kanala, 5 kanala), Russian and Polish a
 * "many" too. A key whose value is an object of those forms is chosen between
 * by `count` (i18n.spec.ts checks each language has every form it needs).
 */

export type Language =
  | 'en'
  | 'hr'
  | 'de'
  | 'es'
  | 'fr'
  | 'it'
  | 'tr'
  | 'nl'
  | 'bs'
  | 'sr'
  | 'sl'
  | 'mk'
  | 'sq'
  | 'pl'
  | 'pt'
  | 'ru';

export interface LanguageChoice {
  id: Language;
  /** Its name in itself, so somebody who cannot read the language in use can find theirs. */
  label: string;
  /** How dates and numbers are written in it (Intl, and Angular's locale data). */
  locale: string;
}

export const LANGUAGES: readonly LanguageChoice[] = [
  { id: 'en', label: 'English', locale: 'en-GB' },
  { id: 'hr', label: 'Hrvatski', locale: 'hr-HR' },
  { id: 'bs', label: 'Bosanski', locale: 'bs-BA' },
  { id: 'sr', label: 'Srpski (latinica)', locale: 'sr-Latn-RS' },
  { id: 'sl', label: 'Slovenščina', locale: 'sl-SI' },
  { id: 'mk', label: 'Македонски', locale: 'mk-MK' },
  { id: 'sq', label: 'Shqip', locale: 'sq-AL' },
  { id: 'de', label: 'Deutsch', locale: 'de-DE' },
  { id: 'es', label: 'Español', locale: 'es-ES' },
  { id: 'fr', label: 'Français', locale: 'fr-FR' },
  { id: 'it', label: 'Italiano', locale: 'it-IT' },
  { id: 'nl', label: 'Nederlands', locale: 'nl-NL' },
  { id: 'pl', label: 'Polski', locale: 'pl-PL' },
  { id: 'pt', label: 'Português (Brasil)', locale: 'pt-BR' },
  { id: 'ru', label: 'Русский', locale: 'ru-RU' },
  { id: 'tr', label: 'Türkçe', locale: 'tr-TR' }
];

type Entry = string | { [key: string]: Entry };
type Dictionary = { [key: string]: Entry };

/** The languages that ship in the main bundle; the rest arrive through `loadLanguage`. */
const DICTIONARIES: Partial<Record<Language, Dictionary>> = { en, hr };

/** Each other language's file, as a chunk of its own. Explicit paths, so the bundler makes one per file. */
const LOADERS: Partial<Record<Language, () => Promise<{ default: Dictionary }>>> = {
  bs: () => import('../i18n/bs.json'),
  sr: () => import('../i18n/sr.json'),
  sl: () => import('../i18n/sl.json'),
  mk: () => import('../i18n/mk.json'),
  sq: () => import('../i18n/sq.json'),
  de: () => import('../i18n/de.json'),
  es: () => import('../i18n/es.json'),
  fr: () => import('../i18n/fr.json'),
  it: () => import('../i18n/it.json'),
  nl: () => import('../i18n/nl.json'),
  pl: () => import('../i18n/pl.json'),
  pt: () => import('../i18n/pt.json'),
  ru: () => import('../i18n/ru.json'),
  tr: () => import('../i18n/tr.json')
};

/** Makes a language's words available, loading its file if it is not in the bundle. False when it could not be read. */
export async function loadLanguage(language: Language): Promise<boolean> {
  if (DICTIONARIES[language]) {
    return true;
  }
  try {
    const loaded = await LOADERS[language]?.();
    if (!loaded) {
      return false;
    }
    DICTIONARIES[language] = loaded.default;
    return true;
  } catch {
    return false;
  }
}

/** For tests: puts a language's words in place without the bundler's chunks. */
export function provideDictionary(language: Language, dictionary: Dictionary): void {
  DICTIONARIES[language] = dictionary;
}

let current: Language = 'en';

/**
 * Called on every read of the language. Plain TypeScript here, so the tests of
 * everything that uses `t` need no Angular; the app plugs in a signal read
 * (LanguageService), which is what makes a computed or a template that asked
 * for words ask again when the language changes.
 */
let track: () => void = () => undefined;

export function bindLanguageTracking(read: () => void): void {
  track = read;
}

/** The language in use, noted as read. */
export function currentLanguage(): Language {
  track();
  return current;
}

export function setCurrentLanguage(language: Language): void {
  current = language;
}

export type Params = Record<string, string | number | null | undefined>;

/**
 * The text for a key, with `{{name}}` filled from `params`.
 *
 * Falls back to English for a key Croatian does not have yet, and to the key
 * itself when neither does -- visible, so a missing word is found by looking
 * rather than by a blank.
 */
export function t(key: string, params?: Params): string {
  const language = currentLanguage();
  const count = typeof params?.['count'] === 'number' ? (params['count'] as number) : null;
  const found = pick(DICTIONARIES[language], key, language, count) ?? pick(DICTIONARIES.en, key, 'en', count) ?? key;
  return fill(found, params);
}

/** Whether a key exists in English, which every key must. For tests. */
export function hasKey(key: string): boolean {
  return lookup(DICTIONARIES.en ?? {}, key) !== undefined;
}

const pluralRules = new Map<Language, Intl.PluralRules>();

function pick(dictionary: Dictionary | undefined, key: string, language: Language, count: number | null): string | null {
  if (!dictionary) {
    return null;
  }
  const entry = lookup(dictionary, key);
  if (typeof entry === 'string') {
    return entry;
  }
  if (entry && count !== null) {
    let rules = pluralRules.get(language);
    if (!rules) {
      rules = new Intl.PluralRules(localeOf(language));
      pluralRules.set(language, rules);
    }
    const form = entry[rules.select(count)] ?? entry['other'];
    return typeof form === 'string' ? form : null;
  }
  return null;
}

function lookup(dictionary: Dictionary, key: string): Entry | undefined {
  let at: Entry | undefined = dictionary;
  for (const part of key.split('.')) {
    if (!at || typeof at === 'string') {
      return undefined;
    }
    at = at[part];
  }
  return at;
}

function fill(text: string, params?: Params): string {
  if (!params) {
    return text;
  }
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
    const value = params[name];
    if (typeof value === 'number') {
      // 1,234 in English, 1.234 in Croatian. Small whole numbers -- an
      // episode, a percentage -- come out the same either way.
      // Grouped only from five digits, so a year stays 2024 rather than 2,024.
      return numberFormat(Math.abs(value) >= 10_000).format(value);
    }
    return value === null || value === undefined ? '' : String(value);
  });
}

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(grouped: boolean): Intl.NumberFormat {
  const language = currentLanguage();
  const key = `${language}:${grouped}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(localeOf(language), {
      maximumFractionDigits: 1,
      useGrouping: grouped
    });
    numberFormats.set(key, format);
  }
  return format;
}

/** The locale dates and numbers are written in: "Saturday 26 September", "subota, 26. rujna". */
export function locale(): string {
  return localeOf(currentLanguage());
}

/** A language's locale, for Intl. */
export function localeOf(language: Language): string {
  return LANGUAGES.find(choice => choice.id === language)?.locale ?? 'en-GB';
}

/**
 * The native player's words in the language in use, flat by key --
 * "film.nextEpisode", "count.channels.few" -- English where it has none
 * (Texts.java on Android, which also knows English and Croatian itself).
 */
export function nativePlayerWords(): Record<string, string> {
  const language = currentLanguage();
  const out: Record<string, string> = {};
  const walk = (entry: Entry | undefined, path: string) => {
    if (typeof entry === 'string') {
      out[path] = entry;
    } else if (entry) {
      for (const [name, inner] of Object.entries(entry)) {
        walk(inner, path ? `${path}.${name}` : name);
      }
    }
  };
  walk(lookup(DICTIONARIES.en ?? {}, 'nativePlayer'), '');
  if (language !== 'en') {
    walk(lookup(DICTIONARIES[language] ?? {}, 'nativePlayer'), '');
  }
  return out;
}
