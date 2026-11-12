import crypto from 'crypto';
import { KdfParams, KdfPrimitives } from '../../../shared/auth/accountKeys';

/**
 * The key derivation primitives, from Node's standard library.
 *
 * Used by the tests, which have to be able to derive what a device would
 * derive, and by the existing backend while it accepts both the old password
 * hash and the new verifier. The Worker will supply its own, from
 * SubtleCrypto, and will not have a scrypt at all -- it does not need one.
 */

/** scrypt refuses to use more than 32 MB unless told the real figure. */
const memoryFor = (params: KdfParams): number =>
  128 * params.cost * params.blockSize * 2;

export const nodeKdf: KdfPrimitives = {
  scrypt: (password, salt, params, length) =>
    new Promise((resolve, reject) => {
      crypto.scrypt(
        password,
        salt,
        length,
        {
          N: params.cost,
          r: params.blockSize,
          p: params.parallelism,
          maxmem: memoryFor(params)
        },
        (error, derived) => (error ? reject(error) : resolve(new Uint8Array(derived)))
      );
    }),

  hkdf: (key, info, length) =>
    new Promise((resolve, reject) => {
      // An empty salt, matching what SubtleCrypto is asked for on the device.
      // The input is scrypt output, so there is no low entropy for a salt to
      // help with -- and the two sides must agree exactly or nothing opens.
      crypto.hkdf('sha256', key, new Uint8Array(0), info, length, (error, derived) =>
        error ? reject(error) : resolve(new Uint8Array(derived))
      );
    }),

  sha256: async data => new Uint8Array(crypto.createHash('sha256').update(data).digest())
};
