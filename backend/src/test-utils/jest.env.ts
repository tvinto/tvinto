import crypto from 'crypto';
import os from 'os';
import path from 'path';

/**
 * Points the cache at a throwaway database before any module imports it.
 *
 * database.ts opens its file at import time, so this has to run first --
 * without it a test suite would open, and write to, the real cache. An
 * absolute path, since DATABASE_PATH resolves relative paths against the
 * backend package.
 *
 * One file per test suite: jest resets the module registry between suites but
 * not the filesystem, so a shared file would let suites see each other's rows.
 */
const dir = process.env.XTREAM_TEST_DB_DIR || os.tmpdir();
process.env.DATABASE_PATH = path.join(dir, `cache-${crypto.randomUUID()}.db`);

// Keep tests off whatever a developer happens to have in .env.
process.env.XTREAM_BASE_URL = 'http://test-provider.invalid/player_api.php';

/**
 * A fixed secret for the disguised salts.
 *
 * Supplied rather than generated so the suites do not each write a key file
 * beside their throwaway database and leave it for the teardown to trip over.
 * Fixed rather than random so a disguised salt is the same in a test as it is
 * in the assertion next to it.
 */
process.env.ACCOUNT_SALT_SECRET = Buffer.alloc(32, 7).toString('base64');
