/**
 * Sealing something so that only the device that made it can read it.
 *
 * The other half of `accountKeys.ts`. That splits the account password into a
 * key to send and a key to keep; this is what the key it keeps is for.
 *
 * What goes in a box: the subscription, and later the guide sources. Both are
 * credentials -- one obviously, the other less so, since an Xtream guide URL
 * is `xmltv.php?username=...&password=...` and does not look like a secret
 * until you read its query string. Both end up in a hosted database, and
 * neither should be readable there.
 *
 * The result is that a copy of that database is worth nothing. There is no
 * server-side key to steal alongside it, because there is no server-side key:
 * `enc` is derived from a password the service never sees.
 *
 * AES-256-GCM from SubtleCrypto, which every runtime this touches has. No
 * injected primitives here, unlike `accountKeys.ts` -- nothing needs scrypt,
 * and the one place with no scrypt is also the one place that never opens a
 * box.
 */

/** How the sealed form is spelled: `sb1$iv$ciphertext`, both base64. */
const VERSION = 'sb1';

/** GCM's nonce. Twelve bytes is the size the construction is defined for. */
const IV_BYTES = 12;

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A copy backed by an ArrayBuffer this array certainly owns.
 *
 * SubtleCrypto will not take a view that might be onto shared memory.
 */
const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);

/**
 * Deliberately unannotated, both of these.
 *
 * `SubtleCrypto`, `CryptoKey` and `KeyUsage` are DOM names, and this file is
 * compiled by the backend too, which has no DOM library. The types are the
 * same objects either way -- Node's webcrypto is the same interface under
 * different names -- so inference gives the right answer in all three places
 * where naming one would fail in one of them.
 */
const subtle = () => {
  const available = globalThis.crypto?.subtle;
  if (!available) {
    throw new Error('This build has no SubtleCrypto, so it cannot open the subscription');
  }
  return available;
};

const importKey = (key: Uint8Array, usage: 'encrypt' | 'decrypt') => {
  if (key.length !== 32) {
    throw new Error('A sealing key must be 32 bytes');
  }
  return subtle().importKey('raw', owned(key), 'AES-GCM', false, [usage]);
};

/** Bytes as base64, without Buffer, which the Worker and the WebView lack. */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array | null => {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

/**
 * Seals text under a key.
 *
 * A fresh nonce every time, which is not optional: GCM reused with the same
 * key and nonce on two different messages gives away the difference between
 * them and, worse, the ability to forge. Two seals of the same subscription
 * therefore look nothing alike, and that is correct rather than wasteful.
 */
export const seal = async (plaintext: string, key: Uint8Array): Promise<string> => {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);

  const sealed = await subtle().encrypt(
    { name: 'AES-GCM', iv },
    await importKey(key, 'encrypt'),
    utf8.encode(plaintext)
  );

  // The authentication tag is on the end of the ciphertext, where SubtleCrypto
  // puts it. Nothing has to carry it separately.
  return [VERSION, toBase64(iv), toBase64(new Uint8Array(sealed))].join('$');
};

/**
 * Opens a box, or returns null.
 *
 * Null rather than a throw, for the same reason `decryptSecret` does it: an
 * unreadable subscription means this one needs entering again, which is
 * something a screen can ask for. It should not take down whatever happened to
 * read the row.
 *
 * A wrong key, a tampered payload and a truncated one all land here, and none
 * of them are distinguishable -- which is the point of the tag.
 */
export const open = async (sealed: string, key: Uint8Array): Promise<string | null> => {
  if (typeof sealed !== 'string') {
    return null;
  }

  const parts = sealed.split('$');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    return null;
  }

  const iv = fromBase64(parts[1]);
  const ciphertext = fromBase64(parts[2]);

  if (!iv || iv.length !== IV_BYTES || !ciphertext || !ciphertext.length) {
    return null;
  }

  try {
    const opened = await subtle().decrypt(
      { name: 'AES-GCM', iv: owned(iv) },
      await importKey(key, 'decrypt'),
      owned(ciphertext)
    );

    return decoder.decode(opened);
  } catch {
    return null;
  }
};

/** Whether a stored value looks like something this can open. */
export const isSealed = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith(`${VERSION}$`);
