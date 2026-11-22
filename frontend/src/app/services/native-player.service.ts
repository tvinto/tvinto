import { RECORDING_HOLDS_CONNECTION, RecordingsService } from './recordings.service';
import { Skip } from '@shared/tmdb/introdb';
import { Injectable, inject, signal } from '@angular/core';
import { StreamType } from '@shared/types';
import { rememberedTracks, tracksFor } from '@shared/player';
import { PlayerPreferencesService } from './player-preferences.service';
import { PlatformService } from './platform.service';
import { LocalUserDataService } from './local-user-data.service';
import { AddedSubtitle, ChannelDirectory, NativePlayRequest, NativePlayResult, NativePlayer } from './native/nativePlayer';
import { SubtitleItemType } from '@shared/subtitles';
import { shiftWebVtt, withoutStyleTags } from '@shared/opensubtitles/vtt';
import { SubtitleLibraryService } from './subtitle-library.service';
import { SwitchAction, SwitchEvent, SwitchState, nextSwitch, startSwitching } from '../utils/channel-switch.utils';
import { ChannelBanner } from '../utils/player-banner.utils';
import { DesktopVideoService, playingTarget } from './desktop-video.service';
import { DesktopPlayerBridge, SwitchBridge, androidBridge, desktopBridge } from './native/switch-bridge';
import { tooBigToDecodeInSoftware } from '../utils/failure-messages.utils';
import { AheadEpisode, EpisodesAhead, FilmPresentation, ShowSeasons } from '../utils/film-presentation.utils';
import { currentLanguage, nativePlayerWords, t } from '../utils/i18n';
import { PLAYING_KEY, ProgressEntry, readPlayingRecord, recoveredProgress } from '../utils/playback-checkpoint.utils';
import { WatchProgressInput } from '@shared/types';

/** What the Electron preload puts on the window, and nothing else. */
interface DesktopBridge {
  play(request: Record<string, unknown>): Promise<NativePlayResult>;
  /** Absent from a main process older than switching inside mpv. */
  player?: DesktopPlayerBridge;
}

const desktop = (): DesktopBridge | null =>
  (window as { xtreamDesktop?: DesktopBridge }).xtreamDesktop ?? null;

/**
 * What the desktop player says when there is no mpv to run.
 *
 * Spelled the same on both sides of the bridge; the main process defines it in
 * electron/src/player.ts and this must agree.
 */
const MPV_MISSING = 'mpv-missing';

/** What a caller wants played. */
export interface PlayRequest {
  url: string;
  title: string;
  startAtSeconds: number;

  /**
   * Which item this is, when it is one.
   *
   * Given so that the tracks it ends up playing with can be remembered against
   * it and used again next time. Absent for anything with no identity worth
   * remembering -- and harmless when absent: the account's preference decides,
   * as it always did.
   */
  item?: {
    type: StreamType;
    id: string;
    /** For an episode, its show: what another episode was watched with is used for this one. */
    showId?: string;
  };

  /**
   * Subtitles the account added for this item, if they have been fetched.
   *
   * Left out by every caller: this service fetches them itself from `item`,
   * so that every way of starting playback gets them without being taught to.
   */
  subtitles?: AddedSubtitle[];

  /** What the player's own controls say about a film or an episode. Absent for live. */
  presentation?: FilmPresentation;

  /**
   * Why this is being opened, for the opening panel's reason line: another
   * copy, after the last one failed. Films and episodes only, as the panel
   * is theirs. VLC taking over says its own line instead.
   */
  openingLine?: string;

  /** Stretches of this film or episode to offer to skip: its intro, recap and credits. */
  skips?: Skip[];

  /** The episodes that follow this one, for the next-episode card on Android (PL-TV-6b). */
  episodes?: EpisodeRun;

  /**
   * Saving where a film or an episode has got to while it plays, rather than
   * only when the player closes (PlaybackCheckpoint). Absent for live.
   */
  checkpoint?: PlaybackCheckpoint;

