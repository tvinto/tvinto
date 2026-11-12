import { SETTING_KEYS } from '@shared/types';

/**
 * Preferences that stay on the device that set them.
 *
 * The theme and the two sort orders used to follow the account, so switching
 * the laptop to light turned the television light across the room. How a
 * screen looks belongs to that screen. What stays account-wide is what the
 * household built -- favourites, history, custom order, guide choices -- and
 * how playback looks and sounds.
 */
export const DEVICE_ONLY_SETTINGS: ReadonlySet<string> = new Set([
  SETTING_KEYS.theme,
  SETTING_KEYS.categorySort,
  SETTING_KEYS.streamSort,
  SETTING_KEYS.categorySortAt,
  SETTING_KEYS.streamSortAt
]);

/** The part of a set of preferences that travels with the account. */
export function accountSettings(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !DEVICE_ONLY_SETTINGS.has(key)));
}
