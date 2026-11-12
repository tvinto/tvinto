import { KdfPrimitives } from '../../shared/auth/accountKeys';

/**
 * The two operations this service needs, from the Worker runtime.
 *
 * There is no scrypt here, and that is not an omission. A Worker gets 10 ms of
 * CPU per request on the free plan and scrypt at this app's cost wants about a
 * hundred, so the expensive step happens on the device and what arrives is
 * already a key. Hashing it costs microseconds.
 *
 * Typed as the two it implements rather than as the whole interface, so that
 * a use of scrypt in here would not compile rather than failing at runtime
 * under load.
 */
export const workerKdf: Pick<KdfPrimitives, 'hkdf' | 'sha256'> = {
  hkdf: async (key, info, length) => {
    const material = await crypto.subtle.importKey('raw', asOwned(key), 'HKDF', false, [
      'deriveBits'
    ]);

    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        // Empty, matching both the device and the Express backend. The input
        // is already scrypt output, and the three must agree exactly or
        // nothing opens.
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(info)
      },
      material,
      length * 8
    );

    return new Uint8Array(bits);
  },

  sha256: async data => new Uint8Array(await crypto.subtle.digest('SHA-256', asOwned(data)))
};

/**
 * A copy backed by an ArrayBuffer this array certainly owns.
 *
 * SubtleCrypto will not take a view that might be onto shared memory. These are
 * thirty-two bytes; copying them costs nothing.
 */
const asOwned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);
