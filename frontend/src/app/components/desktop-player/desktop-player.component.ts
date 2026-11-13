import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, signal, viewChild } from '@angular/core';
import { DesktopTrack, DesktopVideoService } from '../../services/desktop-video.service';
import { formatTimecode } from '../../utils/progress.utils';
import { t } from '../../utils/i18n';
import { TPipe } from '../../pipes/t.pipe';

/** How long the controls stay up untouched while playing (PX-TV-1). */
const CONTROLS_MS = 5000;
/** How long the channel banner stays (PX-TV-6). */
const BANNER_MS = 4000;

/**
 * The desktop player, in the page: the picture tvinto-player draws (a canvas
 * the preload paints, electron/src/preload.ts) under the app's own controls.
 *
 * The boards are PX-TV-1 (a film, controls up), PX-TV-5 (audio and
 * subtitles), PX-TV-6 (a live channel's banner) and the live pause badge.
 * Sizes are the boards' 1920-wide design pixels, scaled to the window (`--u`).
 *
 * Every key mpv answered to before answers here, and becomes the same thing
 * for mpv: a press of the key it is bound to (input.conf, so live pause,
 * channel switching and Skip intro decide as before), or a seek for a film.
 */
@Component({
  selector: 'app-desktop-player',
  standalone: true,
  imports: [TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'onKey($event)',
    '(document:mousemove)': 'touched()'
  },
  template: `
    @if (video.open()) {
      <div class="player" [class.idle]="!controlsUp() && !panel()" (click)="onPictureClick($event)" (dblclick)="toggleFullscreen()">
        <canvas data-tvinto-video class="picture"></canvas>

        @if (controlsUp() || panel()) {
          <div class="fade top"></div>
          <div class="fade bottom"></div>
          <div class="title">
            <span class="name">{{ state().title }}</span>
            @if (subtitleLine()) {
              <span class="meta">{{ subtitleLine() }}</span>
            }
          </div>
        }

        @if (state().badge; as badge) {
          <div class="badge">
            <span class="line">{{ badge.line }}</span>
            <span class="hint">{{ badge.hint }}</span>
          </div>
        } @else if (state().paused && !state().live && controlsUp()) {
          <div class="paused-word">{{ 'desktopPlayer.paused' | t }}</div>
        }

        @if (state().osd; as osd) {
          <div class="osd">{{ osd }}</div>
        }

        @if (bannerUp(); as banner) {
          <div class="banner" (click)="$event.stopPropagation()">
            <div class="fade bottom"></div>
            <div class="channel">
              @if (banner.logo) {
                <img [src]="banner.logo" alt="" />
              }
              <span class="number">{{ banner.number }}</span>
              <span>{{ banner.name }}</span>
            </div>
            <div class="now">{{ banner.banner?.now?.title || banner.name }}</div>
            @if (banner.banner?.now; as now) {
              <div class="progress-line">
                <span class="live">{{ 'desktopPlayer.live' | t }}</span>
                <span class="clock">{{ clock(now.startMs) }}</span>
                <div class="track"><div class="fill" [style.width.%]="programmeShare(now.startMs, now.stopMs)"></div></div>
                <span class="clock">{{ clock(now.stopMs) }}</span>
              </div>
            }
            @if (banner.banner?.next; as next) {
              <div class="next"><b>{{ 'desktopPlayer.next' | t }}</b> {{ clock(next.startMs) }} {{ next.title }}</div>
            }
          </div>
        }

        @if (state().skip; as skip) {
          <button type="button" class="skip" (click)="press('ENTER'); $event.stopPropagation()">{{ skip }}</button>
        }

        @if (controlsUp() && !panel() && !bannerUp()) {
          <div class="controls" (click)="$event.stopPropagation()">
            @if (!state().live && state().durationSeconds > 0) {
              <div class="bar">
                <div class="track" #track (click)="seekTo($event)">
                  <div class="fill" [style.width.%]="share()"></div>
                  <div class="knob" [style.left.%]="share()"></div>
                </div>
                <span class="clock">−{{ left() }}</span>
                <span class="ends">{{ 'desktopPlayer.ends' | t: { time: endsAt() } }}</span>
              </div>
            }
            <div class="row">
              <button type="button" class="dp-pill" data-first (click)="togglePause()">
                {{ (state().paused ? 'desktopPlayer.play' : 'desktopPlayer.pause') | t }}
              </button>
              @if (state().live) {
                @if (state().badge) {
                  <button type="button" class="dp-pill" (click)="press('END')">{{ 'desktopPlayer.backToLive' | t }}</button>
                }
              } @else {
                <button type="button" class="dp-pill" (click)="seek(-10)">−10 s</button>
                <button type="button" class="dp-pill" (click)="seek(10)">+10 s</button>
              }
              @if (state().audio.length > 1 || state().subtitles.length) {
                <button type="button" class="dp-pill" (click)="openPanel()">{{ 'desktopPlayer.audioSubtitles' | t }}</button>
              }
              @if (!state().live) {
                <button type="button" class="dp-pill" (click)="startOver()">{{ 'desktopPlayer.startOver' | t }}</button>
              }
              <span class="spacer"></span>
              <button type="button" class="dp-pill" (click)="toggleFullscreen()">
                {{ (fullscreen() ? 'desktopPlayer.exitFullScreen' : 'desktopPlayer.fullScreen') | t }}
              </button>
              <button type="button" class="dp-pill" (click)="press('ESC')">{{ 'desktopPlayer.close' | t }}</button>
            </div>
          </div>
        }

        @if (panel()) {
          <div class="tracks" (click)="$event.stopPropagation()">
            <div class="column">
              <h3>{{ 'desktopPlayer.audio' | t }}</h3>
              @for (track of state().audio; track track.id) {
                <button type="button" class="choice" [class.on]="track.selected" (click)="chooseAudio(track)">
                  <span class="tick">{{ track.selected ? '✓' : '' }}</span>{{ track.label }}
                </button>
              }
            </div>
            <div class="column">
              <h3>{{ 'desktopPlayer.subtitles' | t }}</h3>
              <button type="button" class="choice" [class.on]="!anySubtitle()" (click)="chooseSubtitle(null)">
                <span class="tick">{{ anySubtitle() ? '' : '✓' }}</span>{{ 'desktopPlayer.off' | t }}
              </button>
              @for (track of state().subtitles; track track.id) {
                <button type="button" class="choice" [class.on]="track.selected" (click)="chooseSubtitle(track)">
                  <span class="tick">{{ track.selected ? '✓' : '' }}</span>{{ track.label }}
                </button>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .player {
        --u: calc(100vw / 1920);
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        background: #000;
        color: oklch(0.98 0 0);
        font-family: inherit;
        user-select: none;
      }
      .player.idle {
        cursor: none;
      }
      .picture {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
      }
      .fade {
        position: absolute;
        left: 0;
        right: 0;
        pointer-events: none;
      }
      .fade.top {
        top: 0;
        height: 30%;
        background: linear-gradient(180deg, oklch(0.08 0.01 260 / 0.85), transparent);
      }
      .fade.bottom {
        bottom: 0;
        height: 42%;
        background: linear-gradient(0deg, oklch(0.08 0.01 260 / 0.94), oklch(0.08 0.01 260 / 0.6) 55%, transparent);
      }
      .title {
        position: absolute;
        left: calc(96 * var(--u));
        top: calc(72 * var(--u));
        display: flex;
        flex-direction: column;
        gap: calc(10 * var(--u));
        max-width: calc(1200 * var(--u));
      }
      .title .name {
        font-size: max(20px, calc(56 * var(--u)));
        font-weight: 800;
        letter-spacing: -0.02em;
        line-height: 1.1;
      }
      .title .meta,
      .ends,
      .next {
        font-size: max(13px, calc(26 * var(--u)));
        color: oklch(0.72 0.02 260);
      }
      .paused-word {
        position: absolute;
        right: calc(96 * var(--u));
        top: calc(84 * var(--u));
        font-size: max(12px, calc(24 * var(--u)));
        font-weight: 700;
        letter-spacing: 0.14em;
        color: oklch(0.86 0.01 260);
      }
      .badge {
        position: absolute;
        right: calc(64 * var(--u));
        top: calc(64 * var(--u));
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: calc(4 * var(--u));
        padding: calc(16 * var(--u)) calc(28 * var(--u));
        border-radius: calc(16 * var(--u));
        background: oklch(0.168 0.036 260 / 0.8);
      }
      .badge .line {
        font-size: max(14px, calc(36 * var(--u)));
        font-weight: 700;
      }
      .badge .hint {
        font-size: max(11px, calc(24 * var(--u)));
        color: oklch(0.86 0.01 260);
      }
      .osd {
        position: absolute;
        left: calc(96 * var(--u));
        bottom: calc(260 * var(--u));
        max-width: calc(1400 * var(--u));
        padding: calc(18 * var(--u)) calc(28 * var(--u));
        border-radius: calc(16 * var(--u));
        background: oklch(0.168 0.036 260 / 0.85);
        font-size: max(14px, calc(30 * var(--u)));
        white-space: pre-line;
      }
      .controls {
        position: absolute;
        left: calc(96 * var(--u));
        right: calc(96 * var(--u));
        bottom: calc(72 * var(--u));
        display: flex;
        flex-direction: column;
        gap: calc(34 * var(--u));
      }
      .bar,
      .progress-line {
        display: flex;
        align-items: center;
        gap: calc(28 * var(--u));
      }
      .track {
        flex: 1;
        height: max(4px, calc(8 * var(--u)));
        border-radius: 999px;
        background: oklch(1 0 0 / 0.28);
        position: relative;
        cursor: pointer;
      }
      .track .fill {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        border-radius: 999px;
        background: oklch(0.7 0.16 271.5);
      }
      .track .knob {
        position: absolute;
        top: 50%;
        width: max(12px, calc(24 * var(--u)));
        height: max(12px, calc(24 * var(--u)));
        border-radius: 50%;
        background: oklch(0.98 0 0);
        transform: translate(-50%, -50%);
      }
      .clock {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: max(14px, calc(28 * var(--u)));
        font-weight: 600;
      }
      .row {
        display: flex;
        align-items: center;
        gap: calc(10 * var(--u));
      }
      .spacer {
        flex: 1;
      }
      .dp-pill,
      .skip,
      .choice {
        height: max(36px, calc(76 * var(--u)));
        padding: 0 max(14px, calc(24 * var(--u)));
        border-radius: 999px;
        border: 0;
        background: transparent;
        color: oklch(0.98 0 0);
        font: inherit;
        font-size: max(14px, calc(28 * var(--u)));
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
      }
      .dp-pill:hover,
      .choice:hover {
        background: oklch(1 0 0 / 0.14);
      }
      .dp-pill:focus-visible,
      .skip:focus-visible,
      .choice:focus-visible,
      .skip {
        outline: none;
        background: oklch(0.98 0 0);
        color: oklch(0.16 0.03 260);
      }
      .skip {
        position: absolute;
        right: calc(96 * var(--u));
        bottom: calc(300 * var(--u));
      }
      .banner {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      .banner > :not(.fade) {
        position: absolute;
        left: calc(96 * var(--u));
        right: calc(96 * var(--u));
      }
      .banner .channel {
        bottom: calc(250 * var(--u));
        display: flex;
        align-items: center;
        gap: calc(16 * var(--u));
        font-size: max(13px, calc(28 * var(--u)));
        color: oklch(0.86 0.01 260);
      }
      .banner .channel img {
        height: max(24px, calc(56 * var(--u)));
        border-radius: calc(8 * var(--u));
      }
      .banner .number {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-weight: 700;
      }
      .banner .now {
        bottom: calc(160 * var(--u));
        font-size: max(20px, calc(56 * var(--u)));
        font-weight: 800;
        letter-spacing: -0.02em;
      }
      .banner .progress-line {
        bottom: calc(110 * var(--u));
      }
      .banner .live {
        padding: calc(4 * var(--u)) calc(12 * var(--u));
        border-radius: calc(6 * var(--u));
        background: oklch(0.6 0.22 25);
        font-weight: 800;
        font-size: max(11px, calc(22 * var(--u)));
        letter-spacing: 0.08em;
      }
      .banner .next {
        bottom: calc(60 * var(--u));
      }
      .tracks {
        position: absolute;
        inset: 0;
        display: flex;
        justify-content: center;
        gap: calc(160 * var(--u));
        padding-top: calc(200 * var(--u));
        background: oklch(0.08 0.01 260 / 0.78);
      }
      .tracks .column {
        display: flex;
        flex-direction: column;
        gap: calc(6 * var(--u));
        min-width: calc(420 * var(--u));
      }
      .tracks h3 {
        margin: 0 0 calc(18 * var(--u));
        font-size: max(14px, calc(30 * var(--u)));
        color: oklch(0.72 0.02 260);
        font-weight: 600;
      }
      .choice {
        text-align: left;
        font-weight: 500;
      }
      .choice.on {
        font-weight: 700;
      }
      .tick {
        display: inline-block;
        width: max(22px, calc(44 * var(--u)));
      }
    `
  ]
})
export class DesktopPlayerComponent implements OnDestroy {
  readonly video = inject(DesktopVideoService);
  readonly state = this.video.state;

  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly track = viewChild<ElementRef<HTMLElement>>('track');

