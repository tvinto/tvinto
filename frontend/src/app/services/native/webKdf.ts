import { scrypt } from 'scrypt-js';
import { KdfPrimitives } from '@shared/auth/accountKeys';

/**
 * The key derivation primitives, as a device has them.
 *
 * HKDF and SHA-256 come from SubtleCrypto, which every target has. scrypt does
 * not: SubtleCrypto offers PBKDF2 and nothing memory-hard, so it comes from
 * `scrypt-js` instead -- a plain JavaScript implementation with no
 * dependencies and nothing to compile, which is what makes it usable on
 * Android, on a television and in Electron alike.
 *
 * It is slower than the native one, and that cost is real rather than
 * theoretical. Measured on this desktop at the cost this app uses: 766 ms in
 * JavaScript against 202 ms native. A television box is slower still, so
 * signing in there should be expected to take a few seconds and should say so
 * on screen rather than appearing to have hung. It happens once per device.
 *
 * Nothing about that is load-bearing, though. `StoredVerifier` names which
 * function made it, so if a device turns out to be too slow the cost can be
 * lowered, or the function changed, without stranding the accounts already
 * made.
 */

/** Progress through the slow step, from 0 to 1. */
export type ScryptProgress = (fraction: number) => void;

/**
 * SubtleCrypto exists only in a secure context.
 *
 * Both shipped targets provide one -- Capacitor serves from `https://localhost`
 * and electron-serve registers its scheme as secure -- but a change to either
 * would otherwise surface as a TypeError about reading a property of
 * undefined, several frames from the cause.
 */
const subtle = (): SubtleCrypto => {
  const available = globalThis.crypto?.subtle;
  if (!available) {
    throw new Error('This build has no SubtleCrypto, so it cannot derive account keys');
  }
  return available;
};

const utf8 = new TextEncoder();

/**
 * A copy backed by an ArrayBuffer this array certainly owns.
 *
 * SubtleCrypto will not take a `Uint8Array<ArrayBufferLike>`, because that
 * could be a view onto shared memory and the algorithms are not written for
 * something another thread can change underneath them. These are thirty-two
 * bytes; copying them costs nothing and says what is meant.
 */
const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);

/**
 * A `setImmediate` for the length of one derivation, made of a message channel.
 *
 * scrypt-js works in slices and waits between them on `setImmediate`, or on
 * `setTimeout` where there is none -- which is every page. A window not in
 * front has its timers held back to about one a second and less, so signing in
 * on the desktop with another window over the app stood at a few per cent for
 * minutes and only moved once it was brought forward (8 October).
 * Messages are not held back like timers. Put in place only while scrypt runs,
 * and only where nothing else already provided one.
 */
const withMessageTicks = async <T>(work: () => Promise<T>): Promise<T> => {
  const host = globalThis as { setImmediate?: (callback: () => void) => void };
  if (host.setImmediate || typeof MessageChannel === 'undefined') {
    return work();
  }
  const channel = new MessageChannel();
  const waiting: Array<() => void> = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  host.setImmediate = callback => {
    waiting.push(callback);
    channel.port2.postMessage(null);
  };
  try {
    return await work();
  } finally {
    delete host.setImmediate;
    channel.port1.close();
  }
};

export const createWebKdf = (onProgress?: ScryptProgress): KdfPrimitives => ({
  scrypt: async (password, salt, params, length) => {
    // Swallowing the return value is not tidiness. scrypt-js abandons the
    // derivation if the progress callback returns anything truthy, so a
    // caller writing `fraction => seen.push(fraction)` -- which returns a
    // length -- would cancel its own sign-in and be told only "cancelled".
    const report = onProgress
      ? (fraction: number) => {
          onProgress(fraction);
        }
      : undefined;

    const derived = await withMessageTicks(() =>
      scrypt(password, salt, params.cost, params.blockSize, params.parallelism, length, report)
    );

    return new Uint8Array(derived);
  },

  hkdf: async (key, info, length) => {
    const material = await subtle().importKey('raw', owned(key), 'HKDF', false, ['deriveBits']);

    const bits = await subtle().deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        // Empty, matching what the backend passes. The input is already scrypt
        // output, and the two sides must agree exactly or nothing opens.
        salt: new Uint8Array(0),
        info: utf8.encode(info)
      },
      material,
      length * 8
    );

    return new Uint8Array(bits);
  },

  sha256: async data => new Uint8Array(await subtle().digest('SHA-256', owned(data)))
});

/** The primitives, for callers with nothing to show progress on. */
export const webKdf: KdfPrimitives = createWebKdf();
