import { signal } from '@angular/core';
import { defaultLanguages } from '@shared/languages';
import { currentLanguage } from './i18n';

/** The account's chosen order, or null for the default; kept in step by LanguagesService. */
const chosen = signal<string[] | null>(null);

/**
 * The languages a person watches in, first first: which copy comes first
 * and which trailer opens (SETTING_KEYS.languages). Unchosen, the app's
 * language, then English.
 */
export const preferredLanguages = (): string[] => chosen() ?? defaultLanguages(currentLanguage());

export const setPreferredLanguages = (list: string[] | null): void => chosen.set(list);
