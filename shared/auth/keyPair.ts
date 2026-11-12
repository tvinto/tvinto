import { fromBase64, toBase64 } from './accountKeys';
import { open, seal } from './secretBox';

/**
 * Sealing something for another account, which this device cannot ask for a
 * password.
 *
 * `secretBox.ts` seals under an account's own `enc`, which only that account's
 * devices have. A family needs one more thing: a manager's device setting up
 * somebody else's subscription, and a member's device handing its `enc` up to
 * the people who manage it. Neither side can share a
 * password with the other, so each account has a key pair: the public half
 * kept in the clear on the sync service, the private half sealed there under
 * the account's own `enc`.
 *
 * Sealing for a public key is ECDH with a throwaway key pair, HKDF over the
 * shared secret, and then exactly the box `secretBox.ts` makes. Everything is
 * SubtleCrypto, which the WebView, Electron, the Worker and Node all have.
 *
 * Not defended, and written down so it stays a choice: a sync service that is
 * actively hostile could hand out a public key of its own. It could equally
 * serve a modified app.
 */

/** How a box sealed for a public key is spelled: `pk1$ephemeral$` + a secretBox. */
const VERSION = 'pk1';

/** P-256: the curve every SubtleCrypto implements for ECDH. */
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** Binds the derived key to what it is for, so it is never reused for another purpose. */
const INFO = new TextEncoder().encode('tvinto family seal v1');

/** An account's key pair, as stored: both halves base64. */
export interface AccountKeyPair {
  /** The raw public point, 65 bytes. Kept in the clear. */
  publicKey: string;
  /** PKCS#8. Never stored anywhere but sealed under the account's `enc`. */
  privateKey: string;
}

const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);

// Unannotated, as in secretBox.ts: the DOM's names for these types are not the
// backend's, and inference is right in every build that compiles this.
const subtle = () => {
  const available = globalThis.crypto?.subtle;
  if (!available) {
    throw new Error('This build has no SubtleCrypto, so it cannot seal for another account');
  }
  return available;
};

export const makeKeyPair = async (): Promise<AccountKeyPair> => {
  const pair = await subtle().generateKey(CURVE, true, ['deriveBits']);
  const publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const privateKey = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
  return { publicKey: toBase64(publicKey), privateKey: toBase64(privateKey) };
};

const importPublic = (raw: Uint8Array) => subtle().importKey('raw', owned(raw), CURVE, false, []);

const importPrivate = (pkcs8: Uint8Array) =>
  subtle().importKey('pkcs8', owned(pkcs8), CURVE, false, ['deriveBits']);

/** The 32-byte box key both sides arrive at. */
const boxKey = async (privateKey: unknown, publicKey: unknown, ephemeral: Uint8Array): Promise<Uint8Array> => {
  const shared = await subtle().deriveBits(
    { name: 'ECDH', public: publicKey as never },
    privateKey as never,
    256
  );
  const material = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    // The ephemeral public key as the salt, so two seals never share a key
    // even if HKDF's input were somehow the same.
    { name: 'HKDF', hash: 'SHA-256', salt: owned(ephemeral), info: owned(INFO) },
    material,
    256
  );
  return new Uint8Array(bits);
};

/** Seals text so that only the holder of this public key's private half can read it. */
export const sealFor = async (plaintext: string, publicKey: string): Promise<string> => {
  const recipient = fromBase64(publicKey);
  if (!recipient || recipient.length !== 65) {
    throw new Error('That is not a public key this can seal for');
  }

  const ephemeral = await subtle().generateKey(CURVE, true, ['deriveBits']);
  const ephemeralPublic = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));
  const key = await boxKey(ephemeral.privateKey, await importPublic(recipient), ephemeralPublic);

  return `${VERSION}$${toBase64(ephemeralPublic)}$${await seal(plaintext, key)}`;
};

/**
 * Opens a box sealed for this private key, or returns null.
 *
 * Null for anything wrong -- another account's box, a damaged one, a private
 * key that is not one -- as `secretBox.open` does, so a caller has one thing
 * to handle.
 */
export const openWith = async (sealed: string, privateKey: string): Promise<string | null> => {
  if (typeof sealed !== 'string' || !sealed.startsWith(`${VERSION}$`)) {
    return null;
  }

  const rest = sealed.slice(VERSION.length + 1);
  const split = rest.indexOf('$');
  const ephemeralPublic = split > 0 ? fromBase64(rest.slice(0, split)) : null;
  const pkcs8 = fromBase64(privateKey);
  if (!ephemeralPublic || ephemeralPublic.length !== 65 || !pkcs8) {
    return null;
  }

  try {
    const key = await boxKey(
      await importPrivate(pkcs8),
      await importPublic(ephemeralPublic),
      ephemeralPublic
    );
    return await open(rest.slice(split + 1), key);
  } catch {
    return null;
  }
};

/** The private half, sealed under the account's own `enc` for keeping on the sync service. */
export const sealPrivateKey = (pair: AccountKeyPair, enc: Uint8Array): Promise<string> =>
  seal(pair.privateKey, enc);

/** The private half back, or null when this `enc` is not the one it was sealed under. */
export const openPrivateKey = (sealed: string, enc: Uint8Array): Promise<string | null> =>
  open(sealed, enc);
