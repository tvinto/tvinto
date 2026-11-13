import { mkdirSync, readdirSync, rmSync, statfsSync } from 'fs';
import { join } from 'path';
import { playbackLog } from './playbackLog';

/**
 * Pausing live TV on the desktop: mpv's own cache, put on disk at the pause.
 *
 * Android hands the channel over: its player lets go, and a writer asks for
 * the channel again and saves it (LivePause.java). mpv needs none of that. It
 * keeps reading a paused stream into its demuxer cache for as long as the
 * cache's limits allow, on the connection it already has, and it can seek in
 * what it read. So the pause is three settings changed the moment the pause
 * begins -- the cache moved to a file, its limits raised to the pause's -- and
 * a step is a seek. No second request, no gap while one connection closes and
 * another opens, and every channel mpv can play can be paused, HLS of any kind
 * included.
 *
 * The cost: the file is mpv's, append-only, and deleted only when the stream
 * is closed. So Back to live opens the channel again (one new request, as on
 * Android), which closes the stream and deletes the file; a step forward to
 * live does the same. Before the pause, the cache is mpv's ordinary one, in
 * memory: nothing is written to disk while watching live.
 */

/** Settings mpv is given at the pause, and what they go back to after (mpv's defaults). */
const PAUSED_CACHE = {
  'cache-on-disk': true,
  // On disk these cap the packets' metadata, about 50 MB an hour, not the data.
  'demuxer-max-bytes': '1GiB',
  'demuxer-max-back-bytes': '1GiB',
  // Read ahead of the picture at most this far: the 90 minutes.
  'cache-secs': 90 * 60
};
const LIVE_CACHE = {
  'cache-on-disk': false,
  'demuxer-max-bytes': '150MiB',
  'demuxer-max-back-bytes': '50MiB',
  'cache-secs': 3_600_000
};

/** The limits, as on Android: 90 minutes (above), 4 GB, 500 MB left free. */
export const MAX_FILE_BYTES = 4 * 1024 ** 3;
export const MIN_FREE_BYTES = 500 * 1024 ** 2;
/**
 * Past a limit mpv stops reading ahead, but goes on reading what is watched
 * (it cannot be told to stop reading at all), so the file can still grow by
 * that. This far past it, the pause ends: back to live, the file deleted.
 */
const HARD_MARGIN_BYTES = 256 * 1024 ** 2;

/** One press of Left or Right behind live; Rewind and Fast forward are three. */
export const STEP_SECONDS = 10;
/** A step forward to within this of live is a step to live. */
export const LIVE_EDGE_SECONDS = 5;

/** The words, in the app's language, from the page. */
export interface LiveWords {
  paused?: string;
  /** "{0} behind live". */
  behind?: string;
  backToLive?: string;
  cannotPause?: string;
  /** While a channel that dropped is opened again (player.ts, LiveKeeper). */
  reconnecting?: string;
  /** When it could not be: what happened, and the keys under it. */
  stopped?: string;
  tryAgain?: string;
}

/** What a step does: go to live, or seek in what was read. */
export type Step = { kind: 'live' } | { kind: 'seek'; to: number };

/**
 * Where a step lands, in the stream's own seconds: never before where the
 * pause began, never past what has been read, and forward to within
 * LIVE_EDGE_SECONDS of live is live.
 */
export function stepTo(options: { from: number; by: number; start: number; live: number; newest: number | null }): Step {
  const newest = Math.min(options.newest ?? options.live, options.live);
  const target = options.from + options.by;
  if (options.by > 0 && target >= options.live - LIVE_EDGE_SECONDS) {
    return { kind: 'live' };
  }
  return { kind: 'seek', to: Math.max(options.start, Math.min(target, newest)) };
}

