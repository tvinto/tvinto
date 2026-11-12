/**
 * Which guides this device has ever finished loading, kept outside the guide store.
 *
 * Deliberately not in the store it describes. On the desktop the guides live in
 * IndexedDB, and Chromium deletes an IndexedDB database it believes is damaged
 * -- silently, leaving localStorage alone. A record kept in the same database
 * would vanish with the guides and could never say they had been there.
 *
 * Per device, never synced: whether this machine downloaded a guide is a fact
 * about this machine. Only presence is read; the time is kept for a person
 * looking at storage.
 */

const key = (sourceId: string): string => `xtream_guide_loaded_here:${sourceId}`;

/** Records that this device finished loading a guide. Does nothing if storage refuses. */
export const rememberLoadedHere = (sourceId: string): void => {
  try {
    if (localStorage.getItem(key(sourceId)) === null) {
      localStorage.setItem(key(sourceId), new Date().toISOString());
    }
  } catch {
    // Without the record a lost guide waits for a person to press Reload,
    // which is how it behaved before this existed. Worse, not wrong.
  }
};

/** Whether this device has ever finished loading the guide. */
export const wasLoadedHere = (sourceId: string): boolean => {
  try {
    return localStorage.getItem(key(sourceId)) !== null;
  } catch {
    return false;
  }
};
