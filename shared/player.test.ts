import {
  DEFAULT_PLAYER_PREFERENCES,
  PlayerPreferences,
  readPlayerPreferences,
  matchTrack,
  rememberedTracks,
  tracksFor,
  writePlayerPreferences
} from './player';

const stored = (preferences: Partial<PlayerPreferences>): string => JSON.stringify(preferences);

describe('readPlayerPreferences', () => {
  it('returns the defaults when nothing has been chosen', () => {
    expect(readPlayerPreferences(null)).toEqual(DEFAULT_PLAYER_PREFERENCES);
    expect(readPlayerPreferences('')).toEqual(DEFAULT_PLAYER_PREFERENCES);
  });

  it('returns the defaults rather than throwing on nonsense', () => {
    expect(readPlayerPreferences('not json')).toEqual(DEFAULT_PLAYER_PREFERENCES);
  });

  it('keeps the settings it understands when one is unrecognised', () => {
    // The point of reading field by field. A value from a newer version should
    // cost that one setting, not undo everything else the user chose.
    const preferences = readPlayerPreferences(
      stored({ subtitleColour: '#ff0000', subtitleEdge: 'neon' as never })
    );

    expect(preferences.subtitleColour).toBe('#ff0000');
    expect(preferences.subtitleEdge).toBe(DEFAULT_PLAYER_PREFERENCES.subtitleEdge);
  });

  it('snaps a size to one that is offered', () => {
    // Guards against a hand-edited or half-migrated value producing a caption
    // three pixels tall.
    expect(readPlayerPreferences(stored({ subtitleScale: 130 })).subtitleScale).toBe(125);
    expect(readPlayerPreferences(stored({ subtitleScale: 3 })).subtitleScale).toBe(75);
    expect(readPlayerPreferences(stored({ subtitleScale: 10000 })).subtitleScale).toBe(200);
  });

  it('falls back when the size is not a number at all', () => {
    expect(readPlayerPreferences(stored({ subtitleScale: 'big' as never })).subtitleScale).toBe(
      DEFAULT_PLAYER_PREFERENCES.subtitleScale
    );
  });

  it('accepts a six-digit hex colour and nothing else', () => {
    expect(readPlayerPreferences(stored({ subtitleColour: '#AABBCC' })).subtitleColour).toBe(
      '#aabbcc'
    );

    for (const bad of ['red', '#fff', 'rgb(1,2,3)', '#gggggg', '']) {
      expect(readPlayerPreferences(stored({ subtitleColour: bad })).subtitleColour).toBe(
        DEFAULT_PLAYER_PREFERENCES.subtitleColour
      );
    }
  });

  it('takes a language code and ignores anything that is not one', () => {
    expect(readPlayerPreferences(stored({ audioLanguage: 'HR' })).audioLanguage).toBe('hr');
    expect(readPlayerPreferences(stored({ subtitleLanguage: 'hrv' })).subtitleLanguage).toBe('hrv');

    for (const bad of ['croatian', 'h', '1234', 'hr-HR']) {
      expect(readPlayerPreferences(stored({ audioLanguage: bad })).audioLanguage).toBe('');
    }
  });

  it('treats subtitles as off unless explicitly turned on', () => {
    // Anything truthy-but-not-true is a value that arrived by accident.
    expect(readPlayerPreferences(stored({ subtitlesEnabled: true })).subtitlesEnabled).toBe(true);
    expect(readPlayerPreferences(stored({ subtitlesEnabled: 'yes' as never })).subtitlesEnabled).toBe(
      false
    );
    expect(readPlayerPreferences(stored({})).subtitlesEnabled).toBe(false);
  });

  it('matches the frame rate unless turned off, settings saved before it existed included', () => {
    expect(readPlayerPreferences(stored({})).matchFrameRate).toBe(true);
    expect(readPlayerPreferences(stored({ matchFrameRate: false })).matchFrameRate).toBe(false);
  });

  it('offers a button for intros unless told otherwise, and keeps a word it knows', () => {
    expect(readPlayerPreferences(stored({})).skipIntros).toBe('button');
    expect(readPlayerPreferences(stored({ skipIntros: 'auto' })).skipIntros).toBe('auto');
    expect(readPlayerPreferences(stored({ skipIntros: 'sometimes' as 'off' })).skipIntros).toBe('button');
  });

  it("plays inside the desktop app unless mpv's own window was chosen", () => {
    expect(readPlayerPreferences(stored({})).desktopPlayer).toBe('app');
    expect(readPlayerPreferences(stored({ desktopPlayer: 'window' })).desktopPlayer).toBe('window');
    expect(readPlayerPreferences(stored({ desktopPlayer: 'vlc' as 'app' })).desktopPlayer).toBe('app');
  });
});

describe('round trip', () => {
  it('survives being written and read back', () => {
    const chosen: PlayerPreferences = {
      subtitleScale: 150,
      subtitleColour: '#ffff00',
      subtitleBackground: 'solid',
      subtitleEdge: 'shadow',
      audioLanguage: 'hr',
      subtitleLanguage: 'en',
      subtitlesEnabled: true,
      matchFrameRate: false,
      skipIntros: 'off',
      desktopPlayer: 'window'
    };

    expect(readPlayerPreferences(writePlayerPreferences(chosen))).toEqual(chosen);
  });

  it('survives the defaults, which is what a fresh account stores', () => {
    expect(readPlayerPreferences(writePlayerPreferences(DEFAULT_PLAYER_PREFERENCES))).toEqual(
      DEFAULT_PLAYER_PREFERENCES
    );
  });
});

