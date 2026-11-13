import { EPG_SHARE_COUNTRIES, suggestedCountry } from '@shared/xtream/epgShare';
import { currentLanguage, locale, localeOf } from './i18n';

/** A country's name in the language in use (Intl), or its English name where Intl has none. */
export function countryName(code: string): string {
  const here = locale();
  try {
    return new Intl.DisplayNames([here], { type: 'region' }).of(code) ?? EPG_SHARE_COUNTRIES[code]?.name ?? code;
  } catch {
    return EPG_SHARE_COUNTRIES[code]?.name ?? code;
  }
}

/** "EPG Share · Kroatien": a country's EPG Share guide, named in the language in use. */
export function epgShareName(code: string): string {
  return `EPG Share · ${countryName(code)}`;
}

/**
 * The country this device is in, as well as it says: on the desktop the one
 * the computer is set to, then the region of its locales
 * (`navigator.languages`), and without one the region of the app's language
 * (`hr-HR`). May be a country EPG Share has nothing for.
 */
export function deviceCountry(): string | null {
  const desktop = (globalThis as { xtreamDesktop?: { region?: string } }).xtreamDesktop?.region ?? '';
  const locales = [
    // As a locale, so it is read as a region like the rest.
    ...(/^[A-Za-z]{2}$/.test(desktop) ? [`und-${desktop}`] : []),
    ...(typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language])
  ];
  let formats: string | null = null;
  try {
    formats = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    // No Intl locale: the languages alone.
  }
  return suggestedCountry([...locales, ...(formats ? [formats] : [])], localeOf(currentLanguage()));
}
