import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config/config';

/**
 * The server's own secret, used to disguise salts for names with no account.
 *
 * Signing in needs the salt before the password can be turned into anything,
 * so the endpoint that hands salts out cannot sit behind a session. Answering
 * "no such user" would turn it into a list of who has an account here, which
 * is a question this server already refuses at sign-in and should not start
 * answering somewhere else.
 *
 * So an unknown name gets a salt anyway, made from this secret and the name.
 * Deterministic, so asking twice gives the same answer the way a real one
 * would, and unguessable without the secret, so it cannot be told apart from
 * one that belongs to a real account.
 *
 * Losing this secret is harmless, which is why it is generated rather than
 * demanded. Real accounts carry their own salts; only the disguises change,
 * and nobody was relying on those.
 */

const SECRET_BYTES = 32;

let cached: Uint8Array | null = null;

/** Named to fall under the `*.key` rule in .gitignore, like the other one. */
const secretFilePath = (): string => `${config.database.path}.salt.key`;

const fromEnvironment = (): Uint8Array | null => {
  const configured = process.env.ACCOUNT_SALT_SECRET?.trim();
  if (!configured) {
    return null;
  }

  const decoded = /^[0-9a-f]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');

  if (decoded.length < SECRET_BYTES) {
    throw new Error(
      `ACCOUNT_SALT_SECRET must be at least ${SECRET_BYTES} bytes (base64 or hex); got ${decoded.length}`
    );
  }

  return new Uint8Array(decoded);
};

/** The secret, generating and storing one beside the database on first use. */
export function accountSaltSecret(): Uint8Array {
  if (cached) {
    return cached;
  }

  const supplied = fromEnvironment();
  if (supplied) {
    cached = supplied;
    return cached;
  }

  const file = secretFilePath();

  try {
    const existing = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (existing.length >= SECRET_BYTES) {
      cached = new Uint8Array(existing);
      return cached;
    }
    console.warn(`Ignoring a malformed salt secret at ${file}; generating a replacement`);
  } catch {
    // No secret yet, which is the normal case on a first run.
  }

  const generated = crypto.randomBytes(SECRET_BYTES);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated.toString('base64'), { mode: 0o600 });
  } catch (error) {
    // Not fatal. A secret that changes on every restart still disguises; it
    // simply stops being consistent between them, which no real account
    // depends on.
    console.warn('Could not store the salt secret; disguised salts will not survive a restart', error);
  }

  cached = new Uint8Array(generated);
  return cached;
}

/** Test seam: forces the next call to resolve the secret again. */
export function resetSaltSecretCache(): void {
  cached = null;
}
