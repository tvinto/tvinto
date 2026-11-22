import { Injectable, computed, signal } from '@angular/core';
import { ChannelBanner } from '../utils/player-banner.utils';
import { FilmPresentation } from '../utils/film-presentation.utils';
import { currentLanguage, t } from '../utils/i18n';

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
export interface MpvTrack {
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
 * Language codes that name no language a person would choose by: "no
 * linguistic content" (a music-only track), undetermined, several, and
 * uncoded. Intl spells them out ("No linguistic content"), which is noise
 * beside a track's own title, so they read as no language at all.
 */
const NO_LANGUAGE = new Set(['zxx', 'und', 'mul', 'mis']);

/** The language a track is in, in the app's words; '' when it says none. */
function languageName(code: string, language: string): string {
  const lang = code.trim();
  if (!lang || NO_LANGUAGE.has(lang.toLowerCase())) {
    return '';
  }
  try {
    const named = new Intl.DisplayNames([language], { type: 'language' }).of(lang) ?? lang;
    return named.charAt(0).toLocaleUpperCase(language) + named.slice(1);
  } catch {
    return lang;
  }
}

/**
 * A track's name as the viewer reads it: the language in the app's words,
 * then the track's own title when it says more -- "Spanish · Latin American",
 * "Chinese · Simplified". A title that already says the language stands alone.
 * '' when the file says nothing about it at all.
 */
export function trackLabel(track: MpvTrack, language: string): string {
  const named = languageName(track.lang, language);
  const title = track.title.trim();
  if (!title) {
    return named;
  }
  if (!named) {
    return title;
  }
  const lower = title.toLowerCase();
  return lower.includes(named.toLowerCase()) || lower.includes(track.lang.trim().toLowerCase()) ? title : `${named} · ${title}`;
}

/**
 * Every track's label, with the ones that would read the same told apart by
 * number: two Spanish tracks the file says nothing more about are "Spanish"
 * and "Spanish 2". One the file says nothing about is the list's own word
 * and its place in it: "Subtitles 11".
 */
export function trackLabels(tracks: readonly MpvTrack[], language: string, unnamed: string): string[] {
  const labels = tracks.map((track, at) => trackLabel(track, language) || `${unnamed} ${at + 1}`);
  const seen = new Map<string, number>();
  return labels.map(label => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label} ${count}`;
  });
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
  /** mpv's own answer, 0 to 100, and whether it is muted. */
  volume: number;
  muted: boolean;
}

export type DesktopVideoCommand =
  | { kind: 'key'; key: string }
  | { kind: 'seek'; seconds: number; mode: 'relative' | 'absolute' }
  | { kind: 'audio'; id: number }
  | { kind: 'subtitle'; id: number | null }
  | { kind: 'pause'; paused: boolean }
  | { kind: 'volume'; volume: number }
  | { kind: 'mute'; muted: boolean };

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
  skip: null,
  volume: 100,
  muted: false
};

/** Where the volume is kept between films: this device's, not the account's. */
const VOLUME_KEY = 'tvinto.desktopPlayer.volume';

/** The volume the next film opens at. */
export interface DesktopVolume {
  volume: number;
  muted: boolean;
}

function readVolume(): DesktopVolume {
  try {
    const saved = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? 'null') as Partial<DesktopVolume> | null;
    const volume = typeof saved?.volume === 'number' && Number.isFinite(saved.volume) ? Math.max(0, Math.min(100, Math.round(saved.volume))) : 100;
    return { volume, muted: saved?.muted === true };
  } catch {
    return { volume: 100, muted: false };
  }
}

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

  /**
   * The film or episode as the library names it -- "X-Men: First Class", not
   * the provider's "EN - X-Men: First Class 4K (2011) X-Men 05" -- for the
   * title. Null for live, where the channel's own name is cleaned instead.
   */
  readonly presentation = signal<FilmPresentation | null>(null);

  /** What the next film opens at, and what the controls last set. */
  readonly kept = signal<DesktopVolume>(readVolume());

  constructor() {
    bridge()?.onState(state => {
      const language = currentLanguage();
      const labelled = (tracks: MpvTrack[] | undefined, unnamed: string): DesktopTrack[] => {
        const list = tracks ?? [];
        const labels = trackLabels(list, language, unnamed);
        return list.map((track, at) => ({ id: track.id, label: labels[at], selected: track.selected }));
      };
      this.state.set({ ...CLOSED, ...state, audio: labelled(state.audio, t('desktopPlayer.audio')), subtitles: labelled(state.subtitles, t('desktopPlayer.subtitles')) });
    });
  }

  send(command: DesktopVideoCommand): void {
    bridge()?.command(command);
  }

  /** Sets the volume (0 to 100), unmuting, and keeps it for the next film. */
  setVolume(volume: number): void {
    const level = Math.max(0, Math.min(100, Math.round(volume)));
    this.keep({ volume: level, muted: level === 0 ? this.kept().muted : false });
    this.send({ kind: 'volume', volume: level });
    if (level > 0 && this.state().muted) {
      this.send({ kind: 'mute', muted: false });
    }
  }

  setMuted(muted: boolean): void {
    this.keep({ ...this.kept(), muted });
    this.send({ kind: 'mute', muted });
  }

  private keep(volume: DesktopVolume): void {
    this.kept.set(volume);
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify(volume));
    } catch {
      // Private storage refused: the volume still changes, for this film.
    }
  }

  /** The banner, from the channel switching bridge (native/switch-bridge.ts). */
  showBanner(banner: Omit<DesktopBanner, 'at'>): void {
    this.banner.set({ ...banner, at: Date.now() });
  }
}
