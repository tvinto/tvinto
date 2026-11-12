import { handedSkips, skipAt, skipsFromChapters } from './skips';

const EPISODE = 50 * 60_000;

describe('skip intro on the desktop', () => {
  it('offers the intro while it plays and a little early, never the credits', () => {
    const skips = [
      { kind: 'intro', startMs: 60_000, endMs: 100_000 },
      { kind: 'credits', startMs: 47 * 60_000, endMs: EPISODE }
    ];

    expect(skipAt(skips, 50_000)).toBeNull();
    expect(skipAt(skips, 59_000)?.kind).toBe('intro');
    expect(skipAt(skips, 99_000)).toBeNull();
    expect(skipAt(skips, 48 * 60_000)).toBeNull();
  });

  it('reads chapters named for what they are, as mpv lists them', () => {
    const skips = skipsFromChapters(
      [
        { title: 'Previously On', time: 0 },
        { title: 'Opening Credits', time: 70 },
        { title: 'The flooded station', time: 120 },
        { title: 'End Credits', time: 47 * 60 }
      ],
      EPISODE
    );

    expect(skips).toEqual([
      { kind: 'recap', startMs: 0, endMs: 70_000 },
      { kind: 'intro', startMs: 70_000, endMs: 120_000 },
      { kind: 'credits', startMs: 47 * 60_000, endMs: EPISODE }
    ]);
  });

  it('leaves early credits and a post-credits scene alone', () => {
    expect(
      skipsFromChapters(
        [
          { title: 'Chapter 1', time: 0 },
          { title: 'Credits', time: 600 },
          { title: 'Post-credits scene', time: 49 * 60 }
        ],
        EPISODE
      )
    ).toEqual([]);
  });

  it('takes only well-formed skips from the page', () => {
    expect(handedSkips([{ kind: 'intro', startMs: 0, endMs: 40_000 }, { kind: 'intro', startMs: 5 }, 'x', null])).toEqual([
      { kind: 'intro', startMs: 0, endMs: 40_000 }
    ]);
    expect(handedSkips('nothing')).toEqual([]);
  });
});
