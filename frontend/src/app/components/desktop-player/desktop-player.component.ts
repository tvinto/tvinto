import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideCaptions,
  lucideChevronDown,
  lucideMaximize,
  lucideMinimize,
  lucidePause,
  lucidePlay,
  lucideRotateCcw,
  lucideRotateCw,
  lucideSearch,
  lucideSkipBack,
  lucideVolume1,
  lucideVolume2,
  lucideVolumeX,
  lucideX
} from '@ng-icons/lucide';
import { DesktopTrack, DesktopVideoService, PlayingTarget, foldUnlabelled } from '../../services/desktop-video.service';
import { NativePlayerService } from '../../services/native-player.service';
import { SubtitlePickerComponent } from '../subtitle-picker/subtitle-picker.component';
import { SavedSubtitle } from '@shared/subtitles';
import { channelDisplay } from '../../utils/channel-display.utils';
import { formatTimecode } from '../../utils/progress.utils';
import { t } from '../../utils/i18n';
import { TPipe } from '../../pipes/t.pipe';

/** How long the controls stay up with the pointer still, as other players do. */
const CONTROLS_MS = 3000;
/** How long the channel banner stays (PX-TV-6). */
const BANNER_MS = 4000;
/** How long a click on the picture waits to be sure it is not the first of a double-click. */
const CLICK_MS = 220;
/** One press of Up or Down. */
const VOLUME_STEP = 5;

/**
 * The desktop player, in the page: the picture tvinto-player draws (a canvas
 * the preload paints, electron/src/preload.ts) under the app's own controls.
 *
 * A desktop player's controls, as other players have them (14 November): one
 * row of icons along the bottom, each with a tooltip naming its key, the back
 * arrow beside the title, and all of it hiding with the pointer after three
 * seconds still. It was first laid out from the television boards (PX-TV-1,
 * -5, -6) in big words, which suit a remote; the Android TV player keeps
 * those. Here only the live channel's banner (PX-TV-6), the live pause badge
 * and the audio and subtitles panel (PX-TV-5) still follow the boards, in
 * their 1920-wide design pixels scaled to the window (`--u`).
 *
 * Every key mpv answered to before answers here, and becomes the same thing
 * for mpv: a press of the key it is bound to (input.conf, so live pause,
 * channel switching and Skip intro decide as before), or a seek for a film.
 */
