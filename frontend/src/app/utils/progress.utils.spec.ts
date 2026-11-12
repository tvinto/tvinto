import { Episode, WatchProgress } from '@shared/types';
import {
  COMPLETE_FRACTION,
  RESUME_MIN_SECONDS,
  episodeLabel,
  flattenEpisodes,
  formatTimecode,
  isComplete,
  isResumable,
  nextUp,
  remainingLabel,
  resumePosition,
  saysNothing,
  shortEpisodeTitle,
  watchedFraction,
  watchedPercent
} from './progress.utils';

const progress = (over: Partial<WatchProgress> = {}): WatchProgress => ({
  type: 'vod',
  itemId: '1',
  name: 'Something',
  positionSeconds: 600,
  durationSeconds: 3600,
  completed: false,
  updatedAt: '2026-08-20T10:00:00.000Z',
  ...over
});

const episode = (id: string, episodeNum: number, season = 1): Episode =>
  ({
    id,
    episode_num: episodeNum,
    season,
    title: `Episode ${episodeNum}`,
    container_extension: 'mkv',
    info: { video: { duration: '45:00' } }
  }) as Episode;

describe('watchedFraction', () => {
  it('is the position over the runtime', () => {
    expect(watchedFraction(progress({ positionSeconds: 900, durationSeconds: 3600 }))).toBe(0.25);
  });

  it('is zero when the runtime is unknown, as it is for live', () => {
    expect(watchedFraction(progress({ durationSeconds: 0 }))).toBe(0);
  });

  it('is zero for nothing at all', () => {
    expect(watchedFraction(null)).toBe(0);
    expect(watchedFraction(undefined)).toBe(0);
  });

  it('never exceeds one, whatever the stored position says', () => {
    expect(watchedFraction(progress({ positionSeconds: 7200, durationSeconds: 3600 }))).toBe(1);
  });

  it('never goes below zero', () => {
    expect(watchedFraction(progress({ positionSeconds: -60 }))).toBe(0);
  });

  it('reads as a percentage for a bar', () => {
    expect(watchedPercent(progress({ positionSeconds: 1800, durationSeconds: 3600 }))).toBe(50);
  });
});

describe('saysNothing', () => {
  // What the player sent for The Last Bus E2 as it closed between episodes.
  it('is a film or an episode with no position and no length', () => {
    expect(saysNothing({ type: 'series', positionSeconds: 0, durationSeconds: 0 })).toBe(true);
    expect(saysNothing({ type: 'vod', positionSeconds: 0, durationSeconds: 0 })).toBe(true);
  });

  it('keeps anything that knows where it got to, or how long it is', () => {
    expect(saysNothing({ type: 'series', positionSeconds: 2040, durationSeconds: 2056 })).toBe(false);
    expect(saysNothing({ type: 'vod', positionSeconds: 0, durationSeconds: 6240 })).toBe(false);
    expect(saysNothing({ type: 'vod', positionSeconds: 0, durationSeconds: 0, completed: true })).toBe(false);
  });

  // A channel never has a length, and is put in the history at zero on purpose.
  it('never refuses a live channel', () => {
    expect(saysNothing({ type: 'live', positionSeconds: 0, durationSeconds: 0 })).toBe(false);
  });
});

describe('isComplete', () => {
  it('trusts the stored flag', () => {
    expect(isComplete(progress({ completed: true, positionSeconds: 10 }))).toBe(true);
  });

  it('treats the closing credits as watched', () => {
    const position = 3600 * COMPLETE_FRACTION + 1;
    expect(isComplete(progress({ positionSeconds: position }))).toBe(true);
  });

  it('leaves the middle alone', () => {
    expect(isComplete(progress({ positionSeconds: 1800 }))).toBe(false);
  });

  it('is false for nothing watched', () => {
    expect(isComplete(null)).toBe(false);
  });
});

