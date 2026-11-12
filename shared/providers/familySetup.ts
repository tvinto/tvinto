import { tagged, untagged } from './providerRecord';

/**
 * What a manager hands a member when it sets them up from its own account:
 * its subscription, its guides, and the channels it
 * matched to guides by hand -- translated, because the member's ids are not
 * the manager's.
 *
 * Two ways a matched channel reaches the member:
 *
 * - Through a provider the manager shares with them. The member holds the
 *   same provider under a slot tag of its own, so the id is the same id under
 *   that tag, exactly.
 * - By name, for channels of providers that are not shared. The member's own
 *   subscription calls the channel what the manager's does, usually; the
 *   member's device matches names when it has its catalogue, and only where
 *   one name means one channel -- a guess on a duplicate is worse than none.
 */

/** A channel matched to a guide, as the guide sources service keeps one. */
export interface HeldMapping {
  streamId: string;
  sourceId: string;
  channelId: string;
}

/** A match to make by name on the member's side. */
export interface MatchByName {
  name: string;
  sourceId: string;
  channelId: string;
}

/** The manager's slot tags shared with this member, and the member's tag for each. */
export type SharedSlots = ReadonlyMap<string, string>;

export interface TranslatedMappings {
  /** Ready to write under the member's ids. */
  direct: HeldMapping[];
  /** To match by name once the member's catalogue is at hand. */
  byName: MatchByName[];
}

export function translateMappings(
  mappings: readonly HeldMapping[],
  shared: SharedSlots,
  nameOf: (streamId: string) => string | undefined
): TranslatedMappings {
  const direct: HeldMapping[] = [];
  const byName: MatchByName[] = [];

  for (const mapping of mappings) {
    const { tag, id } = untagged(mapping.streamId);
    const theirs = shared.get(tag);
    if (theirs !== undefined) {
      direct.push({ ...mapping, streamId: tagged(theirs, id) });
      continue;
    }
    const name = nameOf(mapping.streamId)?.trim();
    if (name) {
      byName.push({ name, sourceId: mapping.sourceId, channelId: mapping.channelId });
    }
  }

  return { direct, byName };
}

const nameKey = (name: string): string => name.trim().toLocaleLowerCase();

/**
 * The matches a member's device can make by name: one per channel whose name
 * appears exactly once in its catalogue and once in what it was handed, and
 * that it has not matched itself.
 */
export function resolveByName(
  pending: readonly MatchByName[],
  streams: ReadonlyArray<{ id: string; name: string }>,
  alreadyMatched: ReadonlySet<string>
): HeldMapping[] {
  const byName = new Map<string, string[]>();
  for (const stream of streams) {
    const key = nameKey(stream.name ?? '');
    if (key) {
      byName.set(key, [...(byName.get(key) ?? []), stream.id]);
    }
  }

  const asked = new Map<string, number>();
  for (const match of pending) {
    asked.set(nameKey(match.name), (asked.get(nameKey(match.name)) ?? 0) + 1);
  }

  const resolved: HeldMapping[] = [];
  for (const match of pending) {
    const key = nameKey(match.name);
    const ids = byName.get(key) ?? [];
    if (ids.length !== 1 || asked.get(key) !== 1 || alreadyMatched.has(ids[0])) {
      continue;
    }
    resolved.push({ streamId: ids[0], sourceId: match.sourceId, channelId: match.channelId });
  }
  return resolved;
}

/**
 * What a manager keeps in step for one member, held in the manager's own
 * settings (`familyLinks`) so every device of the manager's does it.
 */
export interface FamilyLink {
  /** The manager's provider row ids shared with the member, and the member's tag for each. */
  providers: Record<string, string>;
  /** Whether the member's guides are the manager's, kept in step. */
  guides: boolean;
  /** What was last handed over, so it is handed over again only when it changed. */
  handed?: Record<string, string>;
}

export type FamilyLinks = Record<string, FamilyLink>;

export function readFamilyLinks(raw: string | null | undefined): FamilyLinks {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const links: FamilyLinks = {};
    for (const [member, value] of Object.entries(parsed as Record<string, Partial<FamilyLink>>)) {
      if (!/^\d+$/.test(member) || !value || typeof value !== 'object') {
        continue;
      }
      const providers: Record<string, string> = {};
      for (const [id, tag] of Object.entries(value.providers ?? {})) {
        if (typeof tag === 'string') {
          providers[id] = tag;
        }
      }
      links[member] = {
        providers,
        guides: value.guides === true,
        handed: value.handed && typeof value.handed === 'object' ? { ...value.handed } : {}
      };
    }
    return links;
  } catch {
    return {};
  }
}

/** A short fingerprint of what is handed over, for telling whether it changed. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
