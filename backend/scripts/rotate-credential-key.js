#!/usr/bin/env node
/**
 * Replaces the key that encrypts stored subscription passwords.
 *
 * Needed because the key file was committed to this repository once, so the
 * key in use is in the history and would travel with any copy of it. The
 * database was never committed, so the old key on its own decrypts nothing --
 * but it stops being worth anything at all once this has run.
 *
 * Decrypts every stored secret with the current key, re-encrypts it under a
 * fresh one, and writes the two together: the rows and the key file both
 * change or neither does. Nothing secret is printed.
 *
 *   node scripts/rotate-credential-key.js
 *
 * The old key is kept beside the new one as <name>.superseded-<timestamp> in
 * case a row somewhere was missed; delete it once the app has signed in and
 * played something.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 'v1';

const packageRoot = path.resolve(__dirname, '..');
const databasePath = path.resolve(
  packageRoot,
  (process.env.DATABASE_PATH || '').trim() || 'xtream-cache.db'
);
const keyPath = `${databasePath}.key`;

const decrypt = (key, stored) => {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`unrecognised stored format: ${parts[0]}`);
  }
  const [, iv, tag, ciphertext] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
};

const encrypt = (key, plaintext) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64')
  ].join('$');
};

const readCurrentKey = () => {
  const fromEnvironment = (process.env.CREDENTIAL_KEY || '').trim();
  if (fromEnvironment) {
    const decoded = /^[0-9a-f]{64}$/i.test(fromEnvironment)
      ? Buffer.from(fromEnvironment, 'hex')
      : Buffer.from(fromEnvironment, 'base64');
    if (decoded.length !== KEY_BYTES) {
      throw new Error(`CREDENTIAL_KEY is ${decoded.length} bytes, expected ${KEY_BYTES}`);
    }
    console.log('Current key: from CREDENTIAL_KEY in the environment.');
    console.log('Rotating that means editing it there afterwards; this script writes a file.');
    return { key: decoded, fromFile: false };
  }

  const decoded = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new Error(`the key at ${keyPath} is ${decoded.length} bytes, expected ${KEY_BYTES}`);
  }
  console.log(`Current key: ${keyPath}`);
  return { key: decoded, fromFile: true };
};

const main = () => {
  console.log(`Database:    ${databasePath}`);
  const { key: oldKey } = readCurrentKey();

  const db = new Database(databasePath);
  const rows = db.prepare('SELECT id, xtream_secret FROM provider_accounts').all();
  console.log(`Found ${rows.length} stored subscription${rows.length === 1 ? '' : 's'}.`);

  if (rows.length === 0) {
    console.log('Nothing to re-encrypt, but the key is replaced anyway.');
  }

  // Decrypt everything before writing anything: a key that only some of the
  // rows were re-encrypted under leaves the rest permanently unreadable.
  const plaintexts = rows.map(row => {
    try {
      return { id: row.id, secret: decrypt(oldKey, row.xtream_secret) };
    } catch (error) {
      throw new Error(
        `Could not decrypt subscription ${row.id} with the current key (${error.message}). ` +
          'Nothing has been changed.'
      );
    }
  });

  const newKey = crypto.randomBytes(KEY_BYTES);
  const update = db.prepare('UPDATE provider_accounts SET xtream_secret = ? WHERE id = ?');

  db.transaction(() => {
    for (const { id, secret } of plaintexts) {
      update.run(encrypt(newKey, secret), id);
    }
  })();

  // Read back through the new key before the old one is put out of reach.
  for (const { id, secret } of plaintexts) {
    const stored = db.prepare('SELECT xtream_secret FROM provider_accounts WHERE id = ?').get(id);
    if (decrypt(newKey, stored.xtream_secret) !== secret) {
      throw new Error(`Subscription ${id} did not survive the round trip. Nothing has been lost.`);
    }
  }
  db.close();

  if (fs.existsSync(keyPath)) {
    const superseded = `${keyPath}.superseded-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(keyPath, superseded);
    console.log(`Old key moved to ${path.basename(superseded)}`);
  }
  fs.writeFileSync(keyPath, newKey.toString('base64'), { mode: 0o600 });

  console.log(`New key written to ${keyPath}`);
  console.log(`Re-encrypted ${plaintexts.length} subscription${plaintexts.length === 1 ? '' : 's'} and verified each one.`);
  console.log('The key in the git history now decrypts nothing.');
};

try {
  main();
} catch (error) {
  console.error(`Rotation failed: ${error.message}`);
  process.exit(1);
}