  /** Whether the player may close to change channel. See NativePlayRequest. */
  channelKeys?: boolean;

  /**
   * The channels to switch between inside the player, for a live channel on
   * Android. Without it, or on an APK too old to switch, channel keys close the
   * player and the caller opens the next one itself.
   */
  channels?: ChannelRun;
}

/**
 * What a page that plays a film or an episode says about saving its progress
 * along the way.
 */
export interface PlaybackCheckpoint {
  /**
   * The history entry, without its position, for each item this play can
   * reach: the film, or the show's episodes, since the player goes on to the
   * next by itself. Kept on the device while the player is open, so a viewing
   * that never closed can still be saved at the next launch.
   */
  entries(): Record<string, ProgressEntry>;
  /** The player has got this far into an item, and is still playing. */
  reached(itemId: string, positionSeconds: number, durationSeconds: number): void;
}

/**
 * What playing the next episode inside the player needs from the show's page.
 * The page knows the episodes and builds their addresses; the player is handed
 * them in advance and goes on by itself (EpisodesAhead).
 */
export interface EpisodeRun {
  /** The episodes after this one, with their addresses, and whether the season ends there. */
  ahead(itemId: string): Promise<EpisodesAhead>;
  /** This episode was left for the next one, having got this far. */
  left(itemId: string, positionSeconds: number, durationSeconds: number): void;
  /** Every episode of the show by season, for the player's Episodes (PX-TV-3). */
  seasons?(): Promise<ShowSeasons>;
}

/** A channel as the switching panel names it. */
export interface ChannelEntry {
  itemId: string;
  /** "RTL LIVING", without the provider's prefix and tags. */
  name: string;
  /** "112", or empty when the provider gives none. */
  number: string;
  /** "RTL", for the plate. */
  monogram: string;
}

/** What switching inside the player needs from the page that opened it. */
export interface ChannelRun {
  /** The channel being opened, and the list the keys step through. */
  current: ChannelEntry;
  list: readonly ChannelEntry[];
  /** The channel watched before this one, for the last-channel key. */
  previous: ChannelEntry | null;
  /** The address to play a channel at. Carries credentials: never logged. */
  addressOf(itemId: string): Promise<string>;
  /** What the banner says about a channel, from this device's guide. */
  bannerFor(itemId: string): Promise<ChannelBanner>;
  /** The list with numbers and what is on, for number entry and the mini guide. */
  directory(): Promise<ChannelDirectory>;
  /** A channel that showed a picture has been left for another. */
  left(entry: ChannelEntry): void;
  /** A switched channel is now showing. */
  arrived(entry: ChannelEntry): void;
}

/**
 * Whether playback happens outside the WebView, and if so, arranging it.
 *
 * The switch is the same shape as the one for the catalogue: a device can do
 * something a browser cannot, so it does, and the browser keeps the path that
 * has always worked. Here the difference is starker than usual -- a great many
 * Xtream live channels are raw MPEG-TS, which a <video> element will not play
 * under any circumstances, so on a device this is not an improvement to
 * playback but the difference between playing and not.
 *
 * Failures fall back rather than surfacing. If the plugin is missing from a
 * build, or the Activity refuses to start, the caller carries on with the
 * WebView player and the viewer sees whatever that manages.
 */
/** How long playback waits for the account's added subtitles before going without. */
const ADDED_SUBTITLES_TIMEOUT_MS = 5000;

@Injectable({ providedIn: 'root' })
export class NativePlayerService {
  private readonly preferences = inject(PlayerPreferencesService);
  private readonly platform = inject(PlatformService);
  private readonly library = inject(SubtitleLibraryService);
  private readonly local = inject(LocalUserDataService);
  private readonly recordings = inject(RecordingsService);
  private readonly desktopVideo = inject(DesktopVideoService);

  /** Whether this build has a player that is not the WebView's. */
  readonly available = this.platform.hasNativePlayer;

