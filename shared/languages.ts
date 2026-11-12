/**
 * The languages a person watches in, in order (SETTING_KEYS.languages):
 * which copy of a film or show comes first, which trailer opens first. An
 * account setting, so a choice made on the desktop holds on the television.
 * Unset, it is the app's language, then English.
 */

/** The languages offered: those the copy tags name (shared/tmdb/copies.ts), English and the app's first. */
export const LANGUAGE_CHOICES = [
  'hr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'cs', 'sk', 'sl', 'sq', 'mk', 'bg', 'ro', 'hu',
  'el', 'tr', 'ru', 'uk', 'sv', 'da', 'nb', 'fi', 'ar', 'fa', 'he', 'hi', 'ja', 'ko', 'zh'
] as const;

/** How many a person may put first; past three the order stops meaning anything. */
export const LANGUAGES_MAX = 3;

/** The order when nothing is chosen: the app's language, then English. */
export const defaultLanguages = (appLanguage: string): string[] => [...new Set([appLanguage, 'en'])];

/** The stored setting, read leniently: unknown codes dropped, duplicates once, at most three. */
export function readLanguages(raw: string | null | undefined, appLanguage: string): string[] {
  try {
    const parsed = JSON.parse(raw || 'null') as unknown;
    const list = Array.isArray(parsed)
      ? [...new Set(parsed.filter((code): code is string => typeof code === 'string' && (LANGUAGE_CHOICES as readonly string[]).includes(code)))].slice(0, LANGUAGES_MAX)
      : [];
    return list.length ? list : defaultLanguages(appLanguage);
  } catch {
    return defaultLanguages(appLanguage);
  }
}

/** The value to store; '' to go back to the default. */
export const writeLanguages = (list: readonly string[]): string => (list.length ? JSON.stringify(list.slice(0, LANGUAGES_MAX)) : '');
