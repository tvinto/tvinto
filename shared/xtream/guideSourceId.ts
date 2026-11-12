/**
 * Naming a guide source without writing down how to fetch it.
 *
 * The store keys everything by source id, so whatever that id is ends up in
 * the device's database, in its indexes, and in any log line that mentions a
 * load. Using the URL itself would therefore write
 * `xmltv.php?username=...&password=...` into all three -- and an Xtream guide
 * URL is a credential, which is why the synced copy is encrypted.
 *
 * A hash of the URL is as stable as the URL is: reloading the same feed
 * replaces what it wrote last time rather than accumulating a second copy,
 * which is the only property the id actually needs.
 *
 * Not a security boundary. Anyone holding a candidate URL can hash it and
 * compare; the point is that the id does not *carry* the credential, so it can
 * be shown, logged and stored without care.
 */

/**
 * FNV-1a, 32-bit, written as an unsigned hex string.
 *
 * Chosen because it is a few lines and synchronous. The cryptographic hashes
 * available in these runtimes are all asynchronous, which would make naming a
 * source an awaited call in every place that mentions one, for a property
 * nothing here needs.
 */
export const fnv1aHex = (text: string): string => {
  const trimmed = text.trim();

  let hash = 0x811c9dc5;
  for (let index = 0; index < trimmed.length; index += 1) {
    hash ^= trimmed.charCodeAt(index);
    // The FNV prime, by shift and add: a plain multiply overflows into the
    // floating-point range and loses the low bits that matter here.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
};

export const guideSourceId = (url: string): string => `src-${fnv1aHex(url)}`;

/**
 * Naming a subscription without writing down how to use it.
 *
 * The same problem one step over. The sync service keys subscriptions by an id
 * so that renewing credentials updates a row rather than adding a second one,
 * and it cannot work that id out for itself: the address, the provider
 * username and the password are all inside the ciphertext, and it holds no key
 * to any of it.
 *
 * So the device names it, from the two parts that identify a line without
 * being able to open it. The password is deliberately not in the hash -- a
 * renewal is the same subscription with a new password, and an id that changed
 * with it would leave the old row behind on every renewal.
 */
export const subscriptionId = (serverUrl: string, username: string): string =>
  `sub-${fnv1aHex(`${serverUrl.trim().replace(/\/+$/, '')}|${username.trim()}`)}`;
