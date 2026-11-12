import fs from 'fs';

/**
 * Removes the throwaway databases created for this run.
 *
 * Best effort by design. On Windows the worker that opened a cache file can
 * still be releasing its handle when this runs, and the removal fails with
 * EPERM; that is tidy-up of a directory the OS clears anyway, so it must not
 * turn a green run red. The retries usually win, and what they do not win is
 * reported rather than thrown.
 */
export default function globalTeardown(): void {
  const root =
    (globalThis as Record<string, unknown>).__XTREAM_TEST_DB_DIR__ ??
    process.env.XTREAM_TEST_DB_DIR;

  if (typeof root !== 'string' || root.length === 0) {
    return;
  }

  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`Could not remove the test database directory ${root}:`, (error as Error).message);
  }
}
