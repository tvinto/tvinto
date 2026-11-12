/**
 * Which copy of a film or show was chosen to play (TV-28, TV-29), kept for
 * the account (SETTING_KEYS.copyChoices) so the copy chosen on the desktop is
 * the one the television plays. Films by their page's ref ("603", or
 * "s2169856" for a film TMDB does not know), shows by TMDB id; each to the
 * provider's stream or series id.
 *
 * Kept as ordered pairs, oldest first, not as an object: an object puts keys
 * that look like numbers -- TMDB ids -- in numeric order, and the oldest
 * could no longer be told from the newest.
 */

type Pairs = Array<[string, string]>;

export interface CopyChoices {
  films: Pairs;
  shows: Pairs;
}

export type CopyKind = keyof CopyChoices;

/** How many of each are kept: the latest, so the setting stays small. */
export const COPY_CHOICES_KEPT = 300;

const pairs = (value: unknown): Pairs =>
  (Array.isArray(value) ? value : [])
    .filter((pair): pair is [unknown, unknown] => Array.isArray(pair) && pair.length === 2)
    .filter(([key, id]) => typeof key === 'string' && (typeof id === 'string' || typeof id === 'number'))
    .map(([key, id]) => [String(key), String(id)]);

export function readCopyChoices(raw: string | null | undefined): CopyChoices {
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown> | null;
    return { films: pairs(parsed?.['films']), shows: pairs(parsed?.['shows']) };
  } catch {
    return { films: [], shows: [] };
  }
}

export const writeCopyChoices = (choices: CopyChoices): string => JSON.stringify(choices);

/** The copy chosen for a title, or null. */
export const copyChoice = (choices: CopyChoices, kind: CopyKind, key: string): string | null =>
  choices[kind].find(([had]) => had === key)?.[1] ?? null;

/** One choice made: latest last, the oldest dropped past the limit. */
export function withCopyChoice(choices: CopyChoices, kind: CopyKind, key: string, id: string): CopyChoices {
  const kept: Pairs = [...choices[kind].filter(([had]) => had !== key), [key, id]];
  return { ...choices, [kind]: kept.slice(-COPY_CHOICES_KEPT) };
}

/** Choices made on this device before they were kept for the account, under the account's. */
export function mergeCopyChoices(account: CopyChoices, device: CopyChoices): CopyChoices {
  const merge = (kind: CopyKind): Pairs => {
    const theirs = new Set(account[kind].map(([key]) => key));
    return [...device[kind].filter(([key]) => !theirs.has(key)), ...account[kind]].slice(-COPY_CHOICES_KEPT);
  };
  return { films: merge('films'), shows: merge('shows') };
}

/** The choices this device kept before (`xtream_copy_choice`, `xtream_show_copy_choice`), as pairs. */
export const fromDeviceRecords = (films: Record<string, string>, shows: Record<string, string>): CopyChoices => ({
  films: pairs(Object.entries(films)),
  shows: pairs(Object.entries(shows))
});