describe('tracksFor', () => {
  const preferences: PlayerPreferences = {
    ...DEFAULT_PLAYER_PREFERENCES,
    audioLanguage: 'eng',
    subtitleLanguage: 'eng',
    subtitlesEnabled: false
  };

  it('follows the preference for something never opened before', () => {
    expect(tracksFor(preferences, null)).toEqual({
      audioLanguage: 'eng',
      subtitleLanguage: 'eng',
      audioTitle: '',
      subtitleTitle: '',
      subtitlesEnabled: false
    });
  });

  it('prefers what was chosen for this item', () => {
    // The whole request: a film watched once with Croatian subtitles opens
    // that way again, whatever the account prefers in general.
    expect(tracksFor(preferences, { subtitleLanguage: 'hrv', subtitlesEnabled: true })).toEqual({
      audioLanguage: 'eng',
      subtitleLanguage: 'hrv',
      audioTitle: '',
      subtitleTitle: '',
      subtitlesEnabled: true
    });
  });

  it('lets "off for this one" mean off, rather than falling back to on', () => {
    // The trap in merging: `false` is both a real answer and the falsy one.
    const wantsSubtitles = { ...preferences, subtitlesEnabled: true };

    expect(tracksFor(wantsSubtitles, { subtitlesEnabled: false }).subtitlesEnabled).toBe(false);
  });

  it('fills in from the preference what the item says nothing about', () => {
    const chosen = tracksFor(preferences, { subtitlesEnabled: true });

    expect(chosen.subtitleLanguage).toBe('eng');
    expect(chosen.audioLanguage).toBe('eng');
  });

  it('ignores a remembered language that is not one', () => {
    expect(tracksFor(preferences, { subtitleLanguage: 'not a language' }).subtitleLanguage).toBe('eng');
  });
});

describe('rememberedTracks', () => {
  it('takes what a player reported', () => {
    expect(
      rememberedTracks({
        audioLanguage: 'HRV',
        subtitleLanguage: 'hrv',
        subtitleTitle: '  English (SDH) ',
        subtitlesEnabled: true
      })
    ).toEqual({
      audioLanguage: 'hrv',
      subtitleLanguage: 'hrv',
      audioTitle: '',
      subtitleTitle: 'English (SDH)',
      subtitlesEnabled: true
    });
  });

  it('refuses to remember anything from a player that said nothing', () => {
    // A player that cannot report its tracks, or a session that ended before
    // they were known, must not replace a real memory with an empty one.
    expect(rememberedTracks(null)).toBeNull();
    expect(rememberedTracks({})).toBeNull();
    expect(rememberedTracks({ subtitleLanguage: 'hrv' })).toBeNull();
  });

  it('remembers subtitles being turned off', () => {
    expect(rememberedTracks({ subtitlesEnabled: false })).toEqual({
      audioLanguage: '',
      subtitleLanguage: '',
      audioTitle: '',
      subtitleTitle: '',
      subtitlesEnabled: false
    });
  });
});

describe('matchTrack', () => {
  /** The subtitle list of a real film here: three of them, all English. */
  const tracks = [
    { language: 'eng', title: 'English (forced)' },
    { language: 'eng', title: 'English' },
    { language: 'eng', title: 'English (SDH)' },
    { language: 'hrv', title: 'Croatian' }
  ];

  it('picks the track that was actually chosen, not the first of its language', () => {
    // The failure this exists for, reported from use: the third track was
    // chosen, the player reopened, and the first was selected -- because all
    // three say `eng` and the language was all that had been remembered.
    expect(matchTrack(tracks, { language: 'eng', title: 'English (SDH)' })).toEqual(tracks[2]);
  });

  it('finds it by name when the language has been relabelled', () => {
    const relabelled = [{ language: 'en', title: 'English (SDH)' }];

    expect(matchTrack(relabelled, { language: 'eng', title: 'English (SDH)' })).toEqual(
      relabelled[0]
    );
  });

  it('falls back to the language when the named track is gone', () => {
    // A re-encode with different names: better the right language than
    // nothing, and better than the wrong track.
    expect(matchTrack(tracks, { language: 'hrv', title: 'Hrvatski (puni)' })).toEqual(tracks[3]);
  });

  it('takes the language alone when nothing was named', () => {
    expect(matchTrack(tracks, { language: 'hrv', title: '' })).toEqual(tracks[3]);
  });

  it('chooses nothing rather than guessing', () => {
    // The player's own default is a better answer than a track picked because
    // it happened to be there.
    expect(matchTrack(tracks, { language: 'jpn', title: 'Japanese' })).toBeNull();
    expect(matchTrack(tracks, { language: '', title: '' })).toBeNull();
    expect(matchTrack([], { language: 'eng', title: 'English' })).toBeNull();
  });
});
