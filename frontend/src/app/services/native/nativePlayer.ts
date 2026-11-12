import { Skip } from '@shared/tmdb/introdb';
import { PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { ChannelBanner } from '../../utils/player-banner.utils';
import { EpisodesAhead, ShowSeasons } from '../../utils/film-presentation.utils';
import { UnfinishedPlayback } from '../../utils/playback-checkpoint.utils';

/**
 * A subtitle file the account added from OpenSubtitles, handed to the player.
 *
 * The text travels rather than a path, because only the native side can write
 * a file the player can open: the plugin writes it into the app's cache and
 * hands the player the file. WebVTT, converted before it was saved.
 * Absent from an APK older than 1.0.33, which plays without it.
 */
export interface AddedSubtitle {
  /** The sync service's id, which is also the cache file's name. */
  id: string;
  language: string;
  /** What the player's track list should call it. */
  label: string;
  text: string;
}

/** What the app asks of the native player. */
export interface NativePlayRequest {
  url: string;
  title: string;
  startAtSeconds: number;

  subtitleScale: number;
  subtitleColour: string;
  subtitleBackground: string;
  subtitleEdge: string;
  audioLanguage: string;
  subtitleLanguage: string;

  /**
   * The name of the track this item was last watched with.
   *
   * A language does not identify a track: three of them can say `eng` and
   * differ only by name -- "English (forced)", "English", "English (SDH)".
   */
  audioTitle: string;
  subtitleTitle: string;

  subtitlesEnabled: boolean;

  /** Whether a television matches its refresh rate to the video (FrameRateMatch). APK 1.0.58 and later. */
  matchFrameRate?: boolean;

  /** The app's language, "en", "hr", "de"..., for the player's own words. Older APKs ignore it and speak English. */
  language?: string;

  /**
   * The player's words in that language, as flat JSON by key (Texts.java).
   * APKs from 1.0.136 use them; older ones know only English and Croatian.
   */
  texts?: string;

  /**
   * Which player to use.
   *
   * Media3 by default: leaner, and uses hardware decoding where the hardware
   * will have it. VLC carries its own decoders and plays what the platform
   * cannot, at the cost of doing the work in software.
   */
  engine: 'media3' | 'vlc';

  /**
   * Whether the player keeps its position on the device while it plays and
   * sends it up once a minute (PlaybackCheckpoint.java). For a film or an
   * episode. Ignored by an APK older than this.
   */
  reportProgress?: boolean;
  /** The item the position belongs to, until the player goes on to another. */
  progressItemId?: string;

  /**
   * Whether the remote's channel keys, and Up and Down while the controls are
   * hidden, may close the player to change channel. Live channels only. Absent
   * on an APK older than 1.0.24, which ignores it.
   */
  channelKeys?: boolean;

  /**
   * Whether channel keys are answered with switchStream inside the open player
   * rather than by the player closing. Ignored
   * by an APK older than 1.0.31, which closes as before -- so a result carrying
   * `channelStep` still has to be handled.
   */
  inPlayerSwitching?: boolean;

  /** The channel being opened, for the switching panel's "from" line and the result. */
  itemId?: string;
  channelNumber?: string;
  channelName?: string;
  monogram?: string;
  /** What the banner says about it (PL-TV-1). */
  banner?: ChannelBanner;

  /** Subtitles the account added for this item. */
  subtitles?: AddedSubtitle[];

  /**
   * A film or an episode, for the player's own controls (design section 5b).
   * Absent for live, and ignored by an APK older than 1.0.51, which keeps
   * Media3's stock controls.
   */
  kind?: 'film' | 'episode';
  heading?: string;
  displayTitle?: string;
  meta?: string;
  /** What it is about, for the screen a long pause brings up (PX-TV-8). APK 1.0.129 and later. */
  description?: string;
  poster?: string;
  /** The opening panel's reason line: "Trying the backup player" when VLC takes over. */
  openingLine?: string;
  /** The episodes that follow, for the player to go on to by itself (PL-TV-6b). APK 1.0.52 and later. */
  upNext?: EpisodesAhead;
  /** Its intro, recap and credits, for Skip intro. Ignored by an APK older than the one that has it. */
  skips?: Skip[];
  /** What to do with them (PlayerPreferences.skipIntros); a button when absent. */
  skipIntros?: 'button' | 'auto' | 'off';
}

/** The player went on to the next episode by itself, having got this far into the last one. */
export interface EpisodeChangedEvent {
  itemId: string;
  positionSeconds: number;
  durationSeconds: number;
  /** The episode it went on to. */
  to: string;
}

/** A channel to switch to inside the open player. */
export interface SwitchStreamRequest {
  /** Carries the credentials: never logged. */
  url: string;
  itemId: string;
  channelNumber: string;
  channelName: string;
  monogram: string;
  /** "HRT 1 · 101", under the name: where this switch came from. */
  from: string;
  /** "HRT 1", on the retry: where Back goes. */
  back: string;
  /** How long after stopping the old stream to open this one. */
  waitMs: number;
  attempt: 1 | 2;
  /** What the banner says once it arrives (PL-TV-1). */
  banner: ChannelBanner;
}

/** One channel as number entry and the mini guide show it (PL-TV-3, PL-TV-4). */
export interface DirectoryChannel {
  itemId: string;
  number: string;
  name: string;
  tags: string;
  hasGuide: boolean;
  now: { title: string; startMs: number; stopMs: number } | null;
  next: { title: string; startMs: number; stopMs: number } | null;
}

/** The list the player can reach by number or in the mini guide, and what it is called. */
export interface ChannelDirectory {
  title: string;
  channels: DirectoryChannel[];
}

/** The player asking for another channel: a key, Back while a switch is on screen, or a channel chosen. */
export interface ChannelRequestedEvent {
  step: 'next' | 'previous' | 'last' | 'cancel' | 'jump';
  /** For a jump: the channel chosen by number or in the mini guide. */
  to?: string;
  itemId: string;
  /** Whether the channel being left had shown a picture. */
  started: boolean;
}

/** What comes back when the player screen goes away. */
export interface NativePlayResult {
  positionSeconds: number;
  /** Zero when unknown, which is the normal case for live. */
  durationSeconds: number;
  /**
   * Whether there is a position worth recording.
   *
   * False when playback failed. A failure carries a position too -- where the
   * stream got to before giving up -- but it is not somewhere the viewer chose
   * to stop, and recording it would put a film nobody watched into the history
   * with a resume point of four seconds.
   */
  played: boolean;

  /**
   * Media3's name for what went wrong, or null.
   *
   * The name rather than the message: ERROR_CODE_IO_BAD_HTTP_STATUS says the
   * useful thing in a form that can be shown or matched on, where the message
   * is a paragraph meant for a log.
   */
  errorCode: string | null;

  /**
   * The tracks that were actually playing when the viewer left, if the player
   * said.
   *
   * Absent or null means it did not, which is not the same as "no subtitles":
   * a film that failed to open must not erase what was remembered about it.
   */
  audioLanguage?: string | null;
  subtitleLanguage?: string | null;
  audioTitle?: string | null;
  subtitleTitle?: string | null;
  subtitlesEnabled?: boolean | null;

  /** Set when the viewer closed the player to change channel: which way. */
  channelStep?: 'next' | 'previous' | 'last' | null;

  /**
   * The channel on screen when the player closed. After switching inside the
   * player this is not the one asked for. Absent from an APK older than 1.0.31.
   */
  itemId?: string | null;
}

/** Where a film or an episode has got to, while it plays. */
export interface PlaybackProgressEvent {
  itemId: string;
  positionSeconds: number;
  durationSeconds: number;
}

export interface NativePlayerPlugin {
  /**
   * Plays something, and resolves when the viewer leaves it.
   *
   * One call for the whole session rather than a stream of events, because
   * there is nothing useful to say while it plays -- the Activity owns the
   * transport, the tracks and the subtitles once it starts, and it can do all
   * of that better than anything driving it across a bridge.
   */
  play(request: NativePlayRequest): Promise<NativePlayResult>;

  /** Stops the open player's stream and opens another after `waitMs`. APK 1.0.31 and later. */
  switchStream(request: SwitchStreamRequest): Promise<void>;

  /** What the banner says about the channel first opened, when the guide answered after the player opened. */
  updateBanner(options: { itemId: string; banner: ChannelBanner }): Promise<void>;

  /** The channels number entry and the mini guide can reach. APK 1.0.31 and later. */
  setChannels(directory: ChannelDirectory): Promise<void>;

  /** Both attempts at a channel failed: the player says so and waits for Back. */
  giveUp(options: { backTo: string }): Promise<void>;

  /** Closes the player reporting the switched stream's failure. */
  closePlayer(): Promise<void>;

  /**
   * Every episode of the show by season, for the player about to open (PX-TV-3).
   * A call of its own, never part of `play`: Android saves `play`'s options with
   * the app's state, and a long show's took it past Binder's limit. APK 1.0.130.
   */
  setSeasons(options: ShowSeasons): Promise<void>;

  /** More of the season for the episode now open, after the player went on to it. */
  setEpisodesAhead(options: { itemId: string; upNext: EpisodesAhead }): Promise<void>;

  /** A viewing whose player never closed, with where it got to, once; empty when there is none. */
  takeUnfinished(): Promise<UnfinishedPlayback>;

  addListener(event: 'episodeChanged', listener: (event: EpisodeChangedEvent) => void): Promise<PluginListenerHandle>;
  /** Where a film or an episode has got to, once a minute while it plays. */
  addListener(event: 'progress', listener: (event: PlaybackProgressEvent) => void): Promise<PluginListenerHandle>;

  addListener(event: 'channelRequested', listener: (event: ChannelRequestedEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'channelStarted', listener: (event: { itemId: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'switchFailed', listener: (event: { itemId: string; errorCode: string }) => void): Promise<PluginListenerHandle>;
}

/**
 * Resolved lazily by Capacitor, and absent in a browser.
 *
 * registerPlugin always returns an object; calling a method on it in a browser
 * rejects rather than throwing at import time, which is why the decision about
 * whether to use it is made in NativePlayerService rather than here.
 */
export const NativePlayer = registerPlugin<NativePlayerPlugin>('NativePlayer');
