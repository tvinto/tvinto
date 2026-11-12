import { Category, CategorySort, Stream, StreamSort, StreamType } from '../types';

/**
 * How lists are ordered, as pure functions over what is already in hand.
 *
 * Lifted out of the backend for the same reason the protocol was: a device that
 * fetches its own catalogue has to arrange it too, and an arrangement that
 * disagreed between the phone and the laptop would look like the setting had
 * stopped working. The rule lives here once and both sides call it.
 *
 * A manual arrangement arrives as a list of ids rather than being looked up,
 * because where it is kept differs -- a table on the server, the change feed on
 * a device -- and neither belongs in the sorting.
 */

/** The key an arrangement of categories is stored under. */
export function categoryScope(type: StreamType): string {
  return `category:${type}`;
}

/** The key an arrangement of one category's streams is stored under. */
export function streamScope(type: StreamType, categoryId: string): string {
  return `stream:${type}:${categoryId}`;
}

/** How this device last chose a list's sort, if it ever did. */
export interface SortChoice<S extends string> {
  sort: S | null;
  /** When it was chosen; null for a choice made before that was recorded. */
  at: string | null;
}

/**
 * The sort a list is drawn with: the device's own choice, or the account's
 * arrangement when that is the more recent decision.
 *
 * The sort is the device's (DEVICE_ONLY_SETTINGS) and the arrangement the
 * account's, so arranging a family member's categories in their setup on
 * the admin's desktop reached their account and was never used there: their
 * television still sorted by name (8 October). Now a device that
 * never chose a sort, or chose one before the list was last arranged
 * anywhere, follows the arrangement. A choice older than its own timestamp
 * keeps itself, so no device that had settled on a sort is moved by an old
 * arrangement it had already turned away from.
 *
 * A sort chosen in their setup is the account's decision in the same way
 * (`setUp`): the admin who picked "Channel number" for them saw it saved and
 * their devices go on sorting by name otherwise (9 October). Of
 * the account's two decisions the later counts.
 */
export function sortToUse<S extends string>(
  choice: SortChoice<S>,
  arrangedAt: string | null,
  fallback: S,
  setUp: SortChoice<S | 'manual'> = { sort: null, at: null }
): S | 'manual' {
  const decided: SortChoice<S | 'manual'> =
    setUp.sort && setUp.at && !(arrangedAt && arrangedAt > setUp.at) ? setUp : { sort: arrangedAt ? 'manual' : null, at: arrangedAt };
  if (decided.sort && decided.at && (choice.sort === null || (choice.at !== null && decided.at > choice.at))) {
    return decided.sort;
  }
  return choice.sort ?? fallback;
}

/** A `SortChoice` kept as JSON, or no choice when it is missing or unreadable. */
export function readSortChoice<S extends string>(text: string | null, sorts: readonly S[]): SortChoice<S> {
  try {
    const parsed = JSON.parse(text ?? 'null') as { sort?: unknown; at?: unknown } | null;
    const sort = sorts.find(known => known === parsed?.sort) ?? null;
    return sort && typeof parsed?.at === 'string' ? { sort, at: parsed.at } : { sort: null, at: null };
  } catch {
    return { sort: null, at: null };
  }
}

/** Case-insensitive, digit-aware compare so "Channel 2" precedes "Channel 10". */
export function compareNames(a: unknown, b: unknown): number {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

export function sortCategories(
  categories: Category[],
  sort: CategorySort,
  manualOrder: string[] = []
): Category[] {
  const sorted = [...categories];

  switch (sort) {
    case 'name_desc':
      return sorted.sort((a, b) => compareNames(b.category_name, a.category_name));
    case 'manual':
      return applyManualOrder(sorted, manualOrder, c => String(c.category_id));
    case 'name_asc':
    default:
      return sorted.sort((a, b) => compareNames(a.category_name, b.category_name));
  }
}

export function sortStreams(
  streams: Stream[],
  sort: StreamSort,
  manualOrder: string[] = []
): Stream[] {
  const sorted = [...streams];

  switch (sort) {
    case 'name_desc':
      return sorted.sort((a, b) => compareNames(b.name, a.name));
    case 'number':
      // Channels without a number sink to the bottom rather than colliding at zero.
      return sorted.sort((a, b) => {
        const an = channelNumber(a);
        const bn = channelNumber(b);
        if (an === null && bn === null) return compareNames(a.name, b.name);
        if (an === null) return 1;
        if (bn === null) return -1;
        return an - bn;
      });
    case 'added_desc':
      return sorted.sort((a, b) => toEpoch(b.added) - toEpoch(a.added));
    case 'added_asc':
      return sorted.sort((a, b) => toEpoch(a.added) - toEpoch(b.added));
    case 'manual':
      // No arrangement to apply -- a favourites list, or a search -- so fall
      // back to something stable rather than to whatever order arrived.
      if (manualOrder.length === 0) {
        return sorted.sort((a, b) => compareNames(a.name, b.name));
      }
      return applyManualOrder(sorted, manualOrder, s => String(s.stream_id));
    case 'closest':
      // Closeness needs the query, which only the screen that ran the search
      // has (`byCloseness`). Here it is name order, so a preference left on
      // `closest` while browsing a category is still something sensible.
      return sorted.sort((a, b) => compareNames(a.name, b.name));
    case 'name_asc':
    default:
      return sorted.sort((a, b) => compareNames(a.name, b.name));
  }
}

/**
 * Orders items by a saved arrangement.
 *
 * Anything the user has not placed -- typically added by a later sync -- keeps
 * its natural order and follows the arranged items, so new content is visible
 * rather than silently dropped.
 */
export function applyManualOrder<T>(
  items: T[],
  savedIds: string[],
  idOf: (item: T) => string
): T[] {
  if (savedIds.length === 0) {
    return items;
  }

  const rank = new Map(savedIds.map((id, index) => [id, index]));
  const placed: T[] = [];
  const unplaced: T[] = [];

  for (const item of items) {
    (rank.has(idOf(item)) ? placed : unplaced).push(item);
  }

  placed.sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
  return [...placed, ...unplaced];
}

/**
 * The provider's channel number, which is not on the Stream type.
 *
 * Xtream sends `num` on live channels and mostly omits it elsewhere, so it is
 * read off the object rather than declared -- declaring it would suggest every
 * stream has one.
 */
function channelNumber(stream: Stream): number | null {
  return toNumberOrNull((stream as unknown as Record<string, unknown>)['num']);
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Xtream reports `added` as a unix seconds string. */
function toEpoch(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
