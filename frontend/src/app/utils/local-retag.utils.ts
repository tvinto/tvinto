import { tagged, untagged } from '@shared/providers/providerRecord';
import { accountStorageKey } from './account-storage.utils';

/**
 * Filing what a device kept under its providers' new tags.
 *
 * Signing in to sync can give one of the device's providers a different tag
 * on the account (bringProviders): its first, written without one, when the
 * account already has a first of its own. Every id the device filed under
 * the old tag -- favourites, history, arrangements, guide matches, reminders,
 * hidden and locked categories, the category each library was left on --
 * is rewritten to the new one before it is handed to the account, or the
 * device's favourites would point at the account's other provider.
 *
 * Each kind is rewritten by its own shape rather than by searching the text:
 * an untagged id is a bare number, and so is much else.
 */

/** Device tag to account tag. */
export type TagMoves = ReadonlyMap<string, string>;

export const retagId = (id: string | number, moves: TagMoves): string => {
  const parts = untagged(id);
  const to = moves.get(parts.tag);
  return to === undefined ? String(id) : tagged(to, parts.id);
};

const retagKeys = <T>(record: Record<string, T>, rename: (key: string) => string, change: (value: T) => T): Record<string, T> =>
  Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [rename(key), change(value)]));

/** `type:id` keys, as favourites and history are kept. */
const retagTypedKey = (key: string, moves: TagMoves): string => {
  const at = key.indexOf(':');
  return at < 0 ? key : `${key.slice(0, at + 1)}${retagId(key.slice(at + 1), moves)}`;
};

/** `category:type` stays; `stream:type:categoryId` has its category retagged. */
const retagScope = (scope: string, moves: TagMoves): string => {
  const parts = scope.split(':');
  return parts[0] === 'stream' && parts.length >= 3
    ? `${parts[0]}:${parts[1]}:${retagId(parts.slice(2).join(':'), moves)}`
    : scope;
};

interface Stored {
  favourites?: Record<string, { change: { streamId: string }; icon: string }>;
  progress?: Record<string, { itemId: string; seriesId: string | null }>;
  arrangements?: Record<string, { scope: string; itemIds: string[]; names?: Record<string, string> }>;
  tombstones?: Record<string, unknown>;
  pending?: unknown;
}

/** Favourites, history and arrangements (LocalUserDataService). */
export function retagLocalData(raw: string, moves: TagMoves): string {
  const state = JSON.parse(raw) as Stored;
  return JSON.stringify({
    ...state,
    favourites: retagKeys(state.favourites ?? {}, key => retagTypedKey(key, moves), entry => ({
      ...entry,
      change: { ...entry.change, streamId: retagId(entry.change.streamId, moves) }
    })),
    progress: retagKeys(state.progress ?? {}, key => retagTypedKey(key, moves), entry => ({
      ...entry,
      itemId: retagId(entry.itemId, moves),
      seriesId: entry.seriesId === null || entry.seriesId === undefined ? entry.seriesId : retagId(entry.seriesId, moves)
    })),
    arrangements: retagKeys(state.arrangements ?? {}, scope => retagScope(scope, moves), entry => ({
      ...entry,
      scope: retagScope(entry.scope, moves),
      itemIds: entry.itemIds.map(id => retagId(id, moves)),
      names: retagKeys(entry.names ?? {}, id => retagId(id, moves), name => name)
    })),
    // Deletions of things never on the account, and a queue the sign-in
    // rebuilds from the state anyway (requeueEverything).
    tombstones: {},
    pending: undefined
  });
}

/** Guide matches; the guides themselves are not filed by provider. */
export function retagGuideSources(raw: string, moves: TagMoves): string {
  const state = JSON.parse(raw) as { sources?: unknown[]; mappings?: Record<string, { streamId: string }> };
  return JSON.stringify({
    ...state,
    mappings: retagKeys(state.mappings ?? {}, id => retagId(id, moves), mapping => ({
      ...mapping,
      streamId: retagId(mapping.streamId, moves)
    }))
  });
}

export function retagReminders(raw: string, moves: TagMoves): string {
  const list = JSON.parse(raw) as { streamId: string }[];
  return JSON.stringify(Array.isArray(list) ? list.map(reminder => ({ ...reminder, streamId: retagId(reminder.streamId, moves) })) : list);
}

/** Hidden or locked categories, as the setting keeps them: ids by library. */
export function retagCategoryLists(raw: string, moves: TagMoves): string {
  const lists = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(lists ?? {}).map(([type, ids]) => [
        type,
        Array.isArray(ids) ? ids.map(id => retagId(String(id), moves)) : ids
      ])
    )
  );
}

/** The three drawers kept under a storage name, rewritten in place. */
export function retagDrawers(storage: Storage, name: string, moves: TagMoves): void {
  if (!moves.size) {
    return;
  }
  const rewrite = (key: string, change: (raw: string) => string) => {
    const raw = storage.getItem(key);
    if (raw === null) {
      return;
    }
    try {
      storage.setItem(key, change(raw));
    } catch {
      // Unreadable: left as it was, which is what it would have been anyway.
    }
  };
  rewrite(accountStorageKey('xtream_local_data', name), raw => retagLocalData(raw, moves));
  rewrite(accountStorageKey('xtream_guide_sources', name), raw => retagGuideSources(raw, moves));
  rewrite(accountStorageKey('xtream_reminders', name), raw => retagReminders(raw, moves));
}
