import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Creates the directory each test file's throwaway cache database lives in.
 *
 * The path is handed to the workers through the environment because a jest
 * worker is a separate process and cannot read anything else set here.
 */
export default function globalSetup(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtream-tests-'));
  process.env.XTREAM_TEST_DB_DIR = root;
  // globalTeardown runs in this same process, but is a separate module.
  (globalThis as Record<string, unknown>).__XTREAM_TEST_DB_DIR__ = root;
}