/** "1:23", "12:05", "1:02:03". */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = whole % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`;
}

/** Which limit the pause has reached, if any: 'soft' stops reading ahead, 'hard' ends it. */
export function limitReached(fileBytes: number | null, freeBytes: number | null): 'soft' | 'hard' | null {
  const file = fileBytes ?? 0;
  const free = freeBytes ?? Number.POSITIVE_INFINITY;
  if (file >= MAX_FILE_BYTES + HARD_MARGIN_BYTES || free < MIN_FREE_BYTES - HARD_MARGIN_BYTES) {
    return 'hard';
  }
  return file >= MAX_FILE_BYTES || free < MIN_FREE_BYTES ? 'soft' : null;
}

/** Text as ASS shows it: no override blocks or escapes from the words. */
const plain = (text: string) => text.replace(/[{}\\]/g, '');

/**
 * The badge in the top corner, as ASS events for mpv's `osd-overlay`: a dark
 * rounded box, the figure in it, and under it how to get back to live.
 *
 * mpv cannot measure text, so the box is sized from the number of characters;
 * the font is a wide one for its size, so it errs on the roomy side.
 */
export function badgeAss(line: string, hint: string, width: number, height = 720): string {
  const size = 28;
  const hintSize = 19;
  const margin = 32;
  const padX = 18;
  const padY = 9;
  const textWidth = Math.max(line.length * size * 0.56, hint ? hint.length * hintSize * 0.5 : 0);
  const boxW = Math.round(textWidth + 2 * padX);
  const boxH = Math.round(size * 1.2 + (hint ? hintSize * 1.25 : 0) + 2 * padY);
  const right = width - margin;
  const left = right - boxW;
  const r = 10;
  const box =
    `m ${r} 0 l ${boxW - r} 0 b ${boxW} 0 ${boxW} 0 ${boxW} ${r} l ${boxW} ${boxH - r} ` +
    `b ${boxW} ${boxH} ${boxW} ${boxH} ${boxW - r} ${boxH} l ${r} ${boxH} b 0 ${boxH} 0 ${boxH} 0 ${boxH - r} ` +
    `l 0 ${r} b 0 0 0 0 ${r} 0`;
  const events = [
    `{\\an7\\pos(${left},${margin})\\bord0\\shad0\\1c&H20120B&\\1a&H33&\\p1}${box}{\\p0}`,
    `{\\an9\\pos(${right - padX},${margin + padY})\\fnSegoe UI\\b1\\fs${size}\\fsp1\\bord0\\shad0\\1c&HFFFFFF&}${plain(line)}`
  ];
  if (hint) {
    events.push(
      `{\\an3\\pos(${right - padX},${margin + boxH - padY})\\fnSegoe UI\\fs${hintSize}\\bord0\\shad0\\1c&HC8C8C8&}${plain(hint)}`
    );
  }
  void height;
  return events.join('\n');
}

/** What LivePause needs of the pipe to mpv (PositionWatcher in player.ts). */
export interface MpvLink {
  send(command: unknown[]): void;
  /** Sends a command given by name, with named arguments. */
  sendNamed(command: Record<string, unknown>): void;
  /** The position mpv last gave, in seconds, and when it was read (Date.now()). */
  position(): { seconds: number; at: number } | null;
  /** mpv's `demuxer-cache-state`, as last read. */
  cacheState(): CacheState | null;
  /** mpv's OSD size in pixels, as last read. */
  osdSize(): { width: number; height: number } | null;
  /**
   * Where the badge goes when the page draws it (tvinto-player, whose OSD is
   * off): the two lines, or null to take it down. Without it, mpv's OSD.
   */
  badge?(shown: { line: string; hint: string } | null): void;
}

export interface CacheState {
  'seekable-ranges'?: { start: number; end: number }[];
  'cache-end'?: number;
  'cache-duration'?: number;
  'file-cache-bytes'?: number;
}

/** An event mpv sends over its pipe. */
export interface PauseEvent {
  event: string;
  name?: string;
  data?: unknown;
  reason?: string;
  args?: string[];
}

/** The id the badge's overlay has, of mpv's 64. */
const BADGE_OVERLAY = 63;
/** The observed property id for `pause`. */
const OBSERVE_PAUSE = 4242;

/** A pause in progress. Stream seconds are mpv's `time-pos`; wall time is Date.now(). */
interface Session {
  /** Wall-clock ms minus stream ms of live: live is now - this. */
  liveOffsetMs: number;
  /** Where the pause began, in stream seconds; never stepped before. */
  start: number;
  /** Past a soft limit: no more reading ahead. */
  limited: boolean;
}

/**
 * One live channel's pausing, for as long as mpv plays it. The keys come as
 * script messages (`xtream step 10`, `xtream live`); the pause itself is
 * noticed by watching mpv's `pause` property, so Space, the media keys, a
 * right click and the on-screen controller's button all pause the same way.
 */
export class LivePause {
  private session: Session | null = null;
  private paused = false;
  private observing = false;
  private reloading = false;
  private timer: NodeJS.Timeout | null = null;
  /** A step on its way: shown at once, believed until mpv reads a position after it. */
  private seekTo: number | null = null;
  private seekDoneAt = 0;
  private seeking = false;

  constructor(
    private readonly mpv: MpvLink,
    private url: string,
    private readonly words: LiveWords,
    private readonly folder: string,
    private readonly freeBytes: (folder: string) => number | null = freeSpace
  ) {
    clearFolder(folder);
  }

  /** Whether a pause is in progress (paused, or playing behind live). */
  get active(): boolean {
    return this.session !== null;
  }

  /** Called whenever mpv's pipe answers: subscribes to `pause` once it is there. */
  connected(): void {
    if (!this.observing) {
      this.observing = true;
      this.mpv.send(['observe_property', OBSERVE_PAUSE, 'pause']);
    }
  }

  /**
   * Sees mpv's events before anyone else. True when the event was this
   * pause's own business and should go no further.
   */
  onEvent(event: PauseEvent): boolean {
    if (event.event === 'property-change' && event.name === 'pause') {
      this.pausedChanged(event.data === true);
      return true;
    }
    if (event.event === 'client-message' && event.args?.[0] === 'xtream') {
      if (event.args[1] === 'step') {
        this.step(Number(event.args[2]));
        return true;
      }
      if (event.args[1] === 'live') {
        this.backToLive();
        return true;
      }
      return false;
    }
    if (event.event === 'playback-restart') {
      this.seeking = false;
      this.seekDoneAt = Date.now();
      this.reloading = false;
      return false;
    }
    if (event.event === 'seek' && !this.seeking && !this.session && !this.reloading) {
      // The on-screen controller's bar, which can seek back in mpv's cache:
      // behind live now, so a pause from where the picture was.
      this.begin();
      this.draw();
      return false;
    }
    if (event.event === 'end-file' && this.session && (event.reason === 'eof' || event.reason === 'error')) {
      // The end of what was read (the provider let go while paused for long):
      // live again, as on Android.
      this.backToLive();
      return true;
    }
    return false;
  }

  /** A position arrived from mpv: a step is over once mpv reads one after it. */
  positionRead(at: number): void {
    if (this.seekTo !== null && !this.seeking && at > this.seekDoneAt) {
      this.seekTo = null;
    }
    const session = this.session;
    const now = this.position();
    if (session && now !== null && this.seekTo === null && now < session.start - 1) {
      // Something seeked to before the pause (the controller's bar).
      this.seek(session.start);
    }
  }

  /** Another channel: whatever the pause was, it ends, without opening anything. */
  leave(url: string): void {
    this.url = url;
    this.finish();
  }

  /** Back to live: the channel opened again, which closes the stream and deletes its file. */
  backToLive(): void {
    if (!this.session && !this.paused) {
      return;
    }
    this.finish();
    this.reloading = true;
    playbackLog('app: back to live, reopening the channel');
    this.mpv.send(['loadfile', this.url, 'replace']);
  }

  /** mpv has gone. */
  stop(): void {
    this.stopTicking();
    this.session = null;
    clearFolder(this.folder);
  }

  private pausedChanged(paused: boolean): void {
    if (paused === this.paused) {
      return;
    }
    // Where the picture stopped: estimated while still playing, so the
    // second since mpv last said is counted.
    const stoppedAt = this.position();
    this.paused = paused;
    if (paused && !this.session) {
      if (this.reloading) {
        return;
      }
      const ranges = this.mpv.cacheState()?.['seekable-ranges'];
      if (ranges && ranges.length === 0) {
        // mpv cannot seek in what it reads of this stream: pausing would only stall it.
        this.mpv.send(['set_property', 'pause', false]);
        this.mpv.send(['show-text', plain(this.words.cannotPause ?? "This channel can't be paused").split('$').join('$$'), 3000]);
        return;
      }
      this.begin(stoppedAt);
    } else if (paused && this.seekTo === null && stoppedAt !== null) {
      // Paused again while behind: hold the figure where the picture stopped.
      this.seekTo = stoppedAt;
      this.seekDoneAt = Date.now();
    }
    this.draw();
  }

  private begin(from: number | null = this.position()): void {
    const at = from ?? 0;
    this.session = { liveOffsetMs: Date.now() - at * 1000, start: at, limited: false };
    mkdirSafe(this.folder);
    this.mpv.send(['set_property', 'demuxer-cache-dir', this.folder]);
    for (const [name, value] of Object.entries(PAUSED_CACHE)) {
      this.mpv.send(['set_property', name, value]);
    }
    this.startTicking();
  }

  private finish(): void {
    const had = this.session !== null;
    this.session = null;
    this.seekTo = null;
    this.stopTicking();
    if (had) {
      for (const [name, value] of Object.entries(LIVE_CACHE)) {
        this.mpv.send(['set_property', name, value]);
      }
    }
    if (this.paused) {
      this.mpv.send(['set_property', 'pause', false]);
    }
    this.hideBadge();
  }

  private step(by: number): void {
    const session = this.session;
    if (!session || !Number.isFinite(by) || by === 0) {
      // Live: Left and Right do nothing.
      return;
    }
    const from = this.position();
    if (from === null) {
      return;
    }
    const state = this.mpv.cacheState();
    const ranges = state?.['seekable-ranges'] ?? [];
    const newest = ranges.length ? Math.max(...ranges.map(range => range.end)) : null;
    const step = stepTo({ from, by, start: session.start, live: this.live(session), newest });
    if (step.kind === 'live') {
      this.backToLive();
      return;
    }
    this.seek(step.to);
  }

  private seek(to: number): void {
    this.seekTo = to;
    this.seeking = true;
    // Paused, mpv shows the frame there and stays paused.
    this.mpv.send(['seek', to, 'absolute+exact']);
    this.draw();
  }

  /** Live, in stream seconds, now. */
  private live(session: Session): number {
    return (Date.now() - session.liveOffsetMs) / 1000;
  }

  /** The picture's place in the stream, in seconds: a step's target until mpv has caught up. */
  private position(): number | null {
    if (this.seekTo !== null) {
      const since = this.seeking || this.paused ? 0 : (Date.now() - this.seekDoneAt) / 1000;
      return this.seekTo + Math.max(0, since);
    }
    const read = this.mpv.position();
    if (!read) {
      return null;
    }
    return read.seconds + (this.paused ? 0 : Math.max(0, Date.now() - read.at) / 1000);
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private stopTicking(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const session = this.session;
    if (!session) {
      return;
    }
    const limit = limitReached(this.mpv.cacheState()?.['file-cache-bytes'] ?? null, this.freeBytes(this.folder));
    if (limit === 'hard') {
      console.info('[pause] past the disk limit: back to live');
      this.backToLive();
      return;
    }
    if (limit === 'soft' && !session.limited) {
      session.limited = true;
      console.info('[pause] at the disk limit: no more reading ahead');
      const ahead = this.mpv.cacheState()?.['cache-duration'] ?? 1;
      this.mpv.send(['set_property', 'cache-secs', Math.max(1, Math.floor(ahead))]);
    }
    this.draw();
  }

  private draw(): void {
    const session = this.session;
    const at = this.position();
    if (!session || at === null) {
      this.hideBadge();
      return;
    }
    const behind = clockOf(this.live(session) - at);
    const line = this.paused
      ? `${this.words.paused ?? 'PAUSED'} · ${behind}`
      : (this.words.behind ?? '{0} behind live').replace('{0}', behind);
    const hint = `${this.words.backToLive ?? 'Back to live'} · End`;
    if (this.mpv.badge) {
      this.mpv.badge({ line, hint });
      return;
    }
    const size = this.mpv.osdSize();
    const height = 720;
    const width = size && size.height > 0 ? Math.round((height * size.width) / size.height) : 1280;
    this.mpv.sendNamed({
      name: 'osd-overlay',
      id: BADGE_OVERLAY,
      format: 'ass-events',
      res_x: width,
      res_y: height,
      z: 10,
      data: badgeAss(line, hint, width, height)
    });
  }

  private hideBadge(): void {
    if (this.mpv.badge) {
      this.mpv.badge(null);
      return;
    }
    this.mpv.sendNamed({ name: 'osd-overlay', id: BADGE_OVERLAY, format: 'none', data: '' });
  }
}

/** Free space where the cache is written, or null when it cannot be told. */
function freeSpace(folder: string): number | null {
  try {
    const stats = statfsSync(folder);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function mkdirSafe(folder: string): void {
  try {
    mkdirSync(folder, { recursive: true });
  } catch {
    // mpv falls back to its own cache folder.
  }
}

/**
 * Anything an earlier mpv left: it deletes its cache file when the stream
 * closes, so only a crash leaves one, and only this folder is mpv's.
 */
function clearFolder(folder: string): void {
  try {
    for (const name of readdirSync(folder)) {
      rmSync(join(folder, name), { force: true, recursive: true });
    }
  } catch {
    // Not there, or a file still open: next time.
  }
}
