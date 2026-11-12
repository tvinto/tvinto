import { introDbAddress, plausibleSkip, skipsFromIntroDb } from './introdb';

const EPISODE = 58 * 60 * 1000;

describe('TheIntroDB', () => {
  it('asks for an episode by TMDB id, season, episode and length', () => {
    expect(introDbAddress(1396, 1, 2, 3_480_000.4)).toBe(
      'https://api.theintrodb.org/v3/media?tmdb_id=1396&season=1&episode=2&duration_ms=3480000'
    );
    expect(introDbAddress(603)).toBe('https://api.theintrodb.org/v3/media?tmdb_id=603');
  });

  it('reads the answer it gave for Breaking Bad 1x1', () => {
    // As it answered on 9 November 2026.
    const answer = { tmdb_id: 1396, type: 'tv', season: 1, episode: 1, intro: [{ start_ms: 228671, end_ms: 246465 }], credits: [{ start_ms: 3432825, end_ms: null }] };

    expect(skipsFromIntroDb(answer, EPISODE)).toEqual([
      { kind: 'intro', startMs: 228671, endMs: 246465 },
      { kind: 'credits', startMs: 3432825, endMs: EPISODE }
    ]);
  });

  it('starts an intro with no start at the beginning', () => {
    expect(plausibleSkip('intro', null, 40_000, EPISODE)).toEqual({ kind: 'intro', startMs: 0, endMs: 40_000 });
  });

  it('drops an intro or a recap with no end', () => {
    expect(plausibleSkip('intro', 10_000, null, EPISODE)).toBeNull();
    expect(plausibleSkip('recap', 0, null, EPISODE)).toBeNull();
  });

  it('drops an intro that is too short, too long or too late', () => {
    expect(plausibleSkip('intro', 10_000, 12_000, EPISODE)).toBeNull();
    expect(plausibleSkip('intro', 10_000, 10_000 + 4 * 60_000, EPISODE)).toBeNull();
    expect(plausibleSkip('intro', 40 * 60_000, 41 * 60_000, EPISODE)).toBeNull();
  });

  it('keeps a recap to the first third', () => {
    expect(plausibleSkip('recap', 0, 90_000, EPISODE)).not.toBeNull();
    expect(plausibleSkip('recap', 25 * 60_000, 26 * 60_000, EPISODE)).toBeNull();
  });

  it('keeps credits to the last quarter', () => {
    expect(plausibleSkip('credits', 20 * 60_000, null, EPISODE)).toBeNull();
    expect(plausibleSkip('credits', 55 * 60_000, null, EPISODE)).toEqual({ kind: 'credits', startMs: 55 * 60_000, endMs: EPISODE });
  });

  it('trusts the times when the length is not known, within the same limits', () => {
    expect(plausibleSkip('intro', 60_000, 100_000, 0)).toEqual({ kind: 'intro', startMs: 60_000, endMs: 100_000 });
  });

  it('makes nothing of an answer that is not one', () => {
    expect(skipsFromIntroDb(null)).toEqual([]);
    expect(skipsFromIntroDb({ intro: 'soon' })).toEqual([]);
    expect(skipsFromIntroDb({ intro: [{ start_ms: 'a', end_ms: -1 }] })).toEqual([]);
  });
});
