import { Category, Stream } from '../types';
import { nameWords } from '../xtream/channelNames';

/**
 * Where an account's things went when its provider was replaced.
 *
 * A user's case (29 September): a subscription runs out, a new provider
 * takes its place, and the guides, favourites and history built on the old
 * one should carry on. When the new provider runs the same panel, the ids are
 * the same and nothing needs doing. When they differ, this works out, by
 * name, which of the new provider's categories and channels each old one is.
 *
 * Cautious by design: an id moves only when exactly one candidate has the
 * name. A favourite left behind is visible and can be starred again; one
 * moved onto the wrong channel is believed.
 */

/** What is known of one library on one provider. Ids are the provider's own, untagged. */
export interface LibraryListing {
  categories: Category[];
  /** Each with its `category_id` where known -- history and favourites carry none. */
  streams: Stream[];
}

/** Old id to new id, for the ids that changed and could be found. */
export interface IdMoves {
  categories: Map<string, string>;
  streams: Map<string, string>;
}

/** A category name as compared: case, spacing and punctuation aside. */
const categoryKey = (name: string): string =>
  name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ');

/** A channel or film name as compared: its identifying words (see `nameWords`). */
const streamKey = (name: string): string => nameWords(name).join(' ');

const grouped = <T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key) {
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
  }
  return groups;
};

export function idMoves(before: LibraryListing, after: LibraryListing): IdMoves {
  const categories = new Map<string, string>();
  const streams = new Map<string, string>();

  const newCategoryIds = new Set(after.categories.map(category => String(category.category_id)));
  const newCategoriesByName = grouped(after.categories, category => categoryKey(category.category_name ?? ''));

  for (const old of before.categories) {
    const id = String(old.category_id);
    if (newCategoryIds.has(id)) {
      continue;
    }
    const candidates = newCategoriesByName.get(categoryKey(old.category_name ?? '')) ?? [];
    if (candidates.length === 1) {
      categories.set(id, String(candidates[0].category_id));
    }
  }

  const newStreamIds = new Set(after.streams.map(stream => String(stream.stream_id)));
  const newStreamsByName = grouped(after.streams, stream => streamKey(stream.name ?? ''));

  for (const old of before.streams) {
    const id = String(old.stream_id);
    if (newStreamIds.has(id)) {
      continue;
    }
    let candidates = newStreamsByName.get(streamKey(old.name ?? '')) ?? [];
    // Several of that name -- the same channel in an HD and an SD category,
    // or in two countries' lists -- are told apart by where the old one was.
    if (candidates.length > 1 && old.category_id !== undefined && old.category_id !== null) {
      const oldCategory = String(old.category_id);
      const category = categories.get(oldCategory) ?? oldCategory;
      candidates = candidates.filter(candidate => String(candidate.category_id) === category);
    }
    if (candidates.length === 1) {
      streams.set(id, String(candidates[0].stream_id));
    }
  }

  return { categories, streams };
}

/** An arrangement's scope with its category moved (`stream:live:123`), or the same scope. */
export function movedScope(scope: string, categories: ReadonlyMap<string, string>): string {
  const match = scope.match(/^(stream:[a-z]+:)(.+)$/);
  if (!match) {
    return scope;
  }
  const moved = categories.get(match[2]);
  return moved ? `${match[1]}${moved}` : scope;
}