  /**
   * Plays something and resolves when the viewer comes back, or null if the
   * native player could not take it.
   *
   * Null rather than throwing, because "could not" here is a routing decision
   * and not an error: the caller's answer to it is to use the other player,
   * which is a perfectly good outcome.
   */
  async play(request: PlayRequest): Promise<NativePlayResult | null> {
    if (!this.available) {
      return null;
    }
    // Every stream from the provider needs a connection, and a recording may
    // hold the only one. Refused here, for every way of playing, with a
    // reason the caller shows; a recording itself (a file) always plays.
    // The channel being recorded is watched from its recording: no second connection.
    const recorded = request.item?.type === 'live' ? await this.recordings.watchAddress(request.item.id) : null;
    if (recorded) {
      request = { ...request, url: recorded, channelKeys: false, channels: undefined };
    } else if (/^https?:/i.test(request.url) && !/^http:\/\/127\.0\.0\.1:/.test(request.url) && !this.recordings.mayOpen(request.item?.id ?? null)) {
      return { positionSeconds: 0, durationSeconds: 0, played: false, errorCode: RECORDING_HOLDS_CONNECTION };
    }

    this.active.set(true);
    const stopCheckpoint = await this.beginCheckpoint(request);
    try {
      return await this.playAndReturn(request);
    } finally {
      stopCheckpoint();
      this.active.set(false);
    }
  }

  /**
   * Writes down what this play can reach and listens for the player's
   * position while it plays; the returned function undoes both. Nothing for
   * a play without a checkpoint.
   */
  private async beginCheckpoint(request: PlayRequest): Promise<() => void> {
    const checkpoint = request.checkpoint;
    if (!checkpoint) {
      return () => undefined;
    }
    try {
      localStorage.setItem(PLAYING_KEY, JSON.stringify({ at: Date.now(), entries: checkpoint.entries() }));
    } catch {
      // Storage full or unavailable: the position is still saved along the way.
    }

    let stopListening: () => void = () => undefined;
    const bridge = desktop();
    if (this.platform.platform === 'electron' && bridge?.player) {
      const itemId = request.item?.id;
      stopListening = bridge.player.onEvent(event => {
        if (event.type === 'progress' && itemId) {
          checkpoint.reached(itemId, event.positionSeconds, event.durationSeconds);
        }
      });
    } else if (this.platform.platform !== 'electron') {
      const handle = await NativePlayer.addListener('progress', event =>
        checkpoint.reached(event.itemId, event.positionSeconds, event.durationSeconds)
      ).catch(() => null);
      stopListening = () => void handle?.remove();
    }

    return () => {
      stopListening();
      try {
        localStorage.removeItem(PLAYING_KEY);
      } catch {
        // Read and checked against the player's own record at the next launch anyway.
      }
    };
  }