describe('resumePosition', () => {
  it('returns the stored position', () => {
    expect(resumePosition(progress({ positionSeconds: 1234 }))).toBe(1234);
  });

  it('starts from the beginning when barely begun', () => {
    expect(resumePosition(progress({ positionSeconds: RESUME_MIN_SECONDS - 1 }))).toBe(0);
  });

  it('resumes exactly at the threshold', () => {
    expect(resumePosition(progress({ positionSeconds: RESUME_MIN_SECONDS }))).toBe(
      RESUME_MIN_SECONDS
    );
  });

  it('starts from the beginning for something finished', () => {
    expect(resumePosition(progress({ completed: true, positionSeconds: 3500 }))).toBe(0);
  });

  it('starts from the beginning with no history', () => {
    expect(resumePosition(null)).toBe(0);
  });

  it('never resumes a live channel, whose position names a moment already gone', () => {
    expect(resumePosition(progress({ type: 'live', positionSeconds: 900, durationSeconds: 0 }))).toBe(0);
  });

  it('ignores a position that is not a number', () => {
    expect(resumePosition(progress({ positionSeconds: Number.NaN }))).toBe(0);
  });

  it('says whether there is anything to resume', () => {
    expect(isResumable(progress({ positionSeconds: 600 }))).toBe(true);
    expect(isResumable(progress({ positionSeconds: 2 }))).toBe(false);
  });
});

describe('formatTimecode', () => {
  it('drops the hour when there is none', () => {
    expect(formatTimecode(247)).toBe('4:07');
  });

  it('keeps the hour when there is one', () => {
    expect(formatTimecode(3847)).toBe('1:04:07');
  });

  it('pads minutes past the hour', () => {
    expect(formatTimecode(3600)).toBe('1:00:00');
  });

  it('reads zero for nothing, rather than blank or NaN', () => {
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(undefined)).toBe('0:00');
    expect(formatTimecode(Number.NaN)).toBe('0:00');
    expect(formatTimecode(-30)).toBe('0:00');
  });
});

describe('remainingLabel', () => {
  it('counts the minutes left', () => {
    expect(remainingLabel(progress({ positionSeconds: 600, durationSeconds: 3000 }))).toBe(
      '40 min left'
    );
  });

  it('reads in hours past sixty minutes', () => {
    expect(remainingLabel(progress({ positionSeconds: 0, durationSeconds: 9000 }))).toBe(
      '2 h 30 min left'
    );
  });

  it('drops the minutes on a round hour', () => {
    expect(remainingLabel(progress({ positionSeconds: 0, durationSeconds: 7200 }))).toBe('2 h left');
  });

  it('says so when it is finished', () => {
    expect(remainingLabel(progress({ completed: true }))).toBe('Watched');
  });

  it('says almost done rather than "0 min left"', () => {
    // Under the completion threshold, but with less than half a minute to go.
    expect(remainingLabel(progress({ positionSeconds: 375, durationSeconds: 400 }))).toBe(
      'Almost done'
    );
  });

  it('says nothing when there is no runtime to count against', () => {
    expect(remainingLabel(progress({ durationSeconds: 0 }))).toBe('');
    expect(remainingLabel(null)).toBe('');
  });
});

describe('episodeLabel', () => {
  it('reads season and episode', () => {
    expect(episodeLabel(2, 4)).toBe('S2 E4');
  });

  it('shows what it has', () => {
    expect(episodeLabel(null, 4)).toBe('E4');
    expect(episodeLabel(2, undefined)).toBe('S2');
    expect(episodeLabel(null, null)).toBe('');
  });

  it('keeps a zeroth season or episode, which some providers use', () => {
    expect(episodeLabel(0, 0)).toBe('S0 E0');
  });
});

describe('shortEpisodeTitle', () => {
  it('drops the show name and the episode marker the UI already shows', () => {
    expect(
      shortEpisodeTitle(
        'AF - Accidental Siblings (2024)',
        'AF - Accidental Siblings (2024) - S01E02 - Vet Drugs'
      )
    ).toBe('Vet Drugs');
  });

  it('looks past a language tag the show name does not carry', () => {
    // Supernatural on the provider, 26 September: every card read
    // "DE - Supernatural - S04..." and never reached the title.
    expect(shortEpisodeTitle('Supernatural', 'DE - Supernatural - S04E13 - Schulzeit')).toBe('Schulzeit');
    expect(shortEpisodeTitle('Supernatural', '|EXYU| Supernatural - S01E01 - Pilot')).toBe('Pilot');
  });

  it('drops the show year the name it was matched by did not carry', () => {
    expect(shortEpisodeTitle('The Chestnut Man', 'EX - The Chestnut Man (2021) - S01E01 - Episode 1')).toBe('Episode 1');
  });

  it("drops the provider's short brackets after the name, once the name was found", () => {
    expect(shortEpisodeTitle('Friends', 'EN - Friends (1994) (US) - S01E01 - Pilot')).toBe('Pilot');
    expect(shortEpisodeTitle('Supernatural', '(Part 1) The Beginning')).toBe('(Part 1) The Beginning');
  });

  it('leaves a title that only starts with short capitals', () => {
    expect(shortEpisodeTitle('Supernatural', 'CSI - The Case')).toBe('CSI - The Case');
  });

  it('leaves a title that stands on its own', () => {
    expect(shortEpisodeTitle('The Show', 'The Reichenbach Fall')).toBe('The Reichenbach Fall');
  });

  it('matches the show name whatever its casing', () => {
    expect(shortEpisodeTitle('the show', 'The Show - S02E01 - Pilot')).toBe('Pilot');
  });

  it('returns nothing when the title was only the show and the numbering', () => {
    expect(shortEpisodeTitle('The Show', 'The Show S01E01')).toBe('');
    expect(shortEpisodeTitle('The Show', 'The Show')).toBe('');
  });

  it('handles a missing title or show', () => {
    expect(shortEpisodeTitle('The Show', '')).toBe('');
    expect(shortEpisodeTitle(null, 'S01E03 - Pilot')).toBe('Pilot');
    expect(shortEpisodeTitle(undefined, undefined)).toBe('');
  });

  it('keeps a title that merely begins with the same letters', () => {
    expect(shortEpisodeTitle('The Show', 'The Showdown')).toBe('The Showdown');
  });
});

