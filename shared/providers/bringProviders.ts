import { ProviderRecord, hostOf, newTag, recordId } from './providerRecord';

/**
 * A device's providers, taken into the account it signs in to.
 *
 * A device used without an account kept its providers itself; signing in to
 * sync hands them to the account. Into an account with none they go as they
 * are. Into one with providers of its own, the same subscription is not
 * doubled -- an Xtream login by its address and username, a playlist by its
 * address -- and the account's copy stands. A different one joins beside
 * them, under a tag of its own if the account already uses the device's:
 * the device's first provider, written without a tag, is always moved when
 * the account has providers, since favourites the account kept from a first
 * provider it removed are still filed under no tag.
 *
 * `moves` says which of the device's tags became which, so what the device
 * filed under them can follow (local-retag.utils.ts).
 */
export interface BroughtProviders {
  /** Every provider the account has now, its own first. */
  all: ProviderRecord[];
  /** The device's, as they join the account. */
  added: ProviderRecord[];
  /** Device tag to the tag it has on the account, for those that changed. */
  moves: Map<string, string>;
}

export function bringProviders(
  account: readonly ProviderRecord[],
  device: readonly ProviderRecord[],
  random: () => number = Math.random
): BroughtProviders {
  const all = [...account];
  const added: ProviderRecord[] = [];
  const moves = new Map<string, string>();

  for (const record of device) {
    const same = all.find(existing => sameProvider(existing, record));
    if (same) {
      if (same.tag !== record.tag) {
        moves.set(record.tag, same.tag);
      }
      continue;
    }
    const taken = all.map(existing => existing.tag);
    const keeps = account.length === 0 ? !taken.includes(record.tag) : record.tag !== '' && !taken.includes(record.tag);
    const tag = keeps ? record.tag : newTag([...taken, '', ...device.map(other => other.tag)], random);
    if (tag !== record.tag) {
      moves.set(record.tag, tag);
    }
    const joined = { ...record, tag };
    all.push(joined);
    added.push(joined);
  }

  return { all, added, moves };
}

/** Whether two records are one subscription: the same login, the same playlist, or the same box on the same portal. */
function sameProvider(a: ProviderRecord, b: ProviderRecord): boolean {
  if (a.kind === 'm3u' && b.kind === 'm3u') {
    return a.url.trim() === b.url.trim();
  }
  if (a.kind === 'stalker' && b.kind === 'stalker') {
    return hostOf(a.portalUrl) === hostOf(b.portalUrl) && a.mac.toUpperCase() === b.mac.toUpperCase();
  }
  return a.kind === 'xtream' && b.kind === 'xtream' && recordId(a) === recordId(b);
}