@Component({
  selector: 'app-desktop-player',
  standalone: true,
  imports: [TPipe, NgIcon, SubtitlePickerComponent],
  providers: [
    provideIcons({
      lucideArrowLeft,
      lucideCaptions,
      lucideChevronDown,
      lucideMaximize,
      lucideMinimize,
      lucidePause,
      lucidePlay,
      lucideRotateCcw,
      lucideRotateCw,
      lucideSearch,
      lucideSkipBack,
      lucideVolume1,
      lucideVolume2,
      lucideVolumeX,
      lucideX
    })
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:mousemove)': 'onMouseMove($event)'
  },
  template: `
    @if (video.open()) {
      <div
        class="player desk"
        [class.idle]="!controlsUp() && !panel()"
        (click)="onPictureClick($event)"
        (dblclick)="onPictureDoubleClick($event)"
      >
        <canvas data-tvinto-video class="picture"></canvas>

        @if (controlsUp() || panel()) {
          <div class="fade top"></div>
          <div class="fade bottom"></div>
          <div class="head" (click)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()" (mouseenter)="hover(true)" (mouseleave)="hover(false)">
            <button type="button" class="icon tip-start" [attr.aria-label]="'desktopPlayer.back' | t" [attr.data-tip]="tip('desktopPlayer.back', 'Esc')" (click)="press('ESC')">
              <ng-icon name="lucideArrowLeft" />
            </button>
            <div class="words">
              @if (heading()) {
                <span class="show">{{ heading() }}</span>
              }
              <span class="name">{{ title() }}</span>
              @if (subtitleLine()) {
                <span class="meta">{{ subtitleLine() }}</span>
              }
            </div>
          </div>
        }

        @if (state().badge; as badge) {
          <div class="badge">
            <span class="line">{{ badge.line }}</span>
            <span class="hint">{{ badge.hint }}</span>
          </div>
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
          <div class="dock" (click)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()" (mouseenter)="hover(true)" (mouseleave)="hover(false)">
            @if (!state().live && state().durationSeconds > 0) {
              <div class="scrub">
                <span class="time">{{ elapsed() }}</span>
                <div class="track" #track (click)="seekTo($event)">
                  <div class="fill" [style.width.%]="share()"></div>
                  <div class="knob" [style.left.%]="share()"></div>
                </div>
                <span class="time">−{{ left() }}</span>
              </div>
            }
            <div class="icons">
              <button
                type="button"
                class="icon main tip-start"
                [attr.aria-label]="(state().paused ? 'desktopPlayer.play' : 'desktopPlayer.pause') | t"
                [attr.data-tip]="tip(state().paused ? 'desktopPlayer.play' : 'desktopPlayer.pause', 'Space')"
                (click)="togglePause()"
              >
                <ng-icon [name]="state().paused ? 'lucidePlay' : 'lucidePause'" />
              </button>
              @if (state().live) {
                @if (state().badge) {
                  <button type="button" class="word" [attr.data-tip]="tip('desktopPlayer.backToLive', 'End')" (click)="press('END')">
                    {{ 'desktopPlayer.backToLive' | t }}
                  </button>
                }
              } @else {
                <button type="button" class="icon" [attr.aria-label]="'desktopPlayer.back10' | t" [attr.data-tip]="tip('desktopPlayer.back10', '←')" (click)="seek(-10)">
                  <ng-icon name="lucideRotateCcw" /><span class="ten">10</span>
                </button>
                <button type="button" class="icon" [attr.aria-label]="'desktopPlayer.forward10' | t" [attr.data-tip]="tip('desktopPlayer.forward10', '→')" (click)="seek(10)">
                  <ng-icon name="lucideRotateCw" /><span class="ten">10</span>
                </button>
              }
              <div class="volume">
                <button
                  type="button"
                  class="icon"
                  [attr.aria-label]="(muted() ? 'desktopPlayer.unmute' : 'desktopPlayer.mute') | t"
                  [attr.data-tip]="tip(muted() ? 'desktopPlayer.unmute' : 'desktopPlayer.mute', 'M')"
                  (click)="toggleMute()"
                >
                  <ng-icon [name]="volumeIcon()" />
                </button>
                <input
                  type="range"
                  class="level"
                  min="0"
                  max="100"
                  step="1"
                  [attr.aria-label]="'desktopPlayer.volume' | t"
                  [attr.data-tip]="tip('desktopPlayer.volume', '↑ ↓')"
                  [value]="shownVolume()"
                  [style.--level.%]="shownVolume()"
                  (input)="setVolume($event)"
                />
              </div>
              @if (!state().live && state().durationSeconds > 0) {
                <span class="ends">{{ 'desktopPlayer.ends' | t: { time: endsAt() } }}</span>
              }
              <span class="spacer"></span>
              @if (!state().live) {
                <button type="button" class="icon small" [attr.aria-label]="'desktopPlayer.startOver' | t" [attr.data-tip]="tip('desktopPlayer.startOver', '')" (click)="startOver()">
                  <ng-icon name="lucideSkipBack" />
                </button>
              }
              @if (hasTracks()) {
                <button type="button" class="icon" [attr.aria-label]="'desktopPlayer.audioSubtitles' | t" [attr.data-tip]="tip('desktopPlayer.audioSubtitles', '')" (click)="openPanel()">
                  <ng-icon name="lucideCaptions" />
                </button>
              }
              <button
                type="button"
                class="icon tip-end"
                [attr.aria-label]="(fullscreen() ? 'desktopPlayer.exitFullScreen' : 'desktopPlayer.fullScreen') | t"
                [attr.data-tip]="tip(fullscreen() ? 'desktopPlayer.exitFullScreen' : 'desktopPlayer.fullScreen', 'F')"
                (click)="toggleFullscreen()"
              >
                <ng-icon [name]="fullscreen() ? 'lucideMinimize' : 'lucideMaximize'" />
              </button>
            </div>
          </div>
        }

        @if (panel()) {
          <div class="tracks" (click)="closePanel($event)" (dblclick)="$event.stopPropagation()">
            <button type="button" class="panel-close" [attr.aria-label]="'desktopPlayer.close' | t" (click)="panel.set(false); $event.stopPropagation()">
              <ng-icon name="lucideX" />
            </button>
            <div class="column" (click)="$event.stopPropagation()">
              <h3>{{ 'desktopPlayer.audio' | t }}</h3>
              <div class="list" (scroll)="edges($event.target)">
                @for (track of audioRows().shown; track track.id) {
                  <button type="button" class="choice" [class.on]="track.selected" [attr.data-track]="track.id" (click)="chooseAudio(track)">
                    <span class="tick">{{ track.selected ? '✓' : '' }}</span>{{ track.label }}
                  </button>
                }
                @if (audioRows().hidden) {
                  <button type="button" class="choice more" (click)="unfold('audio')">
                    <span class="tick"><ng-icon name="lucideChevronDown" /></span>{{ 'desktopPlayer.unlabelled' | t: { count: audioRows().hidden } }}
                  </button>
                }
              </div>
            </div>
            <div class="column" (click)="$event.stopPropagation()">
              <h3>{{ 'desktopPlayer.subtitles' | t }}</h3>
              <div class="list" (scroll)="edges($event.target)">
                @if (video.playing()) {
                  <button type="button" class="choice find" (click)="findSubtitles()">
                    <span class="tick"><ng-icon name="lucideSearch" /></span>{{ 'desktopPlayer.findSubtitles' | t }}
                  </button>
                }
                <button type="button" class="choice" [class.on]="!anySubtitle()" (click)="chooseSubtitle(null)">
                  <span class="tick">{{ anySubtitle() ? '' : '✓' }}</span>{{ 'desktopPlayer.off' | t }}
                </button>
                @for (track of subtitleRows().shown; track track.id) {
                  <button type="button" class="choice" [class.on]="track.selected" [attr.data-track]="track.id" (click)="chooseSubtitle(track)">
                    <span class="tick">{{ track.selected ? '✓' : '' }}</span>{{ track.label }}
                  </button>
                }
                @if (subtitleRows().hidden) {
                  <button type="button" class="choice more" (click)="unfold('subtitles')">
                    <span class="tick"><ng-icon name="lucideChevronDown" /></span>{{ 'desktopPlayer.unlabelled' | t: { count: subtitleRows().hidden } }}
                  </button>
                }
              </div>
            </div>
          </div>
        }

        @if (finding(); as target) {
          <!-- Over the film, which plays on: what is chosen shows at once. -->
          <div class="finding" (click)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
            <app-subtitle-picker [item]="target.item" [name]="target.name" [playing]="true" (added)="showAdded($event)" (closed)="closeFinding()" />
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
      .player.idle,
      .player.idle * {
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
      .next {
        font-size: max(13px, calc(26 * var(--u)));
        color: oklch(0.72 0.02 260);
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
      .spacer {
        flex: 1;
      }
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
      .choice:hover {
        background: oklch(1 0 0 / 0.14);
      }
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
        align-items: flex-start;
        gap: calc(160 * var(--u));
        padding: calc(200 * var(--u)) max(16px, calc(96 * var(--u))) calc(96 * var(--u));
        background: oklch(0.08 0.01 260 / 0.78);
      }
      .tracks .column {
        display: flex;
        flex-direction: column;
        min-width: min(calc(420 * var(--u)), 40vw);
        max-height: 100%;
      }
      .tracks .list {
        display: flex;
        flex-direction: column;
        gap: calc(6 * var(--u));
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        scrollbar-color: oklch(1 0 0 / 0.3) transparent;
        /* Room for the focus fill, which the scroll box would otherwise clip. */
        padding: 2px 8px 2px 2px;
      }
      /* A fade where the list goes on, so a cut-off row reads as "more". */
      .tracks .list[data-more-below] {
        mask-image: linear-gradient(180deg, #000 calc(100% - 64px), transparent);
      }
      .tracks .list[data-more-above] {
        mask-image: linear-gradient(0deg, #000 calc(100% - 64px), transparent);
      }
      .tracks .list[data-more-above][data-more-below] {
        mask-image: linear-gradient(180deg, transparent, #000 64px, #000 calc(100% - 64px), transparent);
      }
      .tracks h3 {
        margin: 0 0 calc(18 * var(--u));
        font-size: max(14px, calc(30 * var(--u)));
        color: oklch(0.72 0.02 260);
        font-weight: 600;
      }
      .choice {
        flex: none;
        text-align: left;
        font-weight: 500;
      }
      .choice.on {
        font-weight: 700;
      }
      .choice.more,
      .choice.find {
        color: oklch(0.8 0.02 260);
      }
      .choice.more:focus-visible,
      .choice.find:focus-visible {
        color: oklch(0.16 0.03 260);
      }
      .tick ng-icon {
        vertical-align: -0.12em;
      }
      /* The picker's own overlay is fixed to the window; this lifts it over the controls. */
      .finding {
        position: absolute;
        inset: 0;
        z-index: 10;
        letter-spacing: normal;
      }
      .tick {
        display: inline-block;
        width: max(22px, calc(44 * var(--u)));
      }
      .panel-close {
        position: absolute;
        top: max(16px, calc(56 * var(--u)));
        right: max(16px, calc(64 * var(--u)));
        display: grid;
        place-items: center;
        width: max(40px, calc(76 * var(--u)));
        height: max(40px, calc(76 * var(--u)));
        border: 0;
        border-radius: 50%;
        background: oklch(1 0 0 / 0.14);
        color: oklch(0.98 0 0);
        font-size: max(20px, calc(36 * var(--u)));
        cursor: pointer;
      }
      .panel-close:hover {
        background: oklch(1 0 0 / 0.24);
      }
      .panel-close:focus-visible {
        outline: none;
        background: oklch(0.98 0 0);
        color: oklch(0.16 0.03 260);
      }

      .desk {
        --edge: clamp(16px, 2.5vw, 48px);
        --button: clamp(40px, 2.6vw, 52px);
        --glyph: clamp(22px, 1.4vw, 28px);
      }
      .desk .fade.top {
        height: clamp(120px, 22%, 220px);
        background: linear-gradient(180deg, oklch(0.08 0.01 260 / 0.7), oklch(0.08 0.01 260 / 0.25) 55%, transparent);
      }
      .desk .fade.bottom {
        height: clamp(160px, 30%, 300px);
        background: linear-gradient(0deg, oklch(0.08 0.01 260 / 0.88), oklch(0.08 0.01 260 / 0.45) 50%, transparent);
      }
      .head {
        position: absolute;
        top: clamp(12px, 2vh, 28px);
        left: calc(var(--edge) - 8px);
        right: var(--edge);
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }
      .head .words {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        padding-top: calc((var(--button) - 1.6em) / 2);
        font-size: clamp(17px, 1.25vw, 24px);
      }
      .head .name {
        font-weight: 700;
        letter-spacing: -0.01em;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .head .show,
      .head .meta {
        font-size: 0.62em;
        color: oklch(0.86 0.01 260);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .head .show {
        order: -1;
        font-weight: 600;
      }
      .dock {
        position: absolute;
        left: var(--edge);
        right: var(--edge);
        bottom: clamp(8px, 1.6vh, 24px);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .scrub {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 0 8px;
      }
      .scrub .time {
        flex: none;
        min-width: 4.5ch;
        font-size: 13px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: oklch(0.92 0.01 260);
      }
      .scrub .time:last-child {
        text-align: right;
      }
      .scrub .track {
        height: 4px;
        transition: height 120ms ease;
      }
      /* A taller target than it looks: the bar is thin, the pointer need not be. */
      .scrub .track::before {
        content: '';
        position: absolute;
        inset: -10px 0;
      }
      .scrub .track .knob {
        width: 14px;
        height: 14px;
        transform: translate(-50%, -50%) scale(0);
        transition: transform 120ms ease;
      }
      .scrub:hover .track {
        height: 6px;
      }
      .scrub:hover .track .knob {
        transform: translate(-50%, -50%) scale(1);
      }
      .icons {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .icon,
      .word {
        position: relative;
        flex: none;
        display: inline-grid;
        place-items: center;
        height: var(--button);
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: oklch(0.98 0 0);
        font: inherit;
        cursor: pointer;
        transition: background-color 120ms ease, transform 120ms ease;
        filter: drop-shadow(0 1px 2px oklch(0 0 0 / 0.5));
      }
      .icon {
        width: var(--button);
        font-size: var(--glyph);
      }
      .icon ng-icon {
        --ng-icon__size: var(--glyph);
      }
      .icon.main {
        --glyph: clamp(26px, 1.7vw, 32px);
      }
      .icon.small {
        --glyph: clamp(18px, 1.1vw, 22px);
      }
      .icon .ten {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding-top: 1px;
        font-size: calc(var(--glyph) * 0.36);
        font-weight: 800;
        letter-spacing: -0.02em;
        pointer-events: none;
      }
      .word {
        padding: 0 16px;
        font-size: 14px;
        font-weight: 700;
        background: oklch(1 0 0 / 0.14);
        backdrop-filter: blur(12px);
      }
      .icon:hover,
      .word:hover {
        background: oklch(1 0 0 / 0.16);
      }
      .icon:active {
        transform: scale(0.92);
      }
      .icon:focus-visible,
      .word:focus-visible,
      .level:focus-visible {
        outline: 2px solid oklch(0.98 0 0);
        outline-offset: 2px;
      }
      /* The tooltip: what it is and its key, above it. */
      .desk [data-tip]::after {
        content: attr(data-tip);
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%;
        transform: translate(-50%, 4px);
        padding: 6px 10px;
        border-radius: 8px;
        background: oklch(0.2 0.02 260 / 0.88);
        backdrop-filter: blur(12px);
        color: oklch(0.98 0 0);
        font-size: 13px;
        font-weight: 600;
        line-height: 1.2;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity 120ms ease, transform 120ms ease;
        filter: none;
      }
      .desk [data-tip]:hover::after,
      .desk [data-tip]:focus-visible::after {
        opacity: 1;
        transform: translate(-50%, 0);
        transition-delay: 350ms;
      }
      .desk .tip-start::after {
        left: 0;
        transform: translate(0, 4px);
      }
      .desk .tip-start:hover::after,
      .desk .tip-start:focus-visible::after {
        transform: none;
      }
      .desk .tip-end::after {
        left: auto;
        right: 0;
        transform: translate(0, 4px);
      }
      .desk .tip-end:hover::after,
      .desk .tip-end:focus-visible::after {
        transform: none;
      }
      .head [data-tip]::after {
        bottom: auto;
        top: calc(100% + 8px);
      }
      .volume {
        display: flex;
        align-items: center;
      }
      .level {
        position: relative;
        width: 0;
        height: var(--button);
        margin: 0;
        opacity: 0;
        appearance: none;
        background: transparent;
        cursor: pointer;
        transition: width 160ms ease, opacity 160ms ease, margin 160ms ease;
      }
      .volume:hover .level,
      .volume:focus-within .level {
        width: clamp(72px, 6vw, 110px);
        margin: 0 10px 0 2px;
        opacity: 1;
      }
      .level::-webkit-slider-runnable-track {
        height: 4px;
        border-radius: 999px;
        background: linear-gradient(90deg, oklch(0.98 0 0) var(--level), oklch(1 0 0 / 0.3) var(--level));
      }
      .level::-webkit-slider-thumb {
        appearance: none;
        width: 14px;
        height: 14px;
        margin-top: -5px;
        border-radius: 50%;
        background: oklch(0.98 0 0);
      }
      .icons .ends {
        margin-left: 8px;
        font-size: 13px;
        color: oklch(0.86 0.01 260);
        white-space: nowrap;
      }
      .desk .osd {
        left: var(--edge);
        bottom: clamp(120px, 16vh, 200px);
        font-size: clamp(14px, 1.1vw, 20px);
        padding: 12px 18px;
        border-radius: 12px;
      }
      .desk .skip {
        height: 44px;
        padding: 0 20px;
        font-size: 15px;
        right: var(--edge);
        bottom: clamp(120px, 16vh, 200px);
      }
      .desk .badge {
        top: clamp(12px, 2vh, 28px);
        right: var(--edge);
      }
      @media (max-width: 560px) {
        .icons .ends,
        .icon.small {
          display: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .desk *,
        .desk *::after {
          transition: none !important;
        }
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
  /** The subtitle picker, open over the film from "Find subtitles…": what it is about. */
  readonly finding = signal<PlayingTarget | null>(null);
  /** Which lists show every unlabelled track rather than one row for them all. */
  private readonly unfolded = signal<{ audio: boolean; subtitles: boolean }>({ audio: false, subtitles: false });
  private readonly native = inject(NativePlayerService);
  readonly fullscreen = signal(!!document.fullscreenElement);
  /** The pointer is over the controls, which then stay. */
  private readonly hovering = signal(false);
  /** Ticks every second while open, for "ends 22:41" and the banner's four seconds. */
  private readonly now = signal(Date.now());
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private clickTimer: ReturnType<typeof setTimeout> | null = null;
  private pointer: { x: number; y: number } | null = null;
  private readonly ticker = setInterval(() => this.now.set(Date.now()), 1000);

  /**
   * The film or episode as the library names it, the channel without its
   * provider's tags: never "EN - X-Men: First Class 4K (2011) X-Men 05".
   */
  readonly title = computed(() => {
    const presentation = this.video.presentation();
    if (presentation) {
      return presentation.title;
    }
    const raw = this.state().title;
    return channelDisplay(raw).title || raw;
  });
  readonly heading = computed(() => this.video.presentation()?.heading ?? '');
  readonly share = computed(() => {
    const { positionSeconds, durationSeconds } = this.state();
    return durationSeconds > 0 ? Math.min(100, (100 * positionSeconds) / durationSeconds) : 0;
  });
  readonly elapsed = computed(() => formatTimecode(this.state().positionSeconds));
  readonly left = computed(() => formatTimecode(Math.max(0, this.state().durationSeconds - this.state().positionSeconds)));
  readonly endsAt = computed(() =>
    this.clock(this.now() + Math.max(0, this.state().durationSeconds - this.state().positionSeconds) * 1000)
  );
  readonly hasTracks = computed(() => this.state().audio.length > 1 || this.state().subtitles.length > 0);
  readonly audioRows = computed(() => this.rows(this.state().audio, this.unfolded().audio));
  readonly subtitleRows = computed(() => this.rows(this.state().subtitles, this.unfolded().subtitles));
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
  /** What the page last set, at once; mpv's own answer arrives within a second. */
  readonly muted = computed(() => this.video.kept().muted);
  readonly shownVolume = computed(() => (this.muted() ? 0 : this.video.kept().volume));
  readonly volumeIcon = computed(() => {
    const level = this.shownVolume();
    return level === 0 ? 'lucideVolumeX' : level < 50 ? 'lucideVolume1' : 'lucideVolume2';
  });

  private readonly onFullscreen = () => this.fullscreen.set(!!document.fullscreenElement);
  /** On the window, ahead of the page's own listeners (see `onKey`). */
  private readonly keys = (event: KeyboardEvent) => this.onKey(event);

  constructor() {
    document.addEventListener('fullscreenchange', this.onFullscreen);
    window.addEventListener('keydown', this.keys, true);
    // A new player opens with its controls up, which then hide (PX-TV-1).
    // Untracked: `touched` reads the controls' own state, and an effect that
    // depended on it showed the controls again each time they hid.
    effect(() => {
      if (this.video.open()) {
        untracked(() => {
          this.panel.set(false);
          this.finding.set(null);
          this.unfolded.set({ audio: false, subtitles: false });
          this.hovering.set(false);
          this.touched();
        });
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
    window.removeEventListener('keydown', this.keys, true);
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
    }
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
    }
  }

  /** "Full screen (F)": what a control does, and its key. */
  tip(key: string, keyName: string): string {
    return keyName ? `${t(key)} (${keyName})` : t(key);
  }

  /**
   * Only a pointer that moved. Chromium also sends a mousemove when what is
   * under a still pointer changes -- a live channel's controls and banner
   * redrawing -- and those kept the controls up for good.
   */
  onMouseMove(event: MouseEvent): void {
    const at = { x: event.screenX, y: event.screenY };
    if (this.pointer && this.pointer.x === at.x && this.pointer.y === at.y) {
      return;
    }
    this.pointer = at;
    this.touched();
  }

  hover(over: boolean): void {
    this.hovering.set(over);
    if (!over) {
      this.touched();
    }
  }

  /** Shows the controls, and hides them again after a while playing untouched. */
  touched(): void {
    if (!this.video.open()) {
      return;
    }
    this.controlsUp.set(true);
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
    }
    this.hideTimer = setTimeout(
      () => {
        if (!this.state().paused && !this.panel() && !this.finding() && !this.hovering()) {
          this.controlsUp.set(false);
          // A control left focused would show its tooltip over the picture.
          if (this.host.nativeElement.contains(document.activeElement)) {
            (document.activeElement as HTMLElement).blur();
          }
        }
      },
      CONTROLS_MS
    );
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

  setVolume(event: Event): void {
    this.video.setVolume(Number((event.target as HTMLInputElement).value));
    this.touched();
  }

  stepVolume(by: number): void {
    this.video.setVolume((this.muted() ? 0 : this.video.kept().volume) + by);
    this.touched();
  }

  toggleMute(): void {
    if (this.shownVolume() === 0 && !this.muted()) {
      // Muted by sliding to nothing: the button brings some sound back.
      this.video.setVolume(50);
    } else {
      this.video.setMuted(!this.muted());
    }
    this.touched();
  }

  openPanel(): void {
    this.panel.set(true);
    setTimeout(() => {
      const root = this.host.nativeElement;
      root.querySelectorAll<HTMLElement>('.tracks .list').forEach(list => this.edges(list));
      const chosen = root.querySelector<HTMLElement>('.tracks .choice.on');
      chosen?.scrollIntoView({ block: 'nearest' });
    });
  }

  /** A click on the panel's ground, outside its two lists, closes it. */
  closePanel(event: MouseEvent): void {
    event.stopPropagation();
    if (event.target === event.currentTarget) {
      this.panel.set(false);
    }
  }

  /** Marks a list that goes on above or below what shows, for its fade. */
  edges(target: EventTarget | null): void {
    const list = target as HTMLElement | null;
    if (!list) {
      return;
    }
    list.toggleAttribute('data-more-above', list.scrollTop > 2);
    list.toggleAttribute('data-more-below', list.scrollTop + list.clientHeight < list.scrollHeight - 2);
  }

  private rows(tracks: DesktopTrack[], unfolded: boolean): { shown: DesktopTrack[]; hidden: number } {
    return unfolded ? { shown: tracks, hidden: 0 } : foldUnlabelled(tracks);
  }

  /** Opens a folded list where its row was, focus on the first track it held. */
  unfold(list: 'audio' | 'subtitles'): void {
    const before = new Set((list === 'audio' ? this.audioRows() : this.subtitleRows()).shown.map(track => track.id));
    this.unfolded.update(now => ({ ...now, [list]: true }));
    const first = (list === 'audio' ? this.state().audio : this.state().subtitles).find(track => !before.has(track.id));
    setTimeout(() => {
      const root = this.host.nativeElement;
      root.querySelectorAll<HTMLElement>('.tracks .list').forEach(one => this.edges(one));
      const column = root.querySelectorAll<HTMLElement>('.tracks .column')[list === 'audio' ? 0 : 1];
      if (first) {
        column?.querySelector<HTMLElement>(`[data-track="${first.id}"]`)?.focus();
      }
    });
  }

  /** The picker over the film, which goes on playing behind it. */
  findSubtitles(): void {
    const target = this.video.playing();
    if (!target) {
      return;
    }
    this.panel.set(false);
    this.finding.set(target);
  }

  closeFinding(): void {
    this.finding.set(null);
    // Back to the list, where what was just added is the subtitle in use.
    this.openPanel();
  }

  /** A subtitle saved in the picker: handed to the running player, which shows it at once. */
  async showAdded(saved: SavedSubtitle): Promise<void> {
    try {
      const subtitle = await this.native.subtitleForPlayer(saved.id);
      if (this.video.open()) {
        this.video.send({ kind: 'addSubtitle', subtitle });
      }
    } catch {
      // Saved on the account all the same: it shows the next time this plays.
    }
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
      return;
    }
    // The picture itself: play and pause, once it is clear this is not the
    // first click of a double-click (full screen).
    if (event.detail <= 1) {
      this.cancelClick();
      this.clickTimer = setTimeout(() => {
        this.clickTimer = null;
        this.togglePause();
      }, CLICK_MS);
    }
    this.touched();
  }

  onPictureDoubleClick(event: MouseEvent): void {
    event.preventDefault();
    this.cancelClick();
    this.toggleFullscreen();
  }

  private cancelClick(): void {
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
  }

  /**
   * The keys mpv answered to, now answered here, and a desktop player's own.
   * On the window, ahead of everything, so the page behind never sees them.
   */
  private onKey(event: KeyboardEvent): void {
    if (!this.video.open() || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (this.finding()) {
      // The picker has the keys -- typing a title, the arrows and OK about its
      // rows -- and stops them going further itself (the template). Escape,
      // and Back outside the search field, close it.
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === 'Escape' || (event.key === 'Backspace' && !typing)) {
        event.stopImmediatePropagation();
        event.preventDefault();
        this.closeFinding();
      }
      return;
    }
    const live = this.state().live;
    // Nothing behind the player hears a key while it is open.
    event.stopImmediatePropagation();
    const handled = (): void => event.preventDefault();
    this.touched();

    if (this.panel()) {
      if (event.key === 'Escape' || event.key === 'Backspace') {
        this.panel.set(false);
        handled();
      }
      // Tab, Enter, Space and the arrows move about the lists as usual.
      return;
    }

    switch (event.key) {
      case ' ':
      case 'MediaPlayPause':
      case 'k':
      case 'K':
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
      case 'ArrowUp':
      case 'ArrowDown':
        this.stepVolume(event.key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP);
        return handled();
      case 'm':
      case 'M':
      case 'AudioVolumeMute':
        this.toggleMute();
        return handled();
      case 'f':
      case 'F':
      case 'F11':
        this.toggleFullscreen();
        return handled();
      default:
        this.common(event, live, handled);
    }
  }

  /** mpv's own bindings, mostly, pressed for it. */
  private common(event: KeyboardEvent, live: boolean, handled: () => void): void {
    switch (event.key) {
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
      case 'Enter':
        // Skip intro, and Try again on a channel that stopped (input.conf);
        // otherwise the focused control's own Enter.
        if (this.state().skip || (this.state().live && this.state().osd)) {
          this.press('ENTER');
          return handled();
        }
        return;
      case 'Tab':
        return;
      default:
        return handled();
    }
  }
}
