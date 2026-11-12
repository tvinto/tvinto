import crypto from 'crypto';

/**
 * Password hashing for the app's own accounts.
 *
 * scrypt from Node's standard library rather than argon2 or bcrypt. Both of
 * those are native modules, and this project already pays for one of those
 * (better-sqlite3) on a platform where building them is awkward. scrypt is
 * memory-hard, is what Node's own documentation points at for this job, and
 * costs no dependency at all.
 *
 * A stored hash is self-describing -- the parameters travel with it -- so the
 * cost can be raised later without stranding the passwords hashed before the
 * change.
 */

/**
 * CPU/memory cost. 2^16 puts a single hash at roughly a tenth of a second and
 * 64 MB, which is slow enough to make guessing expensive and fast enough that
 * a login does not feel stalled.
 */
const COST = 65536;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** scrypt needs to be told it may use more than the default 32 MB. */
const MEMORY_LIMIT = 128 * COST * BLOCK_SIZE * 2;

const scrypt = (password: string, salt: Buffer, cost: number, blockSize: number, parallelism: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: cost, r: blockSize, p: parallelism, maxmem: MEMORY_LIMIT },
      (error, derived) => (error ? reject(error) : resolve(derived))
    );
  });

/**
 * Hashes a password into a string safe to store.
 *
 * Format: `scrypt$N$r$p$salt$hash`, both parts base64. Everything needed to
 * verify is in there, including the cost it was made with.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password) {
    throw new Error('Password is required');
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, COST, BLOCK_SIZE, PARALLELISM);

  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64'),
    derived.toString('base64')
  ].join('$');
}

/**
 * Whether a password matches a stored hash.
 *
 * Compared in constant time: a comparison that returns early on the first
 * wrong byte leaks how much of a guess was right.
 *
 * A malformed or unrecognised hash is a false rather than a throw. Those come
 * from data, not from callers, and a corrupt row should refuse the login
 * rather than take the endpoint down.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed || !password) {
    return false;
  }

  try {
    const derived = await scrypt(
      password,
      parsed.salt,
      parsed.cost,
      parsed.blockSize,
      parsed.parallelism
    );

    if (derived.length !== parsed.hash.length) {
      return false;
    }
    return crypto.timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

/** Whether a hash was made with parameters weaker than the current ones. */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) {
    return true;
  }
  return (
    parsed.cost < COST || parsed.blockSize < BLOCK_SIZE || parsed.parallelism < PARALLELISM
  );
}

interface ParsedHash {
  cost: number;
  blockSize: number;
  parallelism: number;
  salt: Buffer;
  hash: Buffer;
}

const parseHash = (stored: string): ParsedHash | null => {
  if (typeof stored !== 'string') {
    return null;
  }

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }

  const [, cost, blockSize, parallelism, salt, hash] = parts;
  const parsed = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelism: Number(parallelism),
    salt: Buffer.from(salt, 'base64'),
    hash: Buffer.from(hash, 'base64')
  };

  const positiveInteger = (n: number) => Number.isInteger(n) && n > 0;
  if (
    !positiveInteger(parsed.cost) ||
    !positiveInteger(parsed.blockSize) ||
    !positiveInteger(parsed.parallelism) ||
    parsed.salt.length === 0 ||
    parsed.hash.length === 0
  ) {
    return null;
  }

  return parsed;
};
