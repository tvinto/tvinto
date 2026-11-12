import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config/config';

/**
 * Encryption for the Xtream passwords the app has to keep.
 *
 * The app cannot hash these the way it hashes account passwords -- it has to
 * present them to the provider, so it needs them back. Encrypting at rest
 * means a copy of the database file is not a copy of everyone's subscription.
 *
 * This protects against the database being read, not against the server being
 * taken: the key sits on the same machine. The stronger arrangement -- a key
 * derived from the account password, so the store cannot read the secrets at
 * all -- needs the provider calls to happen on the user's own device, which is
 * a later step. The stored format carries a version so that migration does not
 * have to guess what it is looking at.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 'v1';

let cachedKey: Buffer | null = null;

/** Where the generated key lives when one was not supplied. */
const keyFilePath = (): string => `${config.database.path}.key`;

/**
 * Reads a 32-byte key from CREDENTIAL_KEY, accepting base64 or hex.
 *
 * Anything present but the wrong size is an error rather than a fallback: a
 * truncated key silently generating a different one would encrypt new
 * credentials that the intended key could never read.
 */
const keyFromEnvironment = (): Buffer | null => {
  const configured = process.env.CREDENTIAL_KEY?.trim();
  if (!configured) {
    return null;
  }

  const decoded = /^[0-9a-f]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');

  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIAL_KEY must be ${KEY_BYTES} bytes (base64 or hex); got ${decoded.length}`
    );
  }

  return decoded;
};

/**
 * The key, generating and storing one beside the database on first use.
 *
 * Generating rather than refusing to start keeps a self-hosted install working
 * without ceremony. The file is written with owner-only permissions where the
 * platform honours them, and losing it means re-entering subscriptions rather
 * than losing any of the user's own data.
 */
const resolveKey = (): Buffer => {
  if (cachedKey) {
    return cachedKey;
  }

  const supplied = keyFromEnvironment();
  if (supplied) {
    cachedKey = supplied;
    return cachedKey;
  }

  const file = keyFilePath();

  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    const decoded = Buffer.from(existing, 'base64');
    if (decoded.length === KEY_BYTES) {
      cachedKey = decoded;
      return cachedKey;
    }
    console.warn(`Ignoring malformed credential key at ${file}; generating a replacement`);
  } catch {
    // No key yet, which is the normal case on a first run.
  }

  const generated = crypto.randomBytes(KEY_BYTES);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated.toString('base64'), { mode: 0o600 });
    console.info(`Generated a credential encryption key at ${file}`);
  } catch (error) {
    console.warn(
      'Could not write the credential key to disk; stored subscriptions will not survive a restart',
      error
    );
  }

  cachedKey = generated;
  return cachedKey;
};

/**
 * Where the key comes from, for the boot report to say so.
 *
 * Asks the environment rather than `resolveKey`, so that reporting on the key
 * never has the side effect of generating one.
 */
export function credentialKeySource(): { supplied: boolean; file: string } {
  return { supplied: !!process.env.CREDENTIAL_KEY?.trim(), file: keyFilePath() };
}

/** Encrypts a secret into `v1$iv$tag$ciphertext`, each part base64. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, resolveKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext ?? '', 'utf8'),
    cipher.final()
  ]);

  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64')
  ].join('$');
}

/**
 * Decrypts a stored secret, or null when it cannot be read.
 *
 * Null rather than a throw: an unreadable credential means this subscription
 * needs entering again, which is something the caller can ask for. It should
 * not take down whatever request happened to touch the row.
 */
export function decryptSecret(stored: string): string | null {
  if (typeof stored !== 'string') {
    return null;
  }

  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    return null;
  }

  const [, iv, tag, ciphertext] = parts;

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      resolveKey(),
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    // A wrong key or a tampered payload both land here; neither is recoverable.
    return null;
  }
}

/** Test seam: forces the next call to resolve the key again. */
export function resetKeyCache(): void {
  cachedKey = null;
}
