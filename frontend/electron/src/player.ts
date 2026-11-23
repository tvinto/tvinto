import { toPage } from './pageChannel';
import { MpvChapter, Skip, handedSkips, skipAt, skipsFromChapters } from './skips';
import { fromAppPage } from './appPage';
import { ChildProcess, execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { connect, Socket } from 'net';
import { dirname, join } from 'path';
import { app, BrowserWindow, ipcMain, powerSaveBlocker, screen } from 'electron';
import { desktopRecorder } from './recorderIpc';
import { CacheState, LivePause, LiveWords } from './livePause';
import { LiveRecovery, NO_PICTURE, START_TIMEOUT_MS } from './liveRecovery';
import { playbackLog, redactUrl, setPlaybackLogFolder } from './playbackLog';
import { rememberPlayed, reportPlayerExit } from './errorReports';
import { VideoFrames } from './videoFrames';
import { VideoState } from './videoState';
import { PipeOpening, playerPipeName } from './playerPipe';
import { MpvLogMessage, streamRequestLine } from './streamRequests';
import { subtitleArguments, subtitleCommands } from './subtitleChoice';

/**
 * Playback on the desktop, by mpv rather than by Chromium.
 *
 * The same problem as Android and the same shape of answer. Chromium has no
 * HEVC decoder unless Windows supplies one, and a great many of this provider's
 * films are 4K HEVC -- which is why the browser plays their sound over a black
 * picture. mpv carries its own decoders, so it plays them whatever Windows has
 * installed.
 *
 * Inside the app's window since November 2026: tvinto-player.exe is the same
 * mpv as a library, drawing into textures the page shows under its own
 * controls (native/tvinto-player.cpp, src/videoFrames.ts, src/videoState.ts,
 * the page's app-desktop-player). It takes mpv.exe's command line and serves
 * its JSON pipe, so everything below -- live pause, Skip intro, switching
 * channel, reopening a dropped one -- talks to either the same way.
 *
 * mpv.exe's own window over the app is the fallback: no helper, a machine
 * where it cannot start, or the account's player setting `desktopPlayer:
 * 'window'`. Kept for one release. What goes with it then: overlayGeometry
 * and the window-only arguments (--ontop, --no-border, --geometry, --screen),
 * the preload's full-window canvas and its key forwarding, the mpv OSD
 * banner (osdBanner) and live pause badge (badgeAss), and the setting.
 */

/**
 * Said when there is no mpv to run.
 *
 * Not a playback failure but the absence of this player, which the renderer
 * answers by using the in-page one instead.
 */
export const MPV_MISSING = 'mpv-missing';

/** How often a film's position is told to the page while it plays. */
const PROGRESS_EVERY_MS = 30_000;

export interface PlayRequest {
  url: string;
  title: string;
  startAtSeconds: number;
  subtitleScale: number;
  subtitleColour: string;
  subtitleBackground: string;
  subtitleEdge: string;
  audioLanguage: string;
  subtitleLanguage: string;
  subtitlesEnabled: boolean;

  /**
   * Whether to tell the page where a film or an episode has got to while it
   * plays, so it is saved along the way rather than only at the end.
   */
  reportProgress?: boolean;

  /**
   * The name of the track this item was last watched with, if there was one.
   *
   * `--slang` cannot express it. A film here offers "English (forced)",
   * "English" and "English (SDH)" -- three tracks, one language -- so asking
   * mpv for English selects the first of them however carefully the third was
   * chosen. The named track is picked over the pipe once the file is open.
   */
  audioTitle?: string;
  subtitleTitle?: string;

  /**
   * Subtitles the account added from OpenSubtitles for this item.
   *
   * The text rather than a path: the page cannot write files, so the text is
   * written here into the app's own folder and handed to mpv as `--sub-file`.
   * One of them is selected once the file is open, by being the external one.
   */
  subtitles?: { id: string; language: string; label: string; text: string }[];
  /** Stretches to offer to skip (skips.ts), checked again here before use. */
  skips?: unknown;
  /** What the offer says, in the app's language: "Skip intro · Enter". */
  skipWords?: { intro?: string; recap?: string };
  /** 'auto' skips by itself, 'off' offers nothing, not even from chapters; a button otherwise. */
  skipIntros?: string;

  /**
   * Whether Page Up and Page Down may change channel. Live channels only.
   *
   * mpv cannot be handed a list; it is told to quit with a code saying which
   * way was pressed, and the app opens the neighbour -- the same arrangement
   * as the Android players (ChannelKeys.java). Page Up and Page Down because a
   * PC keyboard has no channel keys, and mpv binds them only to chapter skips,
   * which a live stream does not have.
   */
  channelKeys?: boolean;

  /**
   * Whether the page answers channel keys itself, so mpv stays open and is
   * handed the next channel. Absent from a page
   * older than this main process, which gets the quit codes above.
   */
  inPlayerSwitching?: boolean;

  /** The channel being opened, as the page knows it; reported back at the end. */
  itemId?: string;

  /**
   * Whether this is a live channel, which can be paused (livePause.ts). Absent
   * from an older page, where `channelKeys` is the only sign of one.
   */
  live?: boolean;

  /** The pause's words, in the app's language. */
  liveWords?: LiveWords;

  /**
   * Where to play (shared/player.ts DesktopPlayer): 'window' is mpv's own
   * window, as before tvinto-player; anything else, inside the app when it
   * can. Absent from an older page.
   */
  engine?: string;
  /** 0 to 100, kept by the page between films. Absent from an older page. */
  volume?: number;
  muted?: boolean;
}

/** mpv's volume, 0 to 100: louder than the source distorts, and mpv's own ceiling is 130. */
function clampVolume(volume: number): number {
  return Math.round(Math.max(0, Math.min(100, volume)));
}

/** What the page's own player controls ask for (videoState.ts, preload's `video`). */
type VideoCommand =
  | { kind: 'key'; key: string }
  | { kind: 'seek'; seconds: number; mode: 'relative' | 'absolute' }
  | { kind: 'audio'; id: number }
  | { kind: 'subtitle'; id: number | null }
  | { kind: 'addSubtitle'; subtitle: AddedSubtitle }
  | { kind: 'pause'; paused: boolean }
  | { kind: 'volume'; volume: number }
  | { kind: 'mute'; muted: boolean };

/** What the page tells a player that switches inside itself. */
type PlayerCommand =
  | { kind: 'switch'; url: string; itemId: string; waitMs: number; text: string }
  | { kind: 'text'; text: string; ms: number }
  | { kind: 'giveUp'; text: string }
  | { kind: 'close' };

/** How long a switching message stays up: until the picture replaces it. */
const UNTIL_REPLACED_MS = 120_000;

/** mpv's exit code when the page closes the player over a failure. */
const CLOSED_OVER_FAILURE_EXIT = 4;

/**
 * The viewer closed the player (Escape, Backspace, Back). Said outright
 * because mpv's own code is 2 for a stream that never opened, which read as a
 * failure after the viewer had chosen to leave (23 November).
 */
const VIEWER_CLOSED_EXIT = 0;

/** mpv's exit codes for "change channel", from the input.conf written below. */
const CHANNEL_PREVIOUS_EXIT = 10;
const CHANNEL_NEXT_EXIT = 11;

/** One row of mpv's `track-list`, as far as choosing between them needs. */
interface MpvTrack {
  id: number;
  type: string;
  lang?: string;
  title?: string;
  /** True for a `--sub-file`, which is how an added subtitle is recognised. */
  external?: boolean;
}

/**
 * Which of mpv's tracks was meant.
 *
 * The same order as `matchTrack` in `shared/player.ts`, which is where the
 * reasoning is written down and where it is tested: the title first, because
 * it is the only thing separating three tracks that all say `eng`; then the
 * language, for a film whose tracks are unnamed; then nothing, because mpv's
 * own default is a better answer than a track chosen by guesswork.
 *
 * Repeated here rather than imported because this file compiles as its own
 * program, outside the app's TypeScript project.
 */
/**
 * The added subtitles as files mpv can open.
 *
 * Written into the app's own folder under their sync-service ids, so the same
 * subtitle is written once however often it is played, and a file left behind
 * is overwritten rather than accumulating. Anything that cannot be written is
 * skipped: a film should still play.
 */
function subtitleFiles(request: PlayRequest): string[] {
  return (request.subtitles ?? []).map(subtitleFile).filter((path): path is string => path !== null);
}

type AddedSubtitle = NonNullable<PlayRequest['subtitles']>[number];

/** One added subtitle written where mpv can open it; null when it cannot be. */
function subtitleFile(subtitle: AddedSubtitle): string | null {
  // Only ids this service made: nothing from the page reaches a path.
  if (!subtitle || typeof subtitle.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(subtitle.id) || typeof subtitle.text !== 'string') {
    return null;
  }
  try {
    const folder = join(app.getPath('userData'), 'subtitles');
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${subtitle.id}.vtt`);
    writeFileSync(path, subtitle.text, 'utf8');
    return path;
  } catch {
    // No file, no subtitle; the stream's own tracks are unaffected.
    return null;
  }
}

/**
 * The paths added to the running player with `sub-add`, so the same subtitle
 * chosen again -- its timing nudged in the picker -- is read again from its
 * file rather than listed a second time.
 */
const addedWhilePlaying = new Set<string>();

/**
 * A subtitle chosen in the picker while the film plays (PX-TV-5's "Find
 * subtitles…"): written beside the others and handed to mpv, which reads the
 * file from disk -- nothing more is asked of the provider -- and shows it at
 * once.
 */
function addWhilePlaying(send: (command: unknown[]) => void, subtitle: AddedSubtitle): void {
  const path = subtitleFile(subtitle);
  if (!path) {
    return;
  }
  const title = typeof subtitle.label === 'string' ? subtitle.label.slice(0, 80) : '';
  const lang = typeof subtitle.language === 'string' && /^[A-Za-z-]{2,12}$/.test(subtitle.language) ? subtitle.language : '';
  if (addedWhilePlaying.has(path)) {
    // The copy already listed is selected (`cached` loads nothing new) and
    // removed, so the new timing replaces it rather than listing it twice.
    // Not `sub-reload`, which reads the file again but names the track by it.
    send(['sub-add', path, 'cached']);
    send(['sub-remove']);
  }
  addedWhilePlaying.add(path);
  send(['sub-add', path, 'select', title, lang]);
  send(['set_property', 'sub-visibility', true]);
}

function chooseTrack(
  tracks: MpvTrack[],
  type: string,
  wanted: { language: string; title: string }
): number | null {
  const of = tracks.filter(track => track.type === type);
  const language = (wanted.language || '').toLowerCase();
  const title = (wanted.title || '').trim();

  const sameTitle = (track: MpvTrack) => (track.title || '').trim() === title;
  const sameLanguage = (track: MpvTrack) => (track.lang || '').toLowerCase() === language;

  if (title) {
    const exact =
      of.find(track => sameTitle(track) && (!language || sameLanguage(track))) ?? of.find(sameTitle);
    if (exact) {
      return exact.id;
    }
  }

  return language ? (of.find(sameLanguage)?.id ?? null) : null;
}

export interface PlayResult {
  positionSeconds: number;
  durationSeconds: number;
  played: boolean;
  errorCode: string | null;

  /**
   * The tracks that were actually playing when the viewer left.
   *
   * Null means the player did not say -- it failed to start, or ended before
   * mpv answered. The app must not read that as "no subtitles", or a film that
   * would not open would erase what was remembered about it.
   */
  audioLanguage?: string | null;
  subtitleLanguage?: string | null;
  audioTitle?: string | null;
  subtitleTitle?: string | null;
  subtitlesEnabled?: boolean | null;

  /** Set when the viewer closed the player to change channel. */
  channelStep?: 'next' | 'previous' | null;

  /** The channel on screen at the end, after any switching inside the player. */
  itemId?: string | null;
}

/**
 * Where mpv is.
 *
 * Bundled beside the app in production; taken from the PATH in development so
 * there is something to run against before the packaging is arranged. Null when
 * neither is there, which the app treats as "no native player" and falls back
 * to Chromium for -- the same answer it gives a browser.
 */
function findMpv(): string | null {
  const candidates = [
    // Bundled with the app, which is where a packaged build finds it.
    join(process.resourcesPath ?? '', 'mpv', 'mpv.exe'),
    join(app.getAppPath(), 'resources', 'mpv', 'mpv.exe'),

    /*
     * Where the Windows installers actually put it.
     *
     * Searched because being installed and being on the PATH are different
     * things: winget's shinchiro package lands in Program Files and adds
     * nothing to the PATH, so `spawn('mpv')` fails with ENOENT on a machine
     * that has mpv sitting right there. Asking the PATH alone would tell a
     * viewer to install something they have already installed.
     */
    'C:\\Program Files\\MPV Player\\mpv.exe',
    'C:\\Program Files\\mpv\\mpv.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'mpv', 'mpv.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'mpv.net', 'mpvnet.exe'),
    'C:\\Program Files\\mpv.net\\mpvnet.exe'
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return said(candidate);
    }
  }

  // Whatever is on the PATH, if anything. spawn reports its own failure when
  // there is not, and the caller treats that as this player being absent.
  return said('mpv');
}

/**
 * Whether tvinto-player can play on this machine, asked once (its
 * `--tvinto-check`: a D3D11 device, libmpv, mpv's D3D11 renderer). Null
 * until asked.
 */
let helperWorks: boolean | null = null;

/**
 * tvinto-player.exe, mpv drawing into the app's own window (src/videoFrames.ts),
 * when it is beside mpv.exe with its libmpv and works here. Null sends the
 * play to mpv.exe's window, as before: no helper, a machine where it cannot
 * start, or XTREAM_PLAYER=window.
 */
async function findHelper(mpv: string): Promise<string | null> {
  if (process.platform !== 'win32' || process.env['XTREAM_PLAYER'] === 'window') {
    return null;
  }
  const helper = join(dirname(mpv), 'tvinto-player.exe');
  if (!existsSync(helper) || !existsSync(join(dirname(mpv), 'libmpv-2.dll'))) {
    return null;
  }
  if (helperWorks === null) {
    helperWorks = await new Promise<boolean>(resolve => {
      execFile(helper, ['--tvinto-check'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        const works = !error && /ready/.test(stdout);
        console.info(`[player] tvinto-player ${works ? 'works here' : `cannot play here: ${String(stdout).trim() || error?.message}`}`);
        resolve(works);
      });
    });
  }
  return helperWorks ? helper : null;
}

let announced: string | null = null;

/**
 * Says which mpv is being used, once.
 *
 * Worth a line because there are six places it can come from and they are not
 * equivalent: an installed copy should be playing the one shipped beside it,
 * and a machine that happens to have mpv elsewhere would hide a build that
 * forgot to bundle one -- working perfectly here and not at all for anybody
 * who installed it.
 */
function said(mpv: string): string {
  if (announced !== mpv) {
    announced = mpv;
    console.info(`[player] mpv: ${mpv}`);
  }

  return mpv;
}

/**
 * Keys mpv would not otherwise answer to, written where mpv can read them.
 *
 * Escape is the one that matters. mpv binds it to "leave full screen", which
 * inside the app's window means nothing at all -- so the only documented way
 * out would be `q`, and a viewer who does not know that is stuck looking at a
 * picture with no way back. Backspace is here because a remote sends it and a
 * television is where this app is going.
 *
 * Page Up and Page Down change channel on a live stream, by quitting with a
 * code that says which way (see `channelKeys`).
 *
 * A file because mpv has no way to bind a key on the command line.
 */
/** `quit <code>` for input.conf, readable by tvinto-player too (`PositionWatcher.quitWith`). */
const quitCommand = (code: number): string => `set user-data/tvinto-exit ${code}; quit ${code}`;

function inputConf(channelKeys: boolean, inPlayer: boolean, live: boolean): string | null {
  const path = join(app.getPath('userData'), 'mpv-input.conf');

  // Switching inside the player: the keys become messages the main process
  // passes to the page, and Backspace cancels a switch before it closes
  // anything. `i` is the banner, over mpv's statistics page.
  const keys = inPlayer
    ? `ESC ${quitCommand(VIEWER_CLOSED_EXIT)}\nBS script-message xtream back\nPGUP script-message xtream channel previous\n` +
      'PGDWN script-message xtream channel next\ni script-message xtream banner\n'
    : `ESC ${quitCommand(VIEWER_CLOSED_EXIT)}\nBS ${quitCommand(VIEWER_CLOSED_EXIT)}\n${channelKeys ? `PGUP ${quitCommand(CHANNEL_PREVIOUS_EXIT)}\nPGDWN ${quitCommand(CHANNEL_NEXT_EXIT)}\n` : ''}` +
      // A film or an episode: Enter takes the offer to skip an intro (skips.ts).
      (channelKeys ? '' : 'ENTER script-message xtream skip\nKP_ENTER script-message xtream skip\n');
  // A live channel steps within a pause (livePause.ts) rather than seeking in
  // mpv's cache: Left and Right 10 s, Rewind and Fast forward 30, End is Back
  // to live. Live, they do nothing. Up and Down would seek a minute.
  const pausing = live
    ? 'LEFT script-message xtream step -10\nRIGHT script-message xtream step 10\n' +
      'REWIND script-message xtream step -30\nFORWARD script-message xtream step 30\n' +
      'END script-message xtream live\nUP ignore\nDOWN ignore\n' +
      // Try again, once a channel that stopped says so (LiveKeeper).
      'ENTER script-message xtream retry\nKP_ENTER script-message xtream retry\n'
    : '';

  try {
    writeFileSync(path, keys + pausing, 'utf8');
    return path;
  } catch {
    // Playable without it; `q` still works. Not worth refusing to play over.
    return null;
  }
}

/**
 * Where mpv should put its window so that it lands over the app's own.
 *
 * Not `--wid`, which was the obvious answer and the wrong one. Handing mpv the
 * app's window makes it a child of it — a sibling of the child window Chromium
 * renders the page into, which is on top. The audio played, the screen went on
 * showing the library, and the only way to stop it was to kill the process.
 * The check that passed was that mpv had no top-level window of its own, which
 * was true and says nothing about whether anybody can see the film.
 *
 * So mpv keeps its own window and is told where to put it: no border, over the
 * app's content, and above it. That is a picture filling the app rather than a
 * second window appearing somewhere else, and the z-order is between two
 * top-level windows rather than an argument with Chromium's compositor.
 *
 * What it is not is truly embedded: it does not follow the app if the app is
 * dragged, because mpv's geometry is read when its window is made and not
 * after. Watching something with one hand on the title bar is not the case
 * worth more machinery than this.
 */
function overlayGeometry(window: BrowserWindow | null): { geometry: string; screen: number } | null {
  if (!app.isPackaged && process.env['XTREAM_HEADLESS'] === '1') {
    // A development copy checked from a script (setup.ts): its window is off
    // every screen, and so is mpv's, which is looked at by its screenshots.
    return { geometry: '1280x720-30000-30000', screen: 0 };
  }
  if (!window || process.platform !== 'win32' || window.isMinimized()) {
    return null;
  }

  try {
    // Electron measures in device-independent pixels and mpv in real ones. On
    // a display at 150% those are different numbers, and using the wrong one
    // puts the picture two thirds of the way across the window.
    const bounds = screen.dipToScreenRect(window, window.getContentBounds());

    if (bounds.width < 200 || bounds.height < 150) {
      return null;
    }

    /*
     * mpv's coordinates are relative to a screen, not to the desktop.
     *
     * Found by looking: told `+1920+43` for an app on the second monitor, mpv
     * put its window 1920 pixels from *that monitor's* left edge -- off the
     * side of it, onto a third. So the screen has to be named, and the offset
     * measured from its corner rather than from the desktop's.
     */
    const displays = screen.getAllDisplays();
    const display = screen.getDisplayMatching(screen.dipToScreenRect(window, window.getBounds()));
    const corner = screen.dipToScreenRect(window, display.bounds);
    const index = displays.findIndex(candidate => candidate.id === display.id);

    return {
      geometry: `${bounds.width}x${bounds.height}+${bounds.x - corner.x}+${bounds.y - corner.y}`,
      screen: index < 0 ? 0 : index
    };
  } catch {
    // A window of its own is worse and still works.
    return null;
  }
}

/** The arguments that carry the account's subtitle preferences into mpv. */
function argumentsFor(
  request: PlayRequest,
  player: 'tvinto-player' | 'mpv',
  inside: { geometry: string; screen: number } | null,
  pipe: string
): string[] {
  const args = [
    // A provider's title is shown, never expanded: mpv reads `${...}` in it.
    `--title=${(request.title || 'Tvinto').replace(/\$/g, '$$$$')}`,
    // This player's own pipe, never one shared with other copies (playerPipe.ts).
    `--input-ipc-server=${pipe}`,
    '--no-terminal',
    // Ask mpv to report where it is, so the pipe reader has something to read.
    '--force-window=immediate'
  ];

  // The page keeps the volume between films (the player's volume control).
  if (typeof request.volume === 'number' && Number.isFinite(request.volume)) {
    args.push(`--volume=${clampVolume(request.volume)}`);
  }
  if (request.muted === true) {
    args.push('--mute=yes');
  }

  if (!app.isPackaged && process.env['XTREAM_HEADLESS'] === '1') {
    // Checked from a script while the owner uses the machine: not a sound,
    // and a window that never takes the keyboard from what they are doing.
    args.push('--ao=null', '--focus-on=never');
  }

  if (inside) {
    /*
     * A picture the size of the app, over the app.
     *
     * Borderless so there is no second title bar, on top so the page cannot
     * cover it, and placed exactly over the app's content. What a viewer sees
     * is the app filling with video, not a window appearing elsewhere.
     *
     * The app's own controls cannot be drawn over it -- it is a separate
     * window, whatever it looks like -- so mpv's on-screen controller is the
     * interface while it plays, and Escape gives the app back.
     */
    args.push(
      '--no-border',
      '--ontop',
      `--screen=${inside.screen}`,
      `--geometry=${inside.geometry}`
    );
  } else {
    // Nowhere to put it: a full-screen window of its own, as it always was.
    args.push('--fullscreen');
  }

  const inPlayer = request.channelKeys === true && request.inPlayerSwitching === true;
  const live = isLive(request);
  if (live) {
    /*
     * A playlist reload that never answers froze the picture for good: mpv
     * waits 60 s by default, and the fake provider's hung reload was still
     * waiting after 35 (13 November). Ten seconds makes it an ending, which
     * LiveKeeper answers by opening the channel again.
     */
    args.push('--network-timeout=10');
  }
  if (live && !inPlayer) {
    // Idle, so that Back to live can close the stream and open it again
    // without mpv ending in between; the end of a stream is handled below.
    args.push('--idle=yes', '--script-opts=osc-idlescreen=no');
  }
  if (inPlayer) {
    /*
     * PL-D-1: stay open between channels, and draw the banner as text.
     *
     * Idle, because stopping one channel before the next is opened -- which
     * the one connection needs -- would otherwise end mpv. The OSD settings are
     * the board's: one monospaced face, bottom left, a heavy shadow standing in
     * for the panel mpv cannot draw.
     */
    args.push(
      '--idle=yes',
      // Not mpv's "Drop files or URLs to play here" behind a switch.
      '--script-opts=osc-idlescreen=no',
      '--osd-font=Consolas',
      '--osd-font-size=26',
      '--osd-align-x=left',
      '--osd-align-y=bottom',
      '--osd-margin-x=48',
      '--osd-margin-y=44',
      '--osd-border-size=2',
      '--osd-border-color=#C0000000',
      '--osd-shadow-offset=2',
      '--osd-shadow-color=#F0000000'
    );
  }

  // Both placements: Escape and the channel keys matter as much full screen.
  const conf = inputConf(request.channelKeys === true, inPlayer, live);
  if (conf) {
    args.push(`--input-conf=${conf}`);
  }

  if (request.startAtSeconds > 0) {
    args.push(`--start=${Math.floor(request.startAtSeconds)}`);
  }

  // Subtitle appearance. mpv takes a scale as a multiplier where the stored
  // preference is a percentage of normal.
  args.push(`--sub-scale=${(request.subtitleScale / 100).toFixed(2)}`);
  args.push(`--sub-color=${request.subtitleColour}`);

  if (request.subtitleBackground === 'solid') {
    args.push('--sub-back-color=#000000');
  } else if (request.subtitleBackground === 'translucent') {
    args.push('--sub-back-color=#A0000000');
  } else {
    args.push('--sub-back-color=#00000000');
  }

  if (request.subtitleEdge === 'outline') {
    args.push('--sub-border-size=3', '--sub-shadow-offset=0');
  } else if (request.subtitleEdge === 'shadow') {
    args.push('--sub-border-size=0', '--sub-shadow-offset=2');
  } else {
    args.push('--sub-border-size=0', '--sub-shadow-offset=0');
  }

  // A new mpv lists only what it was started with.
  addedWhilePlaying.clear();
  for (const file of subtitleFiles(request)) {
    addedWhilePlaying.add(file);
    args.push(`--sub-file=${file}`);
  }

  if (request.audioLanguage) {
    args.push(`--alang=${request.audioLanguage}`);
  }

  args.push(
    ...subtitleArguments({
      enabled: request.subtitlesEnabled,
      language: request.subtitleLanguage,
      added: Boolean(request.subtitles?.length),
      inApp: player === 'tvinto-player'
    })
  );

  // The address last, after `--`: it comes from the provider -- any line of an
  // M3U playlist -- and one starting with `--` would otherwise be read as an
  // option (`--script=...`), which runs code.
  return [...args, '--', request.url];
}

/** Whether a request is a live channel from the provider: one that can be paused. */
const isLive = (request: PlayRequest): boolean =>
  (request.live ?? request.channelKeys === true) && isStreamUrl(request.url);

/**
 * Whether an address is one mpv should be handed: a network stream. A
 * playlist line is anything its author wrote, and mpv also opens local files,
 * `av://`, `edl://` and the like, which a provider has no business naming.
 */
export const isStreamUrl = (url: unknown): url is string =>
  typeof url === 'string' && /^(https?|rtmps?|rtsp|rtp|udp|mms|srt):\/\//i.test(url.trim());

/**
 * Follows mpv's position over its pipe.
 *
 * Polled rather than subscribed because mpv's property observation reports
 * every frame, and this is written down every ten seconds at most. The last
 * value read is what survives when the window closes -- which is the only
 * moment anyone asks.
 */
class PositionWatcher {
  private socket: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;

  /**
   * Whether the remembered tracks have been applied.
   *
   * Once, and only once: after that the viewer's own choices are what is
   * playing, and re-applying would undo them mid-film.
   */
  private applied = false;

  /** This player's pipe (playerPipe.ts), the only one this watcher connects to. */
  readonly pipe = playerPipeName();

  constructor(private readonly wanted: PlayRequest) {}

  /** mpv's own events -- client messages from key bindings, a file starting or failing. */
  onEvent: ((message: MpvEvent) => void) | null = null;

  /**
   * Told each time mpv answers with a position, which it only has while a file
   * plays. The first file's `playback-restart` usually fires before this pipe
   * has connected, so a position is how the first arrival is noticed.
   */
  onPosition: (() => void) | null = null;

  /** Sends a command, if the pipe is open. */
  send(command: unknown[]): void {
    if (this.inPage && command[0] === 'show-text') {
      // The page writes it (videoState.ts); mpv's OSD is off.
      this.inPage.text(String(command[1] ?? ''), Number(command[2] ?? 0));
      return;
    }
    this.command(command);
  }

  /**
   * The page's player, when tvinto-player draws into the app's window:
   * what mpv would have written on the picture goes to it instead, with the
   * position, the pause and the tracks for its controls.
   */
  inPage: VideoState | null = null;

  /**
   * Quits with an exit code that says why. mpv.exe exits with it; libmpv
   * cannot pass it on, so it is also left where tvinto-player reads it.
   */
  quitWith(code: number): void {
    this.askedExit = code;
    this.command(['set_property', 'user-data/tvinto-exit', String(code)]);
    this.command(['quit', String(code)]);
  }

  /** Sends a command given by name with named arguments (`osd-overlay`). */
  sendNamed(command: Record<string, unknown>): void {
    if (this.inPage && command['name'] === 'osd-overlay') {
      // The live pause badge reaches the page by itself (LivePause's badge).
      return;
    }
    this.command(command);
  }

  /**
   * A live channel's pause (livePause.ts): sees every event first, and may
   * keep it from the others. Its cache and the OSD's size are asked for too.
   */
  pause: LivePause | null = null;

  positionSeconds = 0;
  durationSeconds = 0;
  /** The position as mpv gave it, to the millisecond, for Skip intro. */
  positionMs = 0;
  /** The position to the microsecond, and when it was read, for a pause. */
  positionExact: { seconds: number; at: number } | null = null;

  /** Why the app closed the player, when it did over a failure (CLOSED_OVER_FAILURE_EXIT). */
  closingWith: string | null = null;

  /**
   * The exit the app or the viewer asked for, which is what the player's own
   * code means. tvinto-player reads `user-data/tvinto-exit` once libmpv has
   * shut down, when it can no longer be read, and exits 0 or 2 whatever was
   * asked (23 November); mpv.exe exits with it.
   */
  askedExit: number | null = null;

  /** A key the page passed on: Escape, and Backspace outside in-player switching, close the player. */
  pressed(key: string): void {
    if (key === 'ESC' || (key === 'BS' && !channels)) {
      this.askedExit ??= VIEWER_CLOSED_EXIT;
    }
  }
  cacheState: CacheState | null = null;
  osdSize: { width: number; height: number } | null = null;
  private osdWidth = 0;

  /** The file's chapters, once mpv has read them (asked until a duration is known too). */
  onChapters: ((chapters: MpvChapter[]) => void) | null = null;
  private chaptersRead = false;

  /**
   * The tracks mpv settled on, so the next viewing of this film starts the
   * same way.
   *
   * Polled beside the position rather than read once at the end, because at
   * the end there is nothing to ask: mpv has closed the pipe. The last answer
   * before it went is the one that counts, which is also what makes a track
   * changed half way through the film the one remembered.
   *
   * Null until mpv says. A player that never answered must not be taken to
   * mean "no subtitles".
   */
  audioLanguage: string | null = null;
  subtitleLanguage: string | null = null;
  audioTitle: string | null = null;
  subtitleTitle: string | null = null;
  subtitlesEnabled: boolean | null = null;

  start(): void {
    // mpv creates the pipe when it opens its window, so the first attempts fail
    // and are simply retried.
    // One connection at a time. A second attempt while the first was still
    // connecting made two, and every event of mpv's was handled twice: a
    // dropped channel used up its three reopens in fifty milliseconds.
    let connecting: Socket | null = null;
    const opening = new PipeOpening(this.pipe, playbackLog);
    const attempt = () => {
      if (this.socket || connecting) {
        return;
      }

      const socket = connect(this.pipe);
      connecting = socket;

      socket.on('connect', () => {
        connecting = null;
        this.socket = socket;
        opening.opened();
        // mpv's own log, for a line per request to the provider (streamRequests.ts).
        this.command(['request_log_messages', 'v']);
        this.pause?.connected();
      });
      socket.on('error', error => {
        opening.failed((error as NodeJS.ErrnoException).code ?? error.message);
        socket.destroy();
      });
      socket.on('data', chunk => this.read(chunk.toString()));
      socket.on('close', () => {
        if (connecting === socket) {
          connecting = null;
        }
        if (this.socket === socket) {
          this.socket = null;
        }
      });
    };

    this.timer = setInterval(() => {
      attempt();
      this.ask('time-pos');
      this.ask('duration');
      this.ask('current-tracks/audio/lang');
      this.ask('current-tracks/sub/lang');
      this.ask('sub-visibility');
      this.ask('sid');
      this.ask('current-tracks/audio/title');
      this.ask('current-tracks/sub/title');

      if (!this.applied) {
        // Asked until it answers: mpv opens its pipe before it has read the
        // file, so the first attempts come back with an empty list.
        this.ask('track-list');
      }
      if (this.onChapters && !this.chaptersRead) {
        this.ask('chapter-list');
      }
      if (this.inPage) {
        this.ask('track-list');
        this.ask('pause');
        this.ask('paused-for-cache');
        this.ask('volume');
        this.ask('mute');
      }
      if (this.pause) {
        this.ask('demuxer-cache-state');
        this.ask('osd-width');
        this.ask('osd-height');
      }
    }, 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }

  /** Which answer is which, since mpv only echoes the number back. */
  private static readonly ASKED: Record<string, number> = {
    'time-pos': 1,
    duration: 2,
    'current-tracks/audio/lang': 3,
    'current-tracks/sub/lang': 4,
    'sub-visibility': 5,
    sid: 6,
    'current-tracks/audio/title': 7,
    'current-tracks/sub/title': 8,
    'track-list': 9,
    'chapter-list': 10,
    'demuxer-cache-state': 11,
    'osd-width': 12,
    'osd-height': 13,
    pause: 14,
    'paused-for-cache': 15,
    volume: 16,
    mute: 17
  };

  /**
   * Whether subtitles are showing, which takes both answers.
   *
   * `sub-visibility` is mpv's master switch and is on by default -- including
   * for a film with no subtitle track at all, and including when we asked for
   * `--sid=no`. Believing it alone made every film ever watched come back as
   * "subtitles on", which would then have been remembered and turned them on
   * next time. `sid` is the track actually selected, and is `false` when there
   * is none.
   */
  private subVisible: boolean | null = null;
  private subtitleTrack: boolean | null = null;

  /**
   * Selects the tracks this item was last watched with.
   *
   * `--slang` gets the language right and the track wrong when a film has
   * three of the same language, which is the ordinary case for English. So the
   * list is read once the file is open and the named track chosen by id.
   *
   * Done once. After this the viewer's own choices are what is playing, and
   * setting it again half way through would undo them.
   */
  private applyWanted(tracks: MpvTrack[]): void {
    if (this.applied || !tracks.length) {
      return;
    }
    this.applied = true;

    const audio = chooseTrack(tracks, 'audio', {
      language: this.wanted.audioLanguage,
      title: this.wanted.audioTitle ?? ''
    });

    if (audio !== null) {
      this.command(['set_property', 'aid', audio]);
    }

    // An added subtitle is there because somebody chose it for this film, so
    // it wins over both the account's language and what was watched last time.
    const added = tracks.find(track => track.type === 'sub' && track.external);
    if (this.wanted.subtitles?.length && added) {
      this.command(['set_property', 'sid', added.id]);
      this.command(['set_property', 'sub-visibility', true]);
      return;
    }

    if (!this.wanted.subtitlesEnabled) {
      // Nothing to show: the command line selected no track, or the remembered
      // language hidden, ready to be shown with no request (subtitleChoice.ts).
      return;
    }

    const subtitle = chooseTrack(tracks, 'sub', {
      language: this.wanted.subtitleLanguage,
      title: this.wanted.subtitleTitle ?? ''
    });

    if (subtitle !== null) {
      this.command(['set_property', 'sid', subtitle]);
      // The master switch, in case a previous file left it off.
      this.command(['set_property', 'sub-visibility', true]);
    }
  }

  private command(command: unknown[] | Record<string, unknown>): void {
    if (!this.socket) {
      return;
    }
    try {
      this.socket.write(`${JSON.stringify({ command })}\n`);
    } catch {
      // The pipe went away, which means mpv did.
    }
  }

  /**
   * Everything worth reporting about the tracks, as one object.
   *
   * One place, so that adding something to what is watched adds it to what is
   * handed back. Listing the fields at the call site is exactly how the track
   * names went missing: they were captured here, typed into the result, and
   * never copied across.
   */
  tracks(): Pick<
    PlayResult,
    'audioLanguage' | 'subtitleLanguage' | 'audioTitle' | 'subtitleTitle' | 'subtitlesEnabled'
  > {
    return {
      audioLanguage: this.audioLanguage,
      subtitleLanguage: this.subtitleLanguage,
      audioTitle: this.audioTitle,
      subtitleTitle: this.subtitleTitle,
      subtitlesEnabled: this.subtitlesEnabled
    };
  }

  /** Both halves, or nothing: one alone is not an answer. */
  private settleSubtitles(): void {
    if (this.subVisible === null || this.subtitleTrack === null) {
      return;
    }

    this.subtitlesEnabled = this.subVisible && this.subtitleTrack;
  }

  /** When the picture of the file now open arrived, for saying how long it played. */
  private pictureAt: number | null = null;
  private opening = true;

  /** Every stream mpv ends, with its reason and error, and every picture that arrives. */
  private logEvent(event: MpvEvent): void {
    if (event.event === 'start-file') {
      this.opening = true;
      this.pictureAt = null;
    } else if (event.event === 'playback-restart' && this.opening) {
      this.opening = false;
      // What mpv's next line would have replaced: "Changing to…",
      // "Reconnecting…". The picture is back, so the page's goes.
      this.inPage?.text('', 0);
      this.pictureAt = Date.now();
      playbackLog('mpv: the picture is there');
    } else if (event.event === 'end-file') {
      const played =
        this.pictureAt === null
          ? 'before any picture'
          : `after ${Math.round((Date.now() - this.pictureAt) / 1000)} s of picture`;
      this.pictureAt = null;
      playbackLog(
        `mpv ended the stream: reason=${event.reason ?? '?'}` +
          (event.file_error ? ` error=${event.file_error}` : '') +
          ` ${played}` +
          (event.reason === 'stop' || event.reason === 'quit' ? ' (asked by the app or the viewer)' : '')
      );
    }
  }

  private ask(property: string): void {
    if (!this.socket) {
      return;
    }
    try {
      this.socket.write(
        `${JSON.stringify({
          command: ['get_property', property],
          request_id: PositionWatcher.ASKED[property] ?? 0
        })}\n`
      );
    } catch {
      // The pipe went away, which means mpv did. The close handler tidies up.
    }
  }

  private read(text: string): void {
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const message = JSON.parse(line) as { request_id?: number; data?: unknown; event?: string };

        if (message.event === 'log-message') {
          const request = streamRequestLine(message as MpvLogMessage);
          if (request) {
            playbackLog(request);
          }
        } else if (message.event) {
          this.logEvent(message as MpvEvent);
          if (!this.pause?.onEvent(message as MpvEvent)) {
            this.onEvent?.(message as MpvEvent);
          }
        } else if (message.request_id === 11 && message.data && typeof message.data === 'object') {
          this.cacheState = message.data as CacheState;
        } else if (message.request_id === 12 && typeof message.data === 'number') {
          this.osdWidth = message.data;
        } else if (message.request_id === 14 && typeof message.data === 'boolean') {
          this.inPage?.paused(message.data);
        } else if (message.request_id === 15 && typeof message.data === 'boolean') {
          this.inPage?.buffering(message.data);
        } else if (message.request_id === 16 && typeof message.data === 'number') {
          this.inPage?.volume(message.data);
        } else if (message.request_id === 17 && typeof message.data === 'boolean') {
          this.inPage?.muted(message.data);
        } else if (message.request_id === 13 && typeof message.data === 'number') {
          this.osdSize = this.osdWidth > 0 && message.data > 0 ? { width: this.osdWidth, height: message.data } : this.osdSize;
        } else if (message.request_id === 10 && Array.isArray(message.data)) {
          // Read once the file is open; before that the list is empty.
          if (this.durationSeconds > 0) {
            this.chaptersRead = true;
            this.onChapters?.(message.data as MpvChapter[]);
          }
        } else if (message.request_id === 1 && typeof message.data === 'number') {
          this.positionMs = Math.max(0, Math.round(message.data * 1000));
          this.positionSeconds = Math.max(0, Math.floor(message.data));
          this.positionExact = { seconds: message.data, at: Date.now() };
          this.inPage?.position(message.data);
          this.pause?.positionRead(this.positionExact.at);
          this.onPosition?.();
        } else if (message.request_id === 2 && typeof message.data === 'number') {
          this.durationSeconds = Math.max(0, Math.floor(message.data));
          this.inPage?.duration(message.data);
        } else if (message.request_id === 3 && typeof message.data === 'string') {
          this.audioLanguage = message.data;
        } else if (message.request_id === 4 && typeof message.data === 'string') {
          // Asked every second, so a track chosen half way through the film is
          // what ends up remembered. A film with no subtitle track answers
          // with an error rather than a string, and leaves this alone.
          this.subtitleLanguage = message.data;
        } else if (message.request_id === 5 && typeof message.data === 'boolean') {
          this.subVisible = message.data;
          this.inPage?.subtitlesShown(message.data);
          this.settleSubtitles();
        } else if (message.request_id === 9 && Array.isArray(message.data)) {
          this.inPage?.tracks(message.data);
          this.applyWanted(message.data as MpvTrack[]);
        } else if (message.request_id === 7 && typeof message.data === 'string') {
          this.audioTitle = message.data;
        } else if (message.request_id === 8 && typeof message.data === 'string') {
          // What tells "English (SDH)" from "English (forced)", which a
          // language cannot. A track with no title answers with an error and
          // leaves this null.
          this.subtitleTitle = message.data;
        } else if (message.request_id === 6) {
          // A number is a chosen track; `false` is mpv's way of saying none.
          this.subtitleTrack = typeof message.data === 'number';
          this.settleSubtitles();
        }
      } catch {
        // Partial JSON across a chunk boundary; the next read completes it.
      }
    }
  }
}

/**
 * Skip intro for a film or an episode: a line of text while an intro or a
 * recap plays, and Enter jumps past it (skips.ts).
 */
class DesktopSkips {
  private skips: Skip[];
  private offered: Skip | null = null;
  private done: Skip | null = null;

  constructor(
    private readonly watcher: PositionWatcher,
    handed: Skip[],
    private readonly words: { intro?: string; recap?: string },
    private readonly byItself: boolean
  ) {
    this.skips = handed;
    watcher.onPosition = () => this.tick();
    watcher.onEvent = event => {
      if (event.event === 'client-message' && event.args?.[0] === 'xtream' && event.args[1] === 'skip') {
        this.skip();
      }
    };
    watcher.onChapters = chapters => {
      const named = skipsFromChapters(chapters, watcher.durationSeconds * 1000);
      if (named.length) {
        this.skips = named;
      }
    };
  }

  private tick(): void {
    const now = skipAt(this.skips, this.watcher.positionMs);
    if (now && now !== this.done) {
      if (this.byItself) {
        this.skip();
        return;
      }
      if (this.offered !== now) {
        this.offered = now;
        const text = (now.kind === 'recap' ? this.words.recap : this.words.intro) || 'Skip intro · Enter';
        if (this.watcher.inPage) {
          // A button of the page's, which Enter presses too.
          this.watcher.inPage.skip(text);
          return;
        }
        // show-text expands ${properties}: the words are the app's own, but kept literal all the same.
        this.watcher.send(['show-text', text.split('$').join('$$'), Math.max(1000, now.endMs - this.watcher.positionMs)]);
      }
    } else if (this.offered) {
      this.offered = null;
      this.watcher.inPage?.skip(null);
      this.watcher.send(['show-text', '', 1]);
    }
  }

  private skip(): void {
    const now = skipAt(this.skips, this.watcher.positionMs);
    if (!now) {
      return;
    }
    this.done = now;
    this.offered = null;
    this.watcher.inPage?.skip(null);
    this.watcher.send(['show-text', '', 1]);
    this.watcher.send(['seek', now.endMs / 1000, 'absolute']);
  }
}

/** An event mpv sends to every client of its pipe. */
interface MpvEvent {
  event: string;
  args?: string[];
  reason?: string;
  file_error?: string;
}

/**
 * Keeps a live channel going when mpv ends it by itself (liveRecovery.ts):
 * opens it again at the live edge, a few times, and when that fails says so
 * and waits for Enter to try again.
 */
class LiveKeeper {
  private readonly recovery = new LiveRecovery();
  private pending: NodeJS.Timeout | null = null;
  /** Counting to START_TIMEOUT_MS since a stream was handed to mpv, until its picture. */
  private starting: NodeJS.Timeout | null = null;
  /** Given up: the message is on screen, and Enter tries again. */
  private stopped = false;

  /** A channel that never showed a picture, past START_TIMEOUT_MS: the owner closes or asks the page. */
  onNeverStarted: (errorCode: string) => void = () => undefined;

  constructor(
    private readonly watcher: PositionWatcher,
    private url: string,
    private readonly words: LiveWords,
    /** Given up on a channel that had played: the page reports it. */
    private readonly onGaveUp: (errorCode: string) => void = () => undefined
  ) {}

  /**
   * A stream was handed to mpv: without a picture in START_TIMEOUT_MS it has
   * failed. mpv does not say so itself -- at an address that refuses it
   * retries for minutes -- so the time is kept here.
   */
  opening(): void {
    this.stopStarting();
    this.starting = setTimeout(() => {
      this.starting = null;
      playbackLog(`app: no picture in ${START_TIMEOUT_MS / 1000} s`);
      if (this.recovery.played) {
        // A reopen after a drop that does not come back: an ending like any other.
        this.ended({ event: 'end-file', reason: 'error' });
      } else {
        this.onNeverStarted(NO_PICTURE);
      }
    }, START_TIMEOUT_MS);
  }

  private stopStarting(): void {
    if (this.starting) {
      clearTimeout(this.starting);
      this.starting = null;
    }
  }

  /** Whether the channel has shown a picture since it was opened. */
  get played(): boolean {
    return this.recovery.played;
  }

  /** The position last read, and when it last moved: a picture that stops moving has dropped too. */
  private lastPosition = -1;
  private movedAt = 0;

  /** The picture is there: told at mpv's `playback-restart` and at every position read. */
  playing(): void {
    this.stopStarting();
    if (!this.stopped && !this.pending) {
      this.recovery.playing();
      this.watchStall();
    }
  }

  /**
   * A channel whose provider has gone: mpv holds the last picture and goes on
   * reconnecting, without ever ending the stream (a provider stopped under a
   * playing channel, 23 November). Not moving for START_TIMEOUT_MS, while no
   * pause of the viewer's is in progress, is an ending like any other.
   */
  private watchStall(): void {
    const position = this.watcher.positionSeconds;
    const now = Date.now();
    if (position !== this.lastPosition || this.watcher.pause?.active) {
      this.lastPosition = position;
      this.movedAt = now;
      return;
    }
    if (now - this.movedAt >= START_TIMEOUT_MS) {
      playbackLog(`app: the picture has not moved for ${START_TIMEOUT_MS / 1000} s`);
      this.lastPosition = -1;
      this.ended({ event: 'end-file', reason: 'error' });
    }
  }

  /**
   * mpv ended a stream. True when this answered it: an ending by itself
   * (eof or error) of a channel that had shown a picture. A channel that never
   * started is left to the caller, which reports it as before.
   */
  ended(event: MpvEvent): boolean {
    if ((event.reason !== 'eof' && event.reason !== 'error') || !this.recovery.played) {
      return false;
    }
    const next = this.recovery.ended();
    if (next.kind === 'giveUp') {
      this.stopped = true;
      this.stopStarting();
      // Not left retrying behind the message, holding the one connection.
      this.watcher.send(['stop']);
      this.onGaveUp(`stopped after ${next.attempts} reopens`);
      playbackLog(`app: gave up after ${next.attempts} reopens in a row; waiting for Enter or Escape`);
      const text =
        `${this.words.stopped ?? 'The channel stopped. The provider may have ended the connection.'}\n` +
        `${this.words.tryAgain ?? 'Enter: try again \u00b7 Esc: close'}`;
      this.showText(text, GIVEN_UP_MS);
      return true;
    }
    playbackLog(`app: reopening ${redactUrl(this.url)} at the live edge in ${next.delayMs} ms (attempt ${next.attempt})`);
    this.reopen(next.delayMs);
    return true;
  }

  /** Enter, after giving up. True when it meant something. */
  retry(): boolean {
    if (!this.stopped) {
      return false;
    }
    this.stopped = false;
    this.recovery.reset();
    playbackLog(`app: the viewer asked to try again; reopening ${redactUrl(this.url)}`);
    this.reopen(0);
    return true;
  }

  /** Another channel, opened by the app: nothing about this one counts. */
  switched(url: string): void {
    this.url = url;
    this.cancel();
    this.stopStarting();
    this.stopped = false;
    this.recovery.forget();
  }

  stop(): void {
    this.cancel();
    this.stopStarting();
  }

  private reopen(delayMs: number): void {
    this.cancel();
    this.stopStarting();
    this.lastPosition = -1;
    this.showText(this.words.reconnecting ?? 'Reconnecting\u2026', UNTIL_REPLACED_MS);
    this.pending = setTimeout(() => {
      this.pending = null;
      this.watcher.send(['loadfile', this.url, 'replace']);
      this.opening();
    }, delayMs);
  }

  private cancel(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }

  private showText(text: string, ms: number): void {
    this.watcher.send(['show-text', text.split('$').join('$$'), ms]);
  }
}

/** How long "the channel stopped" stays up: until the viewer answers it. */
const GIVEN_UP_MS = 24 * 60 * 60 * 1000;

/**
 * A live channel that switches inside mpv (PL-D-1): the desktop's
 * ChannelSession. The page decides what every key means and writes every
 * line of text; this passes keys and mpv's events up, and carries out what
 * comes back.
 */
class DesktopChannels {
  itemId: string;
  private switched = false;
  private started = false;
  /** Whether a switch or its failure is on screen, which is when Backspace cancels. */
  private switching = false;
  private lastError: string | null = null;
  private pending: NodeJS.Timeout | null = null;
  closingWith: string | null = null;

  constructor(
    private readonly watcher: PositionWatcher,
    private readonly window: BrowserWindow | null,
    itemId: string,
    private readonly keeper: LiveKeeper | null
  ) {
    this.itemId = itemId;
    watcher.onEvent = event => this.onEvent(event);
    watcher.onPosition = () => this.arrived();
    if (keeper) {
      keeper.onNeverStarted = error => this.failedToStart(error);
    }
  }

  /** No picture, by mpv's error or the keeper's clock: a switched channel is the page's to decide, the first closes. */
  private failedToStart(error: string): void {
    if (this.switched && !this.started) {
      // The page decides: once more, give up, or close.
      this.lastError = error;
      this.watcher.send(['stop']);
      this.emit({ type: 'switchFailed', itemId: this.itemId, errorCode: error });
    } else {
      this.closingWith = error;
      playbackLog(`app: closing the player over ${error}`);
      this.watcher.quitWith(CLOSED_OVER_FAILURE_EXIT);
    }
  }

  /** The picture is there: say so once per channel. */
  private arrived(): void {
    if (this.pending) {
      return;
    }
    this.keeper?.playing();
    if (this.started) {
      return;
    }
    this.started = true;
    this.switching = false;
    this.watcher.inPage?.text('', 0);
    this.emit({ type: 'channelStarted', itemId: this.itemId });
  }

  private emit(payload: Record<string, unknown>): void {
    if (this.window && !this.window.isDestroyed()) {
      toPage(this.window.webContents, 'xtream:player-event', payload);
    }
  }

  private onEvent(event: MpvEvent): void {
    if (event.event === 'client-message' && event.args?.[0] === 'xtream') {
      const [, what, step] = event.args;
      if (what === 'channel') {
        this.emit({ type: 'channelRequested', step, itemId: this.itemId, started: this.started });
      } else if (what === 'back') {
        if (this.switching) {
          this.emit({ type: 'channelRequested', step: 'cancel', itemId: this.itemId, started: this.started });
        } else {
          this.watcher.quitWith(VIEWER_CLOSED_EXIT);
        }
      } else if (what === 'banner') {
        this.emit({ type: 'bannerRequested', itemId: this.itemId });
      } else if (what === 'retry') {
        this.keeper?.retry();
      }
      return;
    }

    if (event.event === 'playback-restart') {
      this.arrived();
      return;
    }

    if (event.event === 'end-file') {
      if (this.started && this.keeper?.ended(event)) {
        // A channel that was playing and dropped: opened again (LiveKeeper).
        return;
      }
      if (event.reason === 'error') {
        this.failedToStart(`mpv could not open it (${event.file_error ?? 'unknown'})`);
      } else if (event.reason === 'eof') {
        // Idle would leave an empty window where a stream ended.
        playbackLog('app: closing the player at the end of the stream');
        this.watcher.send(['quit']);
      }
    }
  }

  command(command: PlayerCommand): void {
    switch (command.kind) {
      case 'switch':
        if (!isStreamUrl(command.url)) {
          return;
        }
        if (this.pending) {
          clearTimeout(this.pending);
        }
        // A pause ends with its channel; its file goes as the stream closes.
        this.watcher.pause?.leave(command.url);
        this.keeper?.switched(command.url);
        playbackLog(
          `app: stops the stream to switch channel; opens ${redactUrl(command.url)} in ${Math.max(0, command.waitMs)} ms`
        );
        // Stopped now, opened after the wait: the provider goes on counting a
        // closed stream for a moment, and allows one.
        this.watcher.send(['stop']);
        this.itemId = command.itemId;
        this.switched = true;
        this.started = false;
        this.switching = true;
        this.lastError = null;
        this.showText(command.text, UNTIL_REPLACED_MS);
        this.pending = setTimeout(() => {
          this.pending = null;
          this.watcher.send(['loadfile', command.url, 'replace']);
          this.keeper?.opening();
        }, Math.max(0, command.waitMs));
        return;
      case 'text':
        this.showText(command.text, command.ms);
        return;
      case 'giveUp':
        this.switching = true;
        this.showText(command.text, UNTIL_REPLACED_MS);
        return;
      case 'close':
        this.closingWith = this.lastError ?? 'mpv could not play this';
        playbackLog(`app: the page closes the player (${this.closingWith})`);
        this.watcher.quitWith(CLOSED_OVER_FAILURE_EXIT);
        return;
    }
  }

  private showText(text: string, ms: number): void {
    // show-text expands ${properties}; a programme title with a dollar in it
    // is not one.
    this.watcher.send(['show-text', text.split('$').join('$$'), ms]);
  }

  stop(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    this.keeper?.stop();
  }
}

let channels: DesktopChannels | null = null;

/** A live channel's pause, on mpv's pipe, its cache file in the app's own folder. */
function livePause(watcher: PositionWatcher, request: PlayRequest): LivePause {
  const pause = new LivePause(
    {
      send: command => watcher.send(command),
      sendNamed: command => watcher.sendNamed(command),
      position: () => watcher.positionExact,
      cacheState: () => watcher.cacheState,
      osdSize: () => watcher.osdSize,
      badge: watcher.inPage ? shown => watcher.inPage?.badge(shown) : undefined
    },
    request.url,
    request.liveWords ?? {},
    join(app.getPath('userData'), 'live-pause')
  );
  watcher.pause = pause;
  return pause;
}

let running: ChildProcess | null = null;
/** The frames of tvinto-player while it plays, and the pipe its keys go to. */
let frames: VideoFrames | null = null;
let keys: PositionWatcher | null = null;

/** Whether mpv has the screen. An update must not restart the app under it. */
export const isPlaying = (): boolean => running !== null;

/** Wires the renderer's request for playback to mpv. Called once, at startup. */
export function registerNativePlayer(): void {
  setPlaybackLogFolder(app.getPath('userData'));
  ipcMain.handle('xtream:player-command', (event, command: PlayerCommand) => {
    if (!fromAppPage(event)) {
      return;
    }
    channels?.command(command);
  });

  // tvinto-player's picture: the size the page shows it at, and keys
  // pressed over it, which mpv binds as it always has (input.conf).
  ipcMain.on('xtream:video-size', (event, width: unknown, height: unknown) => {
    if (fromAppPage(event) && typeof width === 'number' && typeof height === 'number') {
      frames?.resize(width, height);
    }
  });
  ipcMain.on('xtream:video-key', (event, key: unknown) => {
    if (fromAppPage(event) && typeof key === 'string' && /^[A-Za-z0-9_+-]{1,16}$|^.$/.test(key)) {
      keys?.pressed(key);
      keys?.send(['keypress', key]);
    }
  });

  // The page's player controls (stage 3): a key mpv binds, a seek, a track.
  ipcMain.on('xtream:video-command', (event, command: VideoCommand) => {
    if (!fromAppPage(event) || !keys || !command || typeof command !== 'object') {
      return;
    }
    const watcher = keys;
    switch (command.kind) {
      case 'key':
        if (typeof command.key === 'string' && /^[A-Za-z0-9_+-]{1,16}$|^.$/.test(command.key)) {
          watcher.pressed(command.key);
          watcher.send(['keypress', command.key]);
        }
        return;
      case 'seek':
        if (Number.isFinite(command.seconds)) {
          watcher.send(['seek', command.seconds, command.mode === 'absolute' ? 'absolute' : 'relative']);
        }
        return;
      case 'audio':
        if (Number.isInteger(command.id)) {
          watcher.send(['set_property', 'aid', command.id]);
        }
        return;
      case 'subtitle':
        // Off hides the track rather than unselecting it (subtitleChoice.ts).
        if (command.id === null || Number.isInteger(command.id)) {
          subtitleCommands(command.id).forEach(line => watcher.send(line));
        }
        return;
      case 'addSubtitle':
        addWhilePlaying(line => watcher.send(line), command.subtitle);
        return;
      case 'pause':
        watcher.send(['set_property', 'pause', command.paused === true]);
        return;
      case 'volume':
        if (Number.isFinite(command.volume)) {
          watcher.send(['set_property', 'volume', clampVolume(command.volume)]);
        }
        return;
      case 'mute':
        watcher.send(['set_property', 'mute', command.muted === true]);
        return;
    }
  });

  ipcMain.handle('xtream:play', async (event, request: PlayRequest): Promise<PlayResult> => {
    if (running) {
      // One at a time. The subscription allows a single connection anyway, and
      // two windows fighting over it is worse than refusing the second.
      return { positionSeconds: 0, durationSeconds: 0, played: false, errorCode: 'already playing' };
    }

    if (!fromAppPage(event)) {
      return { positionSeconds: 0, durationSeconds: 0, played: false, errorCode: 'not the app' };
    }
    // A recording of this app's own is the one local file mpv is handed
    // (src/recorder.ts says which those are); by its path, after `--` as ever.
    const recorded = desktopRecorder().recordingFile(request?.url);
    if (recorded) {
      request = { ...request, url: recorded };
    } else if (!isStreamUrl(request?.url)) {
      return { positionSeconds: 0, durationSeconds: 0, played: false, errorCode: 'not a stream address' };
    }
    const mpv = findMpv();
    if (!mpv) {
      return { positionSeconds: 0, durationSeconds: 0, played: false, errorCode: MPV_MISSING };
    }

    const watcher = new PositionWatcher(request);

    // The window that asked, so the picture appears in it. Asked of the sender
    // rather than taken from `getAllWindows()`, which would be a guess the day
    // there are two.
    const window = BrowserWindow.fromWebContents(event.sender);
    // Inside the app's window when tvinto-player can (src/videoFrames.ts);
    // mpv's own window over the app otherwise.
    const helper = window && request.engine !== 'window' ? await findHelper(mpv) : null;
    const inside = helper ? null : overlayGeometry(window);
    if (helper && window) {
      // The page's player (videoState.ts): set before the live pause and
      // Skip intro are made, which hand it their words.
      const contents = window.webContents;
      watcher.inPage = new VideoState(state => toPage(contents, 'xtream:video-state', state), {
        title: request.title,
        live: isLive(request),
        channels: request.channelKeys === true && request.inPlayerSwitching === true
      });
    }

    return new Promise<PlayResult>(resolve => {
      let child: ChildProcess;

      try {
        if (helper && window) {
          const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
          const content = window.getContentBounds();
          child = spawn(
            helper,
            [
              `--tvinto-parent=${process.pid}`,
              `--tvinto-size=${Math.round(content.width * scale)}x${Math.round(content.height * scale)}`,
              // The page draws every word and control: none of mpv's. Before
              // the rest, which ends with `--` and the address: anything after
              // it is a file to play, and these two once were.
              '--osd-level=0',
              '--osc=no',
              ...argumentsFor(request, 'tvinto-player', null, watcher.pipe)
            ],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
          );
          frames = new VideoFrames(child, window);
          frames.onLog = line => playbackLog(`tvinto-player: ${line.replace(/^log /, '')}`);
          toPage(window.webContents, 'xtream:video-open', true);
        } else {
          // mpv decodes in software unless told otherwise: about 69 % of a
          // core for a 4K HEVC film, 3.5 % with this (d3d11va). auto-safe
          // falls back to software where the GPU cannot. tvinto-player sets
          // the same itself (native/tvinto-player.cpp).
          // Before the rest, which ends with `--` and the address.
          child = spawn(mpv, ['--hwdec=auto-safe', ...argumentsFor(request, 'mpv', inside, watcher.pipe)], {
            windowsHide: false
          });
        }
      } catch (error) {
        resolve({
          positionSeconds: 0,
          durationSeconds: 0,
          played: false,
          errorCode: `could not start mpv: ${String(error)}`
        });
        return;
      }

      running = child;
      // Its name, kept out of any error report this run (src/errorReports.ts).
      rememberPlayed(request.title);
      // The screen stays on while anything plays, in either window: a film
      // watched without touching the mouse is not a machine left alone.
      const awake = powerSaveBlocker.start('prevent-display-sleep');
      playbackLog(
        `app: opens ${isLive(request) ? 'a live channel' : 'a film or an episode'} ${redactUrl(request.url)} in ${helper ? 'tvinto-player' : 'mpv'}`
      );
      keys = watcher;
      watcher.start();
      // Where a film or an episode has got to, every half minute, so a crash
      // of the app or the machine loses at most that much.
      const progress = request.reportProgress
        ? setInterval(() => {
            if (watcher.durationSeconds > 0 && watcher.positionSeconds > 0 && window && !window.isDestroyed()) {
              toPage(window.webContents, 'xtream:player-event', {
                type: 'progress',
                positionSeconds: watcher.positionSeconds,
                durationSeconds: watcher.durationSeconds
              });
            }
          }, PROGRESS_EVERY_MS)
        : null;
      const keeper = isLive(request)
        ? new LiveKeeper(watcher, request.url, request.liveWords ?? {}, errorCode => {
            if (window && !window.isDestroyed()) {
              toPage(window.webContents, 'xtream:player-event', { type: 'streamFailed', errorCode });
            }
          })
        : null;
      channels =
        request.channelKeys === true && request.inPlayerSwitching === true
          ? new DesktopChannels(watcher, window, request.itemId ?? '', keeper)
          : null;
      const session = channels;
      const pause = isLive(request) ? livePause(watcher, request) : null;
      if (pause && !session) {
        // mpv is idle between streams here too (argumentsFor), so the end of
        // one is this player's to answer, as DesktopChannels does: a channel
        // that dropped is opened again (LiveKeeper), and one that never
        // started closes the player as before.
        watcher.onPosition = () => keeper?.playing();
        watcher.onEvent = event => {
          if (event.event === 'playback-restart') {
            keeper?.playing();
          } else if (event.event === 'client-message' && event.args?.[0] === 'xtream' && event.args[1] === 'retry') {
            keeper?.retry();
          } else if (event.event === 'end-file' && keeper?.ended(event)) {
            // Opened again, or the message is up.
          } else if (event.event === 'end-file' && event.reason === 'error') {
            playbackLog('app: closing the player: the channel would not open');
            watcher.closingWith = `mpv could not open it (${event.file_error ?? 'unknown'})`;
            watcher.quitWith(CLOSED_OVER_FAILURE_EXIT);
          } else if (event.event === 'end-file' && event.reason === 'eof') {
            playbackLog('app: closing the player at the end of the stream');
            watcher.send(['quit']);
          }
        };
      }
      if (keeper && !session) {
        keeper.onNeverStarted = error => {
          playbackLog(`app: closing the player over ${error}`);
          watcher.closingWith = error;
          watcher.quitWith(CLOSED_OVER_FAILURE_EXIT);
        };
      }
      keeper?.opening();
      if (!session && !pause) {
        if (request.skipIntros !== 'off') {
          new DesktopSkips(watcher, handedSkips(request.skips), request.skipWords ?? {}, request.skipIntros === 'auto');
        }
      }

      // A child window goes when its parent does; the process behind it does
      // not. Without this, closing the app mid-film leaves mpv running with
      // no window, holding the subscription's one allowed connection.
      let closedWithWindow = false;
      const stopWithWindow = () => {
        closedWithWindow = true;
        child.kill();
      };
      window?.once('closed', stopWithWindow);

      const done = () => {
        keeper?.stop();
        if (progress) {
          clearInterval(progress);
        }
        watcher.stop();
        session?.stop();
        pause?.stop();
        if (channels === session) {
          channels = null;
        }
        running = null;
        keys = null;
        if (powerSaveBlocker.isStarted(awake)) {
          powerSaveBlocker.stop(awake);
        }
        if (helper) {
          frames = null;
          watcher.inPage?.close();
          if (window && !window.isDestroyed()) {
            toPage(window.webContents, 'xtream:video-open', false);
          }
        }
        window?.removeListener('closed', stopWithWindow);
      };

      child.on('error', error => {
        done();
        playbackLog(`mpv could not start: ${error.message}`);

        // Nothing to run is not a playback failure, it is this player being
        // absent -- and the app has another. Named so the renderer can tell the
        // difference and quietly use the in-page player instead, which handles
        // everything except the codecs Chromium lacks.
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';

        resolve({
          positionSeconds: 0,
          durationSeconds: 0,
          played: false,
          errorCode: missing ? MPV_MISSING : `mpv failed to start: ${error.message}`
        });
      });

      child.on('exit', (exitCode, signal) => {
        done();
        const code = signal ? exitCode : watcher.askedExit ?? exitCode;
        playbackLog(`mpv exited with code ${exitCode}${code !== exitCode ? ` (as asked: ${code})` : ''}`);
        // A crash or an unexpected exit, as an error report (src/errorReports.ts).
        // Not the app's window closing, which kills it on purpose.
        if (!closedWithWindow) {
          reportPlayerExit(helper ? 'tvinto-player' : 'mpv', code, signal);
        }

        // mpv exits zero when the viewer closes the window, which is the
        // ordinary way playback ends rather than a failure -- and with one of
        // the channel codes when Page Up or Page Down closed it, which is not
        // a failure either.
        const channelStep =
          code === CHANNEL_NEXT_EXIT ? 'next' : code === CHANNEL_PREVIOUS_EXIT ? 'previous' : null;
        const failed = code !== 0 && code !== null && !channelStep;
        const closedOverFailure = code === CLOSED_OVER_FAILURE_EXIT ? session?.closingWith ?? watcher.closingWith : null;

        resolve({
          positionSeconds: watcher.positionSeconds,
          durationSeconds: watcher.durationSeconds,
          // A channel left before its picture came was not watched.
          played: !failed && (keeper === null || keeper.played),
          errorCode: failed ? closedOverFailure ?? `mpv exited with code ${code}` : null,
          channelStep,
          itemId: session?.itemId ?? request.itemId ?? null,
          // Spread rather than listed field by field. Listing them is how the
          // wrong subtitle came back: the titles were added to the watcher and
          // to the result's type, and the object handed over went on carrying
          // only the languages. Nothing complained, and mpv had reported
          // "English (SDH)" perfectly.
          ...watcher.tracks()
        });
      });
    });
  });
}
