import crypto from 'crypto';
import { KdfParams, KdfPrimitives } from '../../shared/auth/accountKeys';

/**
 * The key derivation, from Node's own crypto: what the app does with
 * scrypt-js in a WebView, at native speed (shared/auth/accountKeys.ts).
 *
 * The same as backend/src/utils/nodeKdf.ts, written out again rather than
 * imported: the CLI is shipped on its own and the backend is not part of it.
 */

/** scrypt refuses to use more than 32 MB unless told the real figure. */
const memoryFor = (params: KdfParams): number => 128 * params.cost * params.blockSize * 2;

export const nodeKdf: KdfPrimitives = {
  scrypt: (password, salt, params, length) =>
    new Promise((resolve, reject) => {
      crypto.scrypt(
        password,
        salt,
        length,
        { N: params.cost, r: params.blockSize, p: params.parallelism, maxmem: memoryFor(params) },
        (error, derived) => (error ? reject(error) : resolve(new Uint8Array(derived)))
      );
    }),

  hkdf: (key, info, length) =>
    new Promise((resolve, reject) => {
      // An empty salt, as the app asks SubtleCrypto for: both ends must agree
      // exactly, or nothing sealed on one opens on the other.
      crypto.hkdf('sha256', key, new Uint8Array(0), info, length, (error, derived) =>
        error ? reject(error) : resolve(new Uint8Array(derived))
      );
    }),

  sha256: async data => new Uint8Array(crypto.createHash('sha256').update(data).digest())
};
