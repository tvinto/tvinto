/**
 * How playback should look and sound, wherever it happens.
 *
 * Three players will read this: Media3 on a television, Media3 on a phone, and
 * hls.js in a browser. They render subtitles by completely different means --
 * one draws them itself, one hands them to a WebView -- so what is shared here
 * is the *intent*, in units all three can honour, rather than anything
 * resembling CSS or an Android caption style.
 *
 * It lives in account settings, which means it travels through the change feed
 * already: set the subtitle size on the sofa and the phone opens that way. That
 * is the whole reason for pinning it down as one model rather than letting each
 * player keep its own.
 */

/** How subtitles are separated from the picture behind them. */
export type SubtitleEdge = 'none' | 'outline' | 'shadow';

/** What sits behind the text. */
export type SubtitleBackground = 'none' | 'translucent' | 'solid';

/** What the player does during an intro or a recap it knows about: offer a button, skip by itself, or nothing. */
export type SkipIntros = 'button' | 'auto' | 'off';

export const SKIP_INTROS: readonly SkipIntros[] = ['button', 'auto', 'off'];

export interface PlayerPreferences {
  /**
   * Subtitle size as a percentage of the player's default.
   *
   * Relative rather than absolute, because a television is watched from three
   * metres and a phone from thirty centimetres, and a point size that suits one
   * is unreadable or absurd on the other. Each player scales its own baseline.
   */
  subtitleScale: number;

  /** `#rrggbb`. Kept as a string because that is what both ends parse. */
  subtitleColour: string;

  subtitleBackground: SubtitleBackground;
  subtitleEdge: SubtitleEdge;

  /**
   * Preferred track languages, as ISO 639 codes, or empty for "whatever the
   * stream offers first".
   *
   * A preference rather than a selection: the track chosen on one channel means
   * nothing on the next, but "Croatian if there is one" holds across all of
   * them.
   */
  audioLanguage: string;
  subtitleLanguage: string;

  /** Whether subtitles come on by themselves when a matching track exists. */
  subtitlesEnabled: boolean;

  /**
   * Whether a television switches its refresh rate to the video's -- 50 Hz
   * for a 25 fps channel, 23.976 for a film -- so movement does not judder.
   * On unless turned off; only an Android TV's
   * player acts on it, from APK 1.0.58.
   */
  matchFrameRate: boolean;

  /**
   * Skip intro (round of 9 November): a button while an intro or a recap
   * plays, the player skipping it by itself, or neither. The times come from
   * the file's chapters or TheIntroDB (shared/tmdb/introdb.ts).
   */
  skipIntros: SkipIntros;
}

export const DEFAULT_PLAYER_PREFERENCES: PlayerPreferences = {
  subtitleScale: 100,
  subtitleColour: '#ffffff',
  subtitleBackground: 'translucent',
  subtitleEdge: 'outline',
  audioLanguage: '',
  subtitleLanguage: '',
  subtitlesEnabled: false,
  matchFrameRate: true,
  skipIntros: 'button'
};

/** The sizes offered, rather than a free number nobody wants to type. */
export const SUBTITLE_SCALES: readonly number[] = [75, 100, 125, 150, 200];

const SUBTITLE_EDGES: readonly SubtitleEdge[] = ['none', 'outline', 'shadow'];
const SUBTITLE_BACKGROUNDS: readonly SubtitleBackground[] = ['none', 'translucent', 'solid'];

/**
 * Reads preferences out of the flat string map settings are stored as.
 *
 * Every field falls back to its default independently. A value written by a
 * newer version, or corrupted, should cost that one setting and not the rest --
 * returning defaults wholesale would silently undo everything the user had
 * chosen because one field was unrecognised.
 */
export function readPlayerPreferences(stored: string | null | undefined): PlayerPreferences {
  if (!stored) {
    return { ...DEFAULT_PLAYER_PREFERENCES };
  }

  let parsed: Partial<PlayerPreferences>;
  try {
    parsed = JSON.parse(stored) as Partial<PlayerPreferences>;
  } catch {
    return { ...DEFAULT_PLAYER_PREFERENCES };
  }

  return {
    subtitleScale: nearestScale(parsed.subtitleScale),
    subtitleColour: colourOr(parsed.subtitleColour, DEFAULT_PLAYER_PREFERENCES.subtitleColour),
    subtitleBackground: oneOf(
      parsed.subtitleBackground,
      SUBTITLE_BACKGROUNDS,
      DEFAULT_PLAYER_PREFERENCES.subtitleBackground
    ),
    subtitleEdge: oneOf(parsed.subtitleEdge, SUBTITLE_EDGES, DEFAULT_PLAYER_PREFERENCES.subtitleEdge),
    audioLanguage: languageOr(parsed.audioLanguage),
    subtitleLanguage: languageOr(parsed.subtitleLanguage),
    subtitlesEnabled: parsed.subtitlesEnabled === true,
    matchFrameRate: parsed.matchFrameRate !== false,
    skipIntros: oneOf(parsed.skipIntros, SKIP_INTROS, DEFAULT_PLAYER_PREFERENCES.skipIntros)
  };
}

export function writePlayerPreferences(preferences: PlayerPreferences): string {
  return JSON.stringify(preferences);
}

/** Snaps to an offered size, so a hand-edited value cannot produce a 3px caption. */
function nearestScale(value: unknown): number {
  const wanted = Number(value);
  if (!Number.isFinite(wanted)) {
    return DEFAULT_PLAYER_PREFERENCES.subtitleScale;
  }

  return SUBTITLE_SCALES.reduce((best, scale) =>
    Math.abs(scale - wanted) < Math.abs(best - wanted) ? scale : best
  );
}

function colourOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** ISO 639 is two or three letters; anything else is not a language code. */
function languageOr(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z]{2,3}$/.test(value) ? value.toLowerCase() : '';
}

/**
 * The tracks a player ended up with, for one film or episode.
 *
 * Kept apart from `PlayerPreferences` on purpose: a preference is "Croatian if
 * there is one", which holds across everything, and this is "*that* film
 * played with these tracks", which holds for one item and nothing else. A
 * viewer who turns subtitles on for a foreign film has not asked for subtitles
 * on the news.
 *
 * Languages rather than track numbers, because a track number means nothing to
 * a different player, or to the same player after the provider re-encodes
 * something. `''` means the player did not say -- an unknown, not an answer.
 */
export interface TrackChoice {
  audioLanguage: string;
  subtitleLanguage: string;

  /**
   * The chosen track's own name, when it has one.
   *
   * A language is not enough to name a subtitle track, which is what the first
   * version of this got wrong. A film here offers "English (forced)",
   * "English" and "English (SDH)" — three tracks, one language — so asking for
   * `eng` and taking what came back always selected the first, whichever one
   * had been chosen. The title is what tells them apart.
   *
   * Matched rather than indexed: a track number would be exact for one file
   * and meaningless for the same film re-encoded, or for the same account on a
   * player that numbers them differently. Empty when the track has no title,
   * which is common and is why the language is still kept.
   */
  audioTitle: string;
  subtitleTitle: string;

  subtitlesEnabled: boolean;
}

/**
 * What to ask of the player for an item, given what is remembered about it.
 *
 * The remembered choice wins where it says anything; the account preference
 * fills the rest. So a film watched once with Croatian subtitles opens that
 * way again, and one never opened before follows the preference -- which is
 * what somebody means by both.
 */
/**
 * What a player says it played, which is looser than a choice.
 *
 * Every field can be missing or null, because that is what players do: mpv
 * answers with an error for a film with no subtitle track, and an Activity
 * that was killed answers with nothing at all.
 */
export interface ReportedTracks {
  audioLanguage?: string | null;
  subtitleLanguage?: string | null;
  audioTitle?: string | null;
  subtitleTitle?: string | null;
  subtitlesEnabled?: boolean | null;
}

export const tracksFor = (
  preferences: PlayerPreferences,
  remembered: ReportedTracks | null | undefined
): TrackChoice => {
  if (!remembered) {
    return {
      audioLanguage: preferences.audioLanguage,
      subtitleLanguage: preferences.subtitleLanguage,
      audioTitle: '',
      subtitleTitle: '',
      subtitlesEnabled: preferences.subtitlesEnabled
    };
  }

  return {
    audioLanguage: languageOr(remembered.audioLanguage) || preferences.audioLanguage,
    subtitleLanguage: languageOr(remembered.subtitleLanguage) || preferences.subtitleLanguage,
    // No preference to fall back on: nobody sets a favourite track *name*, and
    // one film's "English (SDH)" says nothing about the next film's tracks.
    audioTitle: titleOr(remembered.audioTitle),
    subtitleTitle: titleOr(remembered.subtitleTitle),
    // Deliberately not `||`: subtitles turned off for this item is an answer,
    // and the falsy one. Only an absent field falls through to the preference.
    subtitlesEnabled:
      typeof remembered.subtitlesEnabled === 'boolean'
        ? remembered.subtitlesEnabled
        : preferences.subtitlesEnabled
  };
};

/**
 * Which of the tracks on offer was meant.
 *
 * The title first, because that is the only thing that separates "English
 * (forced)" from "English (SDH)", and a language alone would take whichever
 * came first -- which is exactly the bug this exists to fix. Then the
 * language, for a film whose tracks have no titles or have been renamed. Then
 * nothing: better the player's own default than a track chosen by guesswork.
 *
 * Shared so that every player picks the same way, and so that the picking can
 * be tested without one.
 */
export const matchTrack = <T extends { language?: string | null; title?: string | null }>(
  tracks: readonly T[],
  wanted: { language: string; title: string }
): T | null => {
  const language = languageOr(wanted.language);
  const title = titleOr(wanted.title);

  const sameTitle = (track: T) => titleOr(track.title) === title;
  const sameLanguage = (track: T) => languageOr(track.language) === language;

  if (title) {
    // Both, then the title alone: a re-encode can relabel the language of a
    // track whose name is unchanged, and the name is the more specific claim.
    return (
      tracks.find(track => sameTitle(track) && (!language || sameLanguage(track))) ??
      tracks.find(sameTitle) ??
      (language ? tracks.find(sameLanguage) ?? null : null)
    );
  }

  return language ? tracks.find(sameLanguage) ?? null : null;
};

/**
 * What is worth remembering out of what a player reported.
 *
 * Null when it said nothing usable. Players that cannot report their tracks --
 * or a session that ended before they were known -- must not overwrite what
 * was remembered with emptiness.
 */
export const rememberedTracks = (reported: ReportedTracks | null | undefined): TrackChoice | null => {
  if (!reported || typeof reported.subtitlesEnabled !== 'boolean') {
    return null;
  }

  return {
    audioLanguage: languageOr(reported.audioLanguage),
    subtitleLanguage: languageOr(reported.subtitleLanguage),
    audioTitle: titleOr(reported.audioTitle),
    subtitleTitle: titleOr(reported.subtitleTitle),
    subtitlesEnabled: reported.subtitlesEnabled
  };
};

/**
 * A track's own name, tidied.
 *
 * Trimmed and length-capped rather than validated: unlike a language code this
 * is free text somebody typed into an encoder, and the only wrong answers are
 * an absent one and an unreasonable one.
 */
function titleOr(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}