  readonly controlsUp = signal(true);
  readonly panel = signal(false);
  readonly fullscreen = signal(!!document.fullscreenElement);
  /** Ticks every second while open, for "ends 22:41" and the banner's four seconds. */
  private readonly now = signal(Date.now());
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ticker = setInterval(() => this.now.set(Date.now()), 1000);

  readonly share = computed(() => {
    const { positionSeconds, durationSeconds } = this.state();
    return durationSeconds > 0 ? Math.min(100, (100 * positionSeconds) / durationSeconds) : 0;
  });
  readonly left = computed(() => formatTimecode(Math.max(0, this.state().durationSeconds - this.state().positionSeconds)));
  readonly endsAt = computed(() =>
    this.clock(this.now() + Math.max(0, this.state().durationSeconds - this.state().positionSeconds) * 1000)
  );
  readonly anySubtitle = computed(() => this.state().subtitles.some(track => track.selected));
  readonly subtitleLine = computed(() => {
    const audio = this.state().audio.find(track => track.selected);
    const subtitle = this.state().subtitles.find(track => track.selected);
    return [
      audio && this.state().audio.length > 1 ? `${t('desktopPlayer.audio')} ${audio.label}` : '',
      subtitle ? `${t('desktopPlayer.subtitles')} ${subtitle.label}` : ''
    ]
      .filter(Boolean)
      .join(' · ');
  });
  readonly bannerUp = computed(() => {
    const banner = this.video.banner();
    return this.state().live && banner && this.now() - banner.at < BANNER_MS ? banner : null;
  });

