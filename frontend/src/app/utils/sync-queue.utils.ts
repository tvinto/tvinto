import {
  ArrangementChange,
  ChangeSet,
  ChannelMappingChange,
  FavouriteChange,
  GuideSourceChange,
  ProgressChange,
  Tombstone,
  emptyChangeSet
} from '@shared/sync';
import { accountStorageKey } from './account-storage.utils';

/**
 * The two decisions a move to a different server turns on.
 *
 * Both live here rather than inside the services that use them because both
 * are silent when wrong. A cursor scoped to the wrong thing loses an account's
 * entire history without failing; a queue rebuilt incompletely loses whichever
 * kind was forgotten. Neither shows up as an error, on either end.
 */

/**
 * Where a device remembers how far a particular server has got.
 *
 * Scoped to the server as well as the account. A cursor means "everything up
 * to here has reached that service", and pointing the app somewhere else makes
 * it a claim about a different place -- the device would ask a service that had
 * never heard of it for changes since last Tuesday, be told there were none,
 * and never send it anything.
 *
 * The address is hashed rather than spelled out because it can carry a port, a
 * path and a subdomain, and because a storage key is easier to read when the
 * parts of it are the same length.
 */
export const syncCursorKey = (
  prefix: string,
  username: string | null | undefined,
  apiUrl: string,
  hash: (text: string) => string
): string => `${accountStorageKey(prefix, username)}:${hash(apiUrl)}`;

/** Everything a device holds that belongs to the account rather than to it. */
export interface HeldData {
  favourites: FavouriteChange[];
  progress: ProgressChange[];
  arrangements: ArrangementChange[];
  tombstones: Tombstone[];
  /** Already sealed, since only the service that owns them can do that. */
  guideSources: GuideSourceChange[];
  channelMappings: ChannelMappingChange[];
}

/**
 * Everything held, as a batch to send.
 *
 * For a server that has never heard of this device. The queue normally carries
 * only what has not been sent, which is right until the thing it was sent to
 * stops being the thing being talked to -- then the queue is empty and the
 * local copy is the only record of years of starring and watching.
 *
 * Built from what is held rather than added to what is queued, which is what
 * makes running it twice the same as running it once. Nothing is lost by that:
 * a change waiting in the queue is also in the state it was written to, which
 * is what the screen has been drawn from all along.
 */
export const changeSetFrom = (held: Partial<HeldData>): ChangeSet => ({
  ...emptyChangeSet(),
  favourites: [...(held.favourites ?? [])],
  progress: [...(held.progress ?? [])],
  arrangements: [...(held.arrangements ?? [])],
  deletions: [...(held.tombstones ?? [])],
  guideSources: [...(held.guideSources ?? [])],
  channelMappings: [...(held.channelMappings ?? [])]
});
