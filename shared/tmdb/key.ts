/**
 * A TMDB key as somebody pastes it: which of TMDB's two values it is, and
 * where to get one. Shared by the app's key field (settings and the first
 * launch) and `tvinto server tmdb-key`.
 *
 * TMDB's API page shows two values, and either works (client.ts): the short
 * v3 "API key", 32 hexadecimal characters, and the long "API read access
 * token", a JWT of about 200 characters that starts with "eyJ". The page
 * also shows things that are neither, and a person new to it cannot tell.
 */

/** Where a TMDB key is made, once signed in to a free account there. */
export const TMDB_KEY_ADDRESS = 'https://www.themoviedb.org/settings/api';

/** The same, as a person reads it off a screen and types it. */
export const TMDB_KEY_ADDRESS_SHORT = 'themoviedb.org/settings/api';

/** Made-up values of the right shape, to show what each looks like. Neither is a key. */
export const TMDB_KEY_EXAMPLES = {
  apiKey: '4f2a9c1e7b3d5a8f6e0c2b9d1a7f3e5c',
  token: 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI0ZjJhOWMxZTdi…'
} as const;

export type TmdbKeyKind = 'api-key' | 'token';

/**
 * What was pasted, tidied: spaces and line breaks gone (a token copied from a
 * narrow page breaks across lines), quotes around it gone, and a "Bearer "
 * in front gone (copied from TMDB's code samples).
 */
export function normaliseTmdbKey(pasted: string): string {
  return pasted
    .replace(/\s+/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^Bearer(?=eyJ)/i, '');
}

/** Which of TMDB's two values this is, or null for something else. */
export function tmdbKeyKind(key: string): TmdbKeyKind | null {
  if (/^[0-9a-f]{32}$/i.test(key)) {
    return 'api-key';
  }
  if (/^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(key) && key.length >= 100) {
    return 'token';
  }
  return null;
}
