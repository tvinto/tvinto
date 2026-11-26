import { open, seal } from '../auth/secretBox';
import { TmdbFetch, tmdbClient } from './client';
import { normaliseTmdbKey, tmdbKeyKind } from './key';

/**
 * A TMDB key kept on the account (worker/src/tmdb.ts, `/api/tmdb/key`), so
 * every device signed in to it uses it. Sealed under the account's own key,
 * like the provider login: the sync service holds ciphertext it cannot open.
 * The app's Settings and first launch and `tvinto tmdb-key` all go through
 * here.
 */

/** Where it is kept, under the sync service's /api. */
export const ACCOUNT_TMDB_KEY_PATH = '/tmdb/key';

/**
 * Tidies a pasted key, checks it with TMDB and seals it for the account.
 * Throws TMDB's refusal (a TmdbError) and seals nothing when TMDB says no.
 */
export async function sealCheckedTmdbKey(
  pasted: string,
  enc: Uint8Array,
  fetch: TmdbFetch
): Promise<{ key: string; payload: string }> {
  const key = normaliseTmdbKey(pasted);
  await tmdbClient(fetch, key).check();
  return { key, payload: await seal(key, enc) };
}

/** The key inside a kept payload, or null when this account's key does not open it or it is not a key. */
export async function openTmdbKey(payload: string, enc: Uint8Array): Promise<string | null> {
  const key = await open(payload, enc);
  return key && tmdbKeyKind(key) ? key : null;
}
