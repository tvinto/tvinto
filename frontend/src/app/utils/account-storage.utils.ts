/**
 * Naming a device's own copy of an account, in a way that survives a move.
 *
 * It used to be named after the account's id, which is a number a server hands
 * out. That is fine while there is one server and wrong the moment there are
 * two: the same person is user 2 on one and user 1 on the next, so a device
 * that moved looked for its favourites under a name nothing had ever written
 * and found an empty drawer -- with no error anywhere, because an empty drawer
 * is what a new account looks like.
 *
 * The username is the part that is actually the person's. It is the same
 * string they type into both services, which is exactly the property wanted.
 */

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where this account's copy lives. */
export const accountStorageKey = (prefix: string, username: string | null | undefined): string => {
  const folded = (username ?? '').trim().toLowerCase();
  return `${prefix}:${folded || 'none'}`;
};

/**
 * Every key written by a build that named things after the account id.
 *
 * More than one is the ordinary case rather than the odd one, which is what
 * the first attempt at this got wrong. A device that had signed in to the new
 * service already had a drawer under the id that service assigned -- empty,
 * because nothing had been written to it yet -- sitting beside the full one
 * from the old service. Refusing to choose between them meant refusing to
 * migrate at all.
 *
 * So they are all returned, and the caller takes the first that actually holds
 * something. Only the caller knows what "holds something" means for what it
 * keeps.
 */
const idOf = (key: string): number => Number(key.slice(key.lastIndexOf(':') + 1));

export const legacyAccountKeys = (prefix: string, keys: readonly string[]): string[] => {
  const pattern = new RegExp(`^${escapeForPattern(prefix)}:\\d+$`);

  return keys.filter(key => pattern.test(key)).sort((a, b) => idOf(a) - idOf(b));
};

/**
 * The first legacy drawer with anything in it, and where it was.
 *
 * `hasContent` decides, because an empty drawer and a missing one mean the
 * same thing here and only the caller can tell them apart.
 *
 * The key comes back so the caller can clear it once it has copied the
 * contents. Leaving it behind sounds harmless and is not: signing out removes
 * the drawer it knows about, and the one it does not know about is adopted
 * straight back on the next read -- so the account would survive its own
 * deletion.
 */
export const adoptableLegacyValue = (
  prefix: string,
  keys: readonly string[],
  read: (key: string) => string | null,
  hasContent: (raw: string) => boolean
): { key: string; raw: string } | null => {
  for (const key of legacyAccountKeys(prefix, keys)) {
    const raw = read(key);
    if (!raw) {
      continue;
    }

    try {
      if (hasContent(raw)) {
        return { key, raw };
      }
    } catch {
      // A half-written drawer is one to walk past, not one to fail on. This
      // runs while the app is starting, and throwing here would stop it.
    }
  }

  return null;
};