  /**
   * A film or an episode whose player never closed -- the app or the device
   * went down mid-way -- as the history entry to save, once; null when there
   * is none. The player kept the position (PlaybackCheckpoint.java), the page
   * what it belongs to (PLAYING_KEY).
   */
  async takeUnfinished(): Promise<WatchProgressInput | null> {
    if (!this.available || this.platform.platform === 'electron') {
      return null;
    }
    const unfinished = await NativePlayer.takeUnfinished().catch(() => null);
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(PLAYING_KEY);
      localStorage.removeItem(PLAYING_KEY);
    } catch {
      return null;
    }
    return recoveredProgress(readPlayingRecord(stored), unfinished);
  }

  /**
   * Whether a native player has the screen right now.
   *
   * For work that should wait until nobody is watching -- an automatic guide
   * download competing with a live stream for the same line is a stutter the
   * viewer did nothing to deserve.
   */
  readonly active = signal(false);

  private async playAndReturn(request: PlayRequest): Promise<NativePlayResult | null> {
    request = { ...request, subtitles: request.subtitles ?? (await this.addedSubtitles(request)) };

    // On the desktop there is one player and it plays everything, so there is
    // no first attempt to fall back from. mpv carries its own decoders, which
    // is the whole reason a desktop build exists rather than a browser tab.
    if (this.platform.platform === 'electron') {
      const played = await this.playOnDesktop(request);
      return this.remember(played ? this.switchedRequest(request, played) : request, played);
    }

    const first = await this.playWith(request, 'media3');
    if (!first) {
      return null;
    }

    // After switching inside the player, a failure belongs to the channel it
    // had switched to: that is the one to hand VLC, and to remember tracks for.
    // The same for an episode that followed another.
    request = this.episodeRequest(this.switchedRequest(request, first), first);

    /**
     * Media3 could not decode it, so hand the same stream to VLC.
     *
     * Media3 asks Android for a decoder and a device offers only what its
     * vendor shipped -- 10-bit HEVC is missing from a great many of them,
     * including every decoder on the TV emulator. VLC carries its own, so what
     * the platform refuses it plays anyway, in software.
     *
     * Retried rather than offered as a choice: being told a film cannot be
     * played, on a device holding something that can play it, is not a decision
     * worth handing to the viewer. Media3 stays first because when hardware
     * will take the work, it should.
     *
     * Not for 4K. No TV box decodes a 4K picture in software fast enough to
     * show a frame: X-Men [UHD] went to VLC on the TV emulator, played black
     * with every frame five seconds late, and the app was killed for the
     * memory it took (24 September). The failure goes back to the screen that
     * asked, which says so and offers another version of the film.
     */
    if (this.isDecodingFailure(first) && !tooBigToDecodeInSoftware(first.errorCode)) {
      console.warn(`Media3 could not decode this; retrying with VLC (${first.errorCode})`);

      const second = await this.playWith(
        // The later of the two: Media3 may give up before its seek into the
        // file has landed, and report somewhere short of where the viewer was
        // (X-Men resumed at 1:00 instead of 5:00, 24 September).
        { ...request, startAtSeconds: Math.max(first.positionSeconds || 0, request.startAtSeconds || 0) },
        'vlc',
        t('player.backup')
      );

      if (second) {
        return this.remember(request, { ...second, itemId: second.itemId ?? request.item?.id ?? null });
      }
    }

    return this.remember(request, first);
  }

  /**
   * What to ask the player for: what this item was watched with, or failing
   * that what the account prefers.
   *
   * The remembered choice is only ever a device's own copy here. It arrived
   * from wherever it was made through the change feed, like everything else
   * the account knows.
   */
  private tracksWanted(request: PlayRequest) {
    const item = request.item;
    let remembered = item && this.local.enabled ? this.local.tracksFor(item.type, item.id) : null;
    // An episode opens the way the show was last watched -- its own choice
    // included, when that is the latest. Its own came first before, so an
    // episode opened once with subtitles off stayed off after English had been
    // chosen in the one before it (27 September).
    if (item?.type === 'series' && this.local.enabled) {
      const show = item.showId ?? this.local.showOf(item.id);
      remembered = (show ? this.local.tracksForShow(show) : null) ?? remembered;
    }

    return tracksFor(this.preferences.preferences(), remembered);
  }

  /**
   * Writes down the tracks the player ended up with, against this item.
   *
   * Only what a player actually reported, and only for something with an
   * identity: `rememberedTracks` refuses everything else, so a player that
   * cannot say, or a film that would not open, leaves the memory alone rather
   * than replacing it with emptiness.
   */
  private remember(
    request: PlayRequest,
    result: NativePlayResult | null
  ): NativePlayResult | null {
    const learned = rememberedTracks(result);

    if (learned && request.item && this.local.enabled) {
      this.local.rememberTracks(request.item.type, request.item.id, learned);
    }

    return result;
  }

  /**
   * Plays through mpv, in its own window, alongside the app.
   *
   * Null when the bridge is not there -- an Electron build whose preload did
   * not run -- which sends the caller back to the in-page player rather than
   * leaving them with nothing.
   */
  private async playOnDesktop(request: PlayRequest): Promise<NativePlayResult | null> {
    const bridge = desktop();
    if (!bridge) {
      console.warn('Desktop player bridge missing; using the web player');
      return null;
    }

    const chosen = this.preferences.preferences();
    const tracks = this.tracksWanted(request);

    // Switching inside mpv when the main process can (plan, stage 4); the
    // quit codes otherwise.
    const run = request.channelKeys && bridge.player ? request.channels : undefined;
    let stopListening: (() => void) | null = null;

    try {
      if (run && bridge.player) {
        const channels = desktopBridge(bridge.player, run.current, channel => {
          if (!this.desktopVideo.open()) {
            return false;
          }
          this.desktopVideo.showBanner(channel);
          return true;
        });
        stopListening = await this.listenForSwitching(run, channels);
        void run.bannerFor(run.current.itemId).then(banner => channels.updateBanner({ itemId: run.current.itemId, banner }), () => undefined);
      }
      this.desktopVideo.presentation.set(request.presentation ?? null);
      this.desktopVideo.playing.set(playingTarget(request.item, request.presentation, request.title));
      const kept = this.desktopVideo.kept();
      const result = await bridge.play({
        url: request.url,
        title: request.presentation ? [request.presentation.heading, request.presentation.title].filter(Boolean).join(' · ') : request.title,
        volume: kept.volume,
        muted: kept.muted,
        startAtSeconds: Math.max(0, Math.floor(request.startAtSeconds)),
        subtitleScale: chosen.subtitleScale,
        subtitleColour: chosen.subtitleColour,
        subtitleBackground: chosen.subtitleBackground,
        subtitleEdge: chosen.subtitleEdge,
        audioLanguage: tracks.audioLanguage,
        subtitleLanguage: tracks.subtitleLanguage,
        audioTitle: tracks.audioTitle,
        subtitleTitle: tracks.subtitleTitle,
        subtitlesEnabled: tracks.subtitlesEnabled,
        reportProgress: !!request.checkpoint,
        channelKeys: request.channelKeys === true,
        inPlayerSwitching: !!run,
        itemId: run?.current.itemId,
        subtitles: request.subtitles,
        skips: request.skips?.length && chosen.skipIntros !== 'off' ? request.skips : undefined,
        skipIntros: chosen.skipIntros,
        // Inside the app (tvinto-player) or mpv's own window (shared/player.ts).
        engine: chosen.desktopPlayer,
        skipWords: { intro: t('player.skipIntroDesktop'), recap: t('player.skipRecapDesktop') },
        // A live channel can be paused in mpv (electron/src/livePause.ts).
        live: request.item?.type === 'live',
        liveWords: {
          paused: t('nativePlayer.film.paused'),
          behind: t('nativePlayer.live.behind'),
          backToLive: t('nativePlayer.live.backToLive'),
          cannotPause: t('nativePlayer.live.cannotPause'),
          reconnecting: t('nativePlayer.live.reconnecting'),
          stopped: t('nativePlayer.live.stopped'),
          tryAgain: t('nativePlayer.live.tryAgain')
        }
      });

      // No mpv installed is not a failure to play, it is this player not being
      // here -- and there is another. Null sends the caller to the in-page
      // player, which handles everything except the codecs Chromium lacks, so
      // an ordinary film plays rather than reporting a missing program.
      if (result.errorCode === MPV_MISSING) {
        console.warn('mpv is not installed; using the in-page player');
        return null;
      }

      return result;
    } catch (error) {
      console.warn('Desktop player failed; using the web player', error);
      return null;
    } finally {
      stopListening?.();
    }
  }

  /** The episode the player went on to last, while a player is open. */
  private episodeOpened: { itemId: string; url: string; presentation: FilmPresentation } | null = null;

  /** The request as it stands after the player went on to later episodes: the one on screen at the end. */
  private episodeRequest(request: PlayRequest, result: NativePlayResult): PlayRequest {
    const last = this.episodeOpened;
    this.episodeOpened = null;
    if (!last || !request.item || result.itemId !== last.itemId) {
      return request;
    }
    return {
      ...request,
      url: last.url,
      title: last.presentation.title,
      startAtSeconds: 0,
      item: { ...request.item, id: last.itemId },
      presentation: last.presentation
    };
  }

  /**
   * Keeps up with a player going on to later episodes by itself: records
   * where the one left got to, and hands over more of the season. Neither is
   * on the way to the next episode opening, so a page slowed down behind the
   * player -- which is what it is while the player has the screen -- costs
   * nothing but a late record.
   */
  private async listenForEpisodes(run: EpisodeRun, known: Map<string, AheadEpisode>): Promise<() => void> {
    this.episodeOpened = null;
    const handle = await NativePlayer.addListener('episodeChanged', event => {
      run.left(event.itemId, event.positionSeconds, event.durationSeconds);
      const now = known.get(event.to);
      if (now) {
        this.episodeOpened = {
          itemId: now.itemId,
          url: now.url,
          presentation: { kind: 'episode', heading: now.showName, title: now.title, poster: now.poster }
        };
      }
      void run
        .ahead(event.to)
        .then(more => {
          more.ahead.forEach(one => known.set(one.itemId, one));
          return NativePlayer.setEpisodesAhead({ itemId: event.to, upNext: more });
        })
        .catch(error => console.warn('Could not hand the player more of the season', error));
    });
    return () => void handle.remove();
  }

  /** The channel last switched to, and its address, while a player is open. */
  private switchedTo: { entry: ChannelEntry; url: string } | null = null;

  /** The request as it stands after switching: the channel on screen at the end. */
  private switchedRequest(request: PlayRequest, result: NativePlayResult): PlayRequest {
    const last = this.switchedTo;
    this.switchedTo = null;
    if (!last || !request.item || !result.itemId || result.itemId === request.item.id || result.itemId !== last.entry.itemId) {
      return request;
    }
    return {
      ...request,
      url: last.url,
      title: last.entry.name,
      startAtSeconds: 0,
      item: { type: request.item.type, id: last.entry.itemId },
      // VLC, taking over a channel Media3 could not decode, goes on switching
      // from that channel.
      channels: request.channels ? { ...request.channels, current: last.entry, previous: null } : undefined
    };
  }

  /**
   * Listens to the open player for channel keys, and answers them.
   *
   * What to do is decided by `nextSwitch` (tested); this carries it out. The
   * old stream is stopped by the player when the answer arrives, so the wait
   * before the new one counts from the moment the connection closed.
   */
  private async listenForSwitching(run: ChannelRun, bridge: SwitchBridge): Promise<() => void> {
    const byId = new Map(run.list.map(entry => [entry.itemId, entry]));
    byId.set(run.current.itemId, run.current);
    if (run.previous) {
      byId.set(run.previous.itemId, run.previous);
    }
    const label = (id: string | null) => {
      const entry = id ? byId.get(id) : undefined;
      return entry ? [entry.name, entry.number].filter(Boolean).join(' · ') : '';
    };

    let state: SwitchState = startSwitching(
      run.list.map(entry => entry.itemId),
      run.current.itemId,
      run.previous?.itemId ?? null
    );
    this.switchedTo = null;

    // Each answer is numbered, so an address that took a moment to make is
    // not sent after a later press has already asked for another channel.
    let answer = 0;
    let switchedOnce = false;

    const carryOut = async (action: SwitchAction, at: SwitchState, number: number) => {
      switch (action.kind) {
        case 'switch': {
          const entry = byId.get(action.to);
          if (!entry) {
            return;
          }
          const [url, banner] = await Promise.all([run.addressOf(action.to), run.bannerFor(action.to)]);
          if (number !== answer) {
            return;
          }
          switchedOnce = true;
          this.switchedTo = { entry, url };
          await bridge.switchStream({
            url,
            itemId: entry.itemId,
            channelNumber: entry.number,
            channelName: entry.name,
            monogram: entry.monogram,
            from: label(at.origin),
            back: byId.get(at.origin ?? '')?.name ?? '',
            waitMs: action.waitMs,
            attempt: action.attempt,
            banner
          });
          return;
        }
        case 'giveUp':
          await bridge.giveUp({ backTo: byId.get(action.backTo ?? '')?.name ?? '' });
          return;
        case 'close':
          await bridge.closePlayer();
          return;
        case 'none':
          return;
      }
    };

    const handle = (event: SwitchEvent) => {
      const before = state;
      const { state: after, action } = nextSwitch(state, event);
      state = after;

      if (event.kind === 'requested' && action.kind === 'switch' && before.started) {
        const leaving = byId.get(before.current);
        if (leaving) {
          run.left(leaving);
        }
      }
      if (event.kind === 'started' && switchedOnce && !before.started) {
        const arrived = byId.get(after.current);
        if (arrived) {
          run.arrived(arrived);
        }
      }

      if (action.kind !== 'none') {
        answer += 1;
        carryOut(action, after, answer).catch(error =>
          console.warn('Switching channel inside the player failed', error)
        );
      }
    };

    return bridge.listen({
      requested: event =>
        event.step === 'jump'
          ? event.to && handle({ kind: 'jump', to: event.to })
          : handle({ kind: 'requested', step: event.step }),
      started: () => handle({ kind: 'started' }),
      failed: event => handle({ kind: 'failed', errorCode: event.errorCode })
    });
  }

  /** Whether the failure was about decoding, rather than about reaching it. */
  private isDecodingFailure(result: NativePlayResult): boolean {
    return !!result.errorCode && /decode|DECODING|DECODER/i.test(result.errorCode);
  }

  /** One subtitle saved on the account, as a player is handed it. */
  async subtitleForPlayer(id: string): Promise<AddedSubtitle> {
    const file = await this.library.withText(id);
    return {
      id: file.id,
      language: file.language,
      label: `${file.language.toUpperCase()} · added`,
      // Cleaned here as well as when it was saved, because subtitles added
      // before that was done are still on the account. The offset is baked
      // into the cue times, which is the one answer all three players take:
      // Media3 has no subtitle delay at all.
      text: shiftWebVtt(withoutStyleTags(file.text), file.offsetMs)
    };
  }

  /**
   * Subtitles the account added for this item, for the player to show.
   *
   * Best effort and time-limited: a sync service that is slow or unreachable
   * must not hold up a film. Two at most -- a player's track list is a menu,
   * not a library, and nobody chose ten.
   */
  private async addedSubtitles(request: PlayRequest): Promise<AddedSubtitle[]> {
    const item = request.item;
    if (!item || (item.type !== 'vod' && item.type !== 'series')) {
      return [];
    }

    const fetch = async (): Promise<AddedSubtitle[]> => {
      const saved = (await this.library.saved(item.type as SubtitleItemType, String(item.id))).slice(0, 2);
      return Promise.all(saved.map(one => this.subtitleForPlayer(one.id)));
    };

    try {
      return await Promise.race([
        fetch(),
        new Promise<AddedSubtitle[]>(resolve => setTimeout(() => resolve([]), ADDED_SUBTITLES_TIMEOUT_MS))
      ]);
    } catch {
      // Nothing added, or the service said no. The stream's own tracks remain.
      return [];
    }
  }

  private async playWith(
    request: PlayRequest,
    engine: 'media3' | 'vlc',
    openingLine?: string
  ): Promise<NativePlayResult | null> {
    const chosen = this.preferences.preferences();
    const tracks = this.tracksWanted(request);

    // Both players switch inside themselves (plan, stages 1 and 3).
    const run = request.channelKeys ? request.channels : undefined;
    let stopListening: (() => void) | null = null;

    try {
      // What is on, if the guide answers quickly; otherwise the player opens
      // without it and is told when it arrives. Opening is not held up for it.
      const bannerComing = run?.bannerFor(run.current.itemId).catch(() => undefined);
      const banner = bannerComing
        ? await Promise.race([bannerComing, new Promise<undefined>(done => setTimeout(done, 800))])
        : undefined;
      if (run) {
        stopListening = await this.listenForSwitching(run, androidBridge);
        void run.directory().then(directory => androidBridge.setChannels(directory)).catch(() => undefined);
        if (!banner && bannerComing) {
          void bannerComing.then(late =>
            late ? androidBridge.updateBanner({ itemId: run.current.itemId, banner: late }).catch(() => undefined) : undefined
          );
        }
      }
      // An episode goes on to the next inside the player (PL-TV-6b).
      const episodes = request.presentation?.kind === 'episode' && request.item ? request.episodes : undefined;
      let upNext: EpisodesAhead | undefined;
      let seasons: ShowSeasons | undefined;
      if (episodes && request.item) {
        upNext = await episodes.ahead(request.item.id).catch(() => undefined);
        // The whole show, for Episodes (PX-TV-3): any of them can be the
        // one the player goes on to, so each is known when it says so.
        seasons = await episodes.seasons?.().catch(() => undefined);
        // Before `play`, never in it (NativePlayerPlugin.setSeasons). An APK
        // without the method just goes without Episodes.
        if (seasons) {
          await NativePlayer.setSeasons(seasons).catch(() => undefined);
        }
        const listed = (seasons?.seasons ?? []).flatMap(season => season.episodes);
        const known = new Map<string, AheadEpisode>([...listed, ...(upNext?.ahead ?? [])].map(one => [one.itemId, one]));
        stopListening = await this.listenForEpisodes(episodes, known);
      }
      return await NativePlayer.play({
        url: request.url,
        title: request.title,
        startAtSeconds: Math.max(0, Math.floor(request.startAtSeconds)),
        subtitleScale: chosen.subtitleScale,
        subtitleColour: chosen.subtitleColour,
        subtitleBackground: chosen.subtitleBackground,
        subtitleEdge: chosen.subtitleEdge,
        audioLanguage: tracks.audioLanguage,
        subtitleLanguage: tracks.subtitleLanguage,
        audioTitle: tracks.audioTitle,
        subtitleTitle: tracks.subtitleTitle,
        subtitlesEnabled: tracks.subtitlesEnabled,
        matchFrameRate: chosen.matchFrameRate,
        language: currentLanguage(),
        texts: JSON.stringify(nativePlayerWords()),
        engine,
        reportProgress: !!request.checkpoint,
        progressItemId: request.checkpoint ? request.item?.id : undefined,
        channelKeys: request.channelKeys === true,
        inPlayerSwitching: !!run,
        itemId: run?.current.itemId ?? (request.presentation ? request.item?.id : undefined),
        channelNumber: run?.current.number,
        channelName: run?.current.name,
        monogram: run?.current.monogram,
        banner,
        subtitles: request.subtitles,
        ...filmFields(request.presentation),
        openingLine: request.presentation ? (openingLine ?? request.openingLine) : undefined,
        skips: request.skips?.length && chosen.skipIntros !== 'off' ? request.skips : undefined,
        skipIntros: chosen.skipIntros,
        upNext
      });
    } catch (error) {
      console.warn('Native player unavailable; falling back to the web player', error);
      return null;
    } finally {
      stopListening?.();
    }
  }
}

/** The film's own controls' details, as the plugin takes them; nothing for live. */
function filmFields(presentation: FilmPresentation | undefined): Partial<NativePlayRequest> {
  if (!presentation) {
    return {};
  }
  return {
    kind: presentation.kind,
    heading: presentation.heading,
    displayTitle: presentation.title,
    meta: presentation.meta,
    poster: presentation.poster ?? undefined,
    description: presentation.description || undefined
  };
}
