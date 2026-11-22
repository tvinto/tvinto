/**
 * What the page's player shows while tvinto-player plays (stage 3 of the
 * desktop player plan): mpv's OSD is off, and everything it would have
 * written on the picture -- a switching message, "Reconnecting…", the live
 * pause badge, the offer to skip an intro -- is handed to the page instead,
 * with the position, the pause and the tracks, for the app's own controls.
 *
 * Sent a few times a second while open, and at once when a line appears or
 * goes, so the words keep up with what mpv is doing.
 */

export interface VideoTrack {
  id: number;
  title: string;
  lang: string;
  selected: boolean;
}

export interface VideoStateMessage {
  open: boolean;
  title: string;
  live: boolean;
  channels: boolean;
  positionSeconds: number;
  durationSeconds: number;
  paused: boolean;
  buffering: boolean;
  audio: VideoTrack[];
  subtitles: VideoTrack[];
  osd: string | null;
  badge: { line: string; hint: string } | null;
  skip: string | null;
  /** mpv's own answer, 0 to 100, and whether it is muted. */
  volume: number;
  muted: boolean;
}

/** One row of mpv's track-list, as far as this needs. */
interface MpvTrackRow {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  lang?: unknown;
  selected?: unknown;
}

/** show-text keeps `$` literal by doubling it; the page shows it once. */
const literal = (text: string): string => text.split('$$').join('$');

export class VideoState {
  private readonly state: VideoStateMessage;
  private osdTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ticker: ReturnType<typeof setInterval>;

  constructor(
    private readonly emit: (state: VideoStateMessage) => void,
    start: { title: string; live: boolean; channels: boolean },
    everyMs = 500
  ) {
    this.state = {
      open: true,
      ...start,
      positionSeconds: 0,
      durationSeconds: 0,
      paused: false,
      buffering: false,
      audio: [],
      subtitles: [],
      osd: null,
      badge: null,
      skip: null,
      volume: 100,
      muted: false
    };
    this.ticker = setInterval(() => this.send(), everyMs);
    this.send();
  }

  /** What mpv's `show-text` was asked to write; '' takes it down. */
  text(text: string, ms: number): void {
    if (this.osdTimer) {
      clearTimeout(this.osdTimer);
      this.osdTimer = null;
    }
    const shown = literal(text).trim();
    this.state.osd = shown ? shown : null;
    if (shown && ms > 0) {
      this.osdTimer = setTimeout(() => {
        this.state.osd = null;
        this.send();
      }, ms);
    }
    this.send();
  }

  badge(badge: { line: string; hint: string } | null): void {
    if (JSON.stringify(badge) !== JSON.stringify(this.state.badge)) {
      this.state.badge = badge;
      this.send();
    }
  }

  skip(label: string | null): void {
    if (label !== this.state.skip) {
      this.state.skip = label;
      this.send();
    }
  }

  position(seconds: number): void {
    this.state.positionSeconds = Math.max(0, seconds);
  }

  duration(seconds: number): void {
    this.state.durationSeconds = Math.max(0, seconds);
  }

  paused(paused: boolean): void {
    if (paused !== this.state.paused) {
      this.state.paused = paused;
      this.send();
    }
  }

  volume(volume: number): void {
    const rounded = Math.round(Math.max(0, volume));
    if (rounded !== this.state.volume) {
      this.state.volume = rounded;
      this.send();
    }
  }

  muted(muted: boolean): void {
    if (muted !== this.state.muted) {
      this.state.muted = muted;
      this.send();
    }
  }

  buffering(buffering: boolean): void {
    this.state.buffering = buffering;
  }

  tracks(rows: unknown[]): void {
    const of = (type: string): VideoTrack[] =>
      (rows as MpvTrackRow[])
        .filter(row => row && row.type === type && typeof row.id === 'number')
        .map(row => ({
          id: row.id as number,
          title: typeof row.title === 'string' ? row.title : '',
          lang: typeof row.lang === 'string' ? row.lang : '',
          selected: row.selected === true
        }));
    this.state.audio = of('audio');
    this.state.subtitles = of('sub');
  }

  /** The channel on screen changed inside the player. */
  retitle(title: string): void {
    this.state.title = title;
    this.send();
  }

  close(): void {
    clearInterval(this.ticker);
    if (this.osdTimer) {
      clearTimeout(this.osdTimer);
    }
    this.state.open = false;
    this.send();
  }

  private send(): void {
    this.emit({ ...this.state, audio: [...this.state.audio], subtitles: [...this.state.subtitles] });
  }
}