  private readonly onFullscreen = () => this.fullscreen.set(!!document.fullscreenElement);

  constructor() {
    document.addEventListener('fullscreenchange', this.onFullscreen);
    // A new player opens with its controls up, which then hide (PX-TV-1).
    effect(() => {
      if (this.video.open()) {
        this.panel.set(false);
        this.touched();
      } else if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
      }
    });
    // The banner ticks down even when nothing else changes.
    effect(() => {
      if (this.video.banner()) {
        this.now.set(Date.now());
      }
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.ticker);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
    }
  }

  /** Shows the controls, and hides them again after five seconds playing. */
  touched(): void {
    if (!this.video.open()) {
      return;
    }
    const wasUp = this.controlsUp();
    this.controlsUp.set(true);
    if (!wasUp || !this.host.nativeElement.contains(document.activeElement)) {
      // Focus starts on Play (PX-TV-1), so Enter, Enter is a safe pause and resume.
      setTimeout(() => {
        if (!this.host.nativeElement.contains(document.activeElement)) {
          this.host.nativeElement.querySelector<HTMLElement>('.dp-pill[data-first]')?.focus({ preventScroll: true });
        }
      });
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
    }
    this.hideTimer = setTimeout(() => {
      if (!this.state().paused && !this.panel()) {
        this.controlsUp.set(false);
      }
    }, CONTROLS_MS);
  }

  clock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  programmeShare(start: number, stop: number): number {
    return stop > start ? Math.max(0, Math.min(100, (100 * (this.now() - start)) / (stop - start))) : 0;
  }

  press(key: string): void {
    this.video.send({ kind: 'key', key });
  }

  togglePause(): void {
    // SPACE, as mpv bound it: a live channel's pause hears it (livePause.ts).
    this.press('SPACE');
    this.touched();
  }

  seek(seconds: number): void {
    this.video.send({ kind: 'seek', seconds, mode: 'relative' });
    this.touched();
  }

  startOver(): void {
    this.video.send({ kind: 'seek', seconds: 0, mode: 'absolute' });
    this.touched();
  }

  seekTo(event: MouseEvent): void {
    const bar = this.track()?.nativeElement;
    if (!bar || this.state().durationSeconds <= 0) {
      return;
    }
    const box = bar.getBoundingClientRect();
    const share = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    this.video.send({ kind: 'seek', seconds: share * this.state().durationSeconds, mode: 'absolute' });
    this.touched();
  }

  openPanel(): void {
    this.panel.set(true);
    setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>('.tracks .choice.on')?.focus());
  }

  chooseAudio(track: DesktopTrack): void {
    this.video.send({ kind: 'audio', id: track.id });
  }

  chooseSubtitle(track: DesktopTrack | null): void {
    this.video.send({ kind: 'subtitle', id: track?.id ?? null });
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
  }

  onPictureClick(event: MouseEvent): void {
    if (this.panel()) {
      this.panel.set(false);
    } else if (this.controlsUp() && event.target === event.currentTarget) {
      this.controlsUp.set(false);
    } else {
      this.touched();
    }
  }

  /**
   * The keys mpv answered to, now answered here. Captured while the player is
   * open so the page behind it never sees them.
   */
  onKey(event: KeyboardEvent): void {
    if (!this.video.open()) {
      return;
    }
    const live = this.state().live;
    const handled = (): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    this.touched();

    if (this.panel()) {
      if (event.key === 'Escape' || event.key === 'Backspace') {
        this.panel.set(false);
        handled();
      }
      return;
    }

    switch (event.key) {
      case ' ':
      case 'MediaPlayPause':
      case 'k':
        this.togglePause();
        return handled();
      case 'ArrowLeft':
      case 'ArrowRight': {
        const forward = event.key === 'ArrowRight';
        if (live) {
          this.press(forward ? 'RIGHT' : 'LEFT');
        } else {
          this.seek(forward ? 10 : -10);
        }
        return handled();
      }
      case 'MediaRewind':
      case 'MediaFastForward': {
        const forward = event.key === 'MediaFastForward';
        if (live) {
          this.press(forward ? 'FORWARD' : 'REWIND');
        } else {
          this.seek(forward ? 30 : -30);
        }
        return handled();
      }
      case 'End':
        if (live) {
          this.press('END');
        }
        return handled();
      case 'Escape':
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => undefined);
        } else {
          this.press('ESC');
        }
        return handled();
      case 'Backspace':
        this.press('BS');
        return handled();
      case 'PageUp':
      case 'PageDown':
        this.press(event.key === 'PageUp' ? 'PGUP' : 'PGDWN');
        return handled();
      case 'i':
        this.press('i');
        return handled();
      case 'f':
      case 'F11':
        this.toggleFullscreen();
        return handled();
      case 'Enter':
        // Skip intro, and Try again on a channel that stopped (input.conf);
        // otherwise the focused control's own Enter.
        if (this.state().skip || (live && this.state().osd)) {
          this.press('ENTER');
          return handled();
        }
        return;
      case 'Tab':
      case 'ArrowUp':
      case 'ArrowDown':
        // Moves focus among the controls, which a press has just shown.
        return;
      default:
        return handled();
    }
  }
}