describe('flattenEpisodes', () => {
  it('runs the seasons in order', () => {
    const flat = flattenEpisodes({
      '2': [episode('c', 1, 2)],
      '1': [episode('b', 2, 1), episode('a', 1, 1)]
    });

    expect(flat.map(e => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders season 10 after season 2, not between 1 and 2', () => {
    const flat = flattenEpisodes({
      '10': [episode('ten', 1, 10)],
      '2': [episode('two', 1, 2)],
      '1': [episode('one', 1, 1)]
    });

    expect(flat.map(e => e.id)).toEqual(['one', 'two', 'ten']);
  });

  it('handles a show with no episodes at all', () => {
    expect(flattenEpisodes(undefined)).toEqual([]);
    expect(flattenEpisodes({})).toEqual([]);
    expect(flattenEpisodes({ '1': [] })).toEqual([]);
  });
});

describe('nextUp', () => {
  const episodes = [episode('e1', 1), episode('e2', 2), episode('e3', 3)];

  const at = (id: string, over: Partial<WatchProgress>): WatchProgress =>
    progress({ type: 'series', itemId: id, seriesId: '42', durationSeconds: 2700, ...over });

  it('starts a show that has never been watched at its first episode', () => {
    expect(nextUp(episodes, {})).toEqual({ episode: episodes[0], resumeAt: 0, resuming: false });
  });

  it('resumes the part-watched episode where it was left', () => {
    const result = nextUp(episodes, { e2: at('e2', { positionSeconds: 800 }) });

    expect(result).toEqual({ episode: episodes[1], resumeAt: 800, resuming: true });
  });

  it('moves on to the next episode once one is finished', () => {
    const result = nextUp(episodes, { e2: at('e2', { completed: true }) });

    expect(result).toEqual({ episode: episodes[2], resumeAt: 0, resuming: false });
  });

  it('follows the episode watched most recently, not the furthest reached', () => {
    // Someone who goes back to rewatch episode 1 means to carry on from there.
    const result = nextUp(episodes, {
      e3: at('e3', { positionSeconds: 900, updatedAt: '2026-08-01T00:00:00.000Z' }),
      e1: at('e1', { positionSeconds: 300, updatedAt: '2026-08-19T00:00:00.000Z' })
    });

    expect(result).toEqual({ episode: episodes[0], resumeAt: 300, resuming: true });
  });

  it('stays on the last episode of a show once it is finished', () => {
    const result = nextUp(episodes, { e3: at('e3', { completed: true }) });

    expect(result).toEqual({ episode: episodes[2], resumeAt: 0, resuming: false });
  });

  it('restarts an episode that was only just begun', () => {
    const result = nextUp(episodes, { e2: at('e2', { positionSeconds: 4 }) });

    expect(result).toEqual({ episode: episodes[1], resumeAt: 0, resuming: true });
  });

  it('has nothing to offer for a show with no episodes', () => {
    expect(nextUp([], {})).toBeNull();
  });

  it('ignores stored progress for an episode the show no longer lists', () => {
    const result = nextUp(episodes, { gone: at('gone', { positionSeconds: 900 }) });

    expect(result).toEqual({ episode: episodes[0], resumeAt: 0, resuming: false });
  });
});
