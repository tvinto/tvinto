import { Injectable, computed, signal } from '@angular/core';
import { ChannelBanner } from '../utils/player-banner.utils';
import { currentLanguage } from '../utils/i18n';

/**
 * The desktop player drawn by the page (tvinto-player, electron/src/videoFrames.ts).
 *
 * mpv still plays -- every decision about pausing live, skipping, reopening a
 * dropped channel is in the main process as before -- but its picture is a
 * canvas here and its words are this page's: the state arrives a few times a
 * second, and the page's controls send back what was asked.
 *
 * Signals, because the app is zoneless: a state arriving over IPC redraws
 * nothing unless something the template reads changes.
 */

export interface DesktopTrack {
  id: number;
  label: string;
  selected: boolean;
}

/** A track as mpv names it (electron/src/videoState.ts). */
interface MpvTrack {
  id: number;
  title: string;
  lang: string;
  selected: boolean;
}

/** What the main process says about the player (electron/src/videoState.ts). */
interface StateMessage extends Omit<DesktopVideoState, 'audio' | 'subtitles'> {
  audio: MpvTrack[];
  subtitles: MpvTrack[];
}

/**
 * A track's name as the viewer reads it: its own title, with the language
 * in the app's words when the title does not already say it.
 */
export function trackLabel(track: MpvTrack, language: string): string {
  let named = '';
  try {
    named = track.lang ? (new Intl.DisplayNames([language], { type: 'language' }).of(track.lang) ?? track.lang) : '';
  } catch {
    named = track.lang;
  }
  const title = track.title.trim();
  if (!title) {
    return named || `#${track.id}`;
  }
  return named && !title.toLowerCase().includes(named.toLowerCase()) && !title.toLowerCase().includes(track.lang.toLowerCase())
    ? `${title} · ${named}`
    : title;
}

/** The player as the page shows it. */
export interface DesktopVideoState {
  open: boolean;
  title: string;
  live: boolean;
  /** Whether channel keys change channel inside the player. */
  channels: boolean;
  positionSeconds: number;
  durationSeconds: number;
  paused: boolean;
  buffering: boolean;
  audio: DesktopTrack[];
  subtitles: DesktopTrack[];
  /** A line the player would have written on the picture: switching, reconnecting, a failure. */
  osd: string | null;
  /** A live channel's pause: "PAUSED · 0:10" and how to get back. */
  badge: { line: string; hint: string } | null;
  /** "Skip intro", while an intro or a recap plays. */
  skip: string | null;
}

export type DesktopVideoCommand =
  | { kind: 'key'; key: string }
  | { kind: 'seek'; seconds: number; mode: 'relative' | 'absolute' }
  | { kind: 'audio'; id: number }
  | { kind: 'subtitle'; id: number | null }
  | { kind: 'pause'; paused: boolean };

interface DesktopVideoBridge {
  onState(listener: (state: StateMessage) => void): () => void;
  command(command: DesktopVideoCommand): void;
}

const bridge = (): DesktopVideoBridge | null =>
  (window as { xtreamDesktop?: { video?: DesktopVideoBridge } }).xtreamDesktop?.video ?? null;

const CLOSED: DesktopVideoState = {
  open: false,
  title: '',
  live: false,
  channels: false,
  positionSeconds: 0,
  durationSeconds: 0,
  paused: false,
  buffering: false,
  audio: [],
  subtitles: [],
  osd: null,
  badge: null,
  skip: null
};

/** The channel on screen, as the page knows it, for the banner (PX-TV-6). */
export interface DesktopBanner {
  number: string;
  name: string;
  logo?: string;
  banner: ChannelBanner | null;
  /** When it was asked for: it shows for four seconds from then. */
  at: number;
}

@Injectable({ providedIn: 'root' })
export class DesktopVideoService {
  readonly state = signal<DesktopVideoState>(CLOSED);
  readonly open = computed(() => this.state().open);
  readonly banner = signal<DesktopBanner | null>(null);

  /** Whether this main process draws the picture in the page at all. */
  readonly available = bridge() !== null;

  constructor() {
    bridge()?.onState(state => {
      const language = currentLanguage();
      const label = (track: MpvTrack): DesktopTrack => ({ id: track.id, label: trackLabel(track, language), selected: track.selected });
      this.state.set({ ...CLOSED, ...state, audio: (state.audio ?? []).map(label), subtitles: (state.subtitles ?? []).map(label) });
    });
  }

  send(command: DesktopVideoCommand): void {
    bridge()?.command(command);
  }

  /** The banner, from the channel switching bridge (native/switch-bridge.ts). */
  showBanner(banner: Omit<DesktopBanner, 'at'>): void {
    this.banner.set({ ...banner, at: Date.now() });
  }
}
