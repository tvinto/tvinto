import crypto from 'crypto';
import {
  KdfParams,
  SubmittedKeys,
  deriveAccountKeys,
  toBase64
} from '../../../shared/auth/accountKeys';
import { workerKdf } from '../kdf';

/**
 * Standing in for a device, in tests.
 *
 * The Worker has no scrypt and never will, so one is borrowed from Node here.
 * Everything else is the Worker's own `workerKdf` -- the point being that a key
 * made by something else and checked by this service must match, which is the
 * whole arrangement in one line.
 */

/** The floor the shared policy accepts, so tests are not slow for no reason. */
export const FLOOR: KdfParams = { cost: 16384, blockSize: 8, parallelism: 1 };

/** Sixteen bytes, the shortest salt a server will take. */
export const SALT = toBase64(new TextEncoder().encode('0123456789abcdef'));

/** A server secret, fixed so a disguised salt is the same in every run. */
export const SALT_SECRET = Buffer.alloc(32, 7).toString('base64');

const nodeScrypt = (
  password: Uint8Array,
  salt: Uint8Array,
  params: KdfParams,
  length: number
): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      length,
      {
        N: params.cost,
        r: params.blockSize,
        p: params.parallelism,
        maxmem: 128 * params.cost * params.blockSize * 2
      },
      (error, derived) => (error ? reject(error) : resolve(new Uint8Array(derived)))
    );
  });

export const keysFor = async (
  password: string,
  salt: string = SALT,
  params: KdfParams = FLOOR
): Promise<SubmittedKeys> => {
  const bytes = Uint8Array.from(Buffer.from(salt, 'base64'));
  const { auth } = await deriveAccountKeys(password, bytes, params, {
    ...workerKdf,
    scrypt: nodeScrypt
  });

  return { salt, auth: toBase64(auth), ...params };
};
