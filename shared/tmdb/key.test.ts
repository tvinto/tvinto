import { TMDB_KEY_EXAMPLES, normaliseTmdbKey, tmdbKeyKind } from './key';

/** A made-up token of the real shape: three base64url parts, about 200 characters. */
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${'eyJhdWQiOiJmYWtlIn0'.repeat(8)}.${'c2lnbmF0dXJl'.repeat(4)}`;

describe('tmdbKeyKind', () => {
  it('knows the v3 API key: 32 hexadecimal characters', () => {
    expect(tmdbKeyKind(TMDB_KEY_EXAMPLES.apiKey)).toBe('api-key');
    expect(tmdbKeyKind(TMDB_KEY_EXAMPLES.apiKey.toUpperCase())).toBe('api-key');
  });

  it('knows the read access token', () => {
    expect(tmdbKeyKind(TOKEN)).toBe('token');
  });

  it('refuses what is neither', () => {
    expect(tmdbKeyKind('')).toBeNull();
    expect(tmdbKeyKind(TMDB_KEY_EXAMPLES.apiKey.slice(1))).toBeNull();
    expect(tmdbKeyKind(TMDB_KEY_EXAMPLES.apiKey + 'a')).toBeNull();
    expect(tmdbKeyKind('zz2a9c1e7b3d5a8f6e0c2b9d1a7f3e5c')).toBeNull();
    // The example shown on screen is cut short on purpose.
    expect(tmdbKeyKind(TMDB_KEY_EXAMPLES.token)).toBeNull();
    expect(tmdbKeyKind('eyJhbGciOiJIUzI1NiJ9')).toBeNull();
  });
});

describe('normaliseTmdbKey', () => {
  it('drops spaces, line breaks, quotes and a Bearer in front', () => {
    expect(normaliseTmdbKey(`  ${TMDB_KEY_EXAMPLES.apiKey}\n`)).toBe(TMDB_KEY_EXAMPLES.apiKey);
    expect(normaliseTmdbKey(`"${TMDB_KEY_EXAMPLES.apiKey}"`)).toBe(TMDB_KEY_EXAMPLES.apiKey);
    expect(normaliseTmdbKey(`Bearer ${TOKEN.slice(0, 60)}\n${TOKEN.slice(60)}`)).toBe(TOKEN);
  });

  it('leaves a key alone', () => {
    expect(normaliseTmdbKey(TOKEN)).toBe(TOKEN);
  });
});
