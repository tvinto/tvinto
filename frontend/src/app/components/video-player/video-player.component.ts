import {
  ChangeDetectionStrategy,
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  signal,
  output,
  input,
  viewChild,
  computed
} from '@angular/core';

import type Hls from 'hls.js';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { lucideLoaderCircle, lucideMaximize, lucideMinimize } from '@ng-icons/lucide';
import { formatTimecode } from '../../utils/progress.utils';
import { safeToLog } from '../../utils/stream.utils';
import { reportFailure } from '../../utils/failure-reports';
import { streamContainer, streamKind } from '@shared/failureReports';
import { t } from '../../utils/i18n';
import { TPipe } from '../../pipes/t.pipe';

/** A position report from the player. */
export interface PlaybackProgress {
  positionSeconds: number;
  /** Zero when the runtime is unknown, which is the normal case for live. */
  durationSeconds: number;
}

/**
 * How often a position is reported while playing.
 *
 * `timeupdate` fires several times a second; every one of those becoming a
 * request would be hundreds of writes for a single film.
 */
const REPORT_INTERVAL_SECONDS = 10;

@Component({
    selector: 'app-video-player',
    standalone: true,
    imports: [TPipe, NgIcon, HlmButton],
    providers: [provideIcons({ lucideLoaderCircle, lucideMaximize, lucideMinimize })],
    templateUrl: './video-player.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class VideoPlayerComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly streamUrl = input('');
  readonly streamName = input('');

  /** Where to pick up. Zero starts from the beginning. */
  readonly startPositionSeconds = input(0);

  readonly close = output<void>();

  /** Where playback has got to; fired periodically and when it stops. */
  readonly progress = output<PlaybackProgress>();

  /** Fired once the stream has been watched to its end. */
  readonly finished = output<void>();

  private readonly videoElement = viewChild.required<ElementRef<HTMLVideoElement>>('videoElement');

  private hls: Hls | null = null;
  private destroyed = false;
  private lastReportedAt = 0;
  private detachListeners: Array<() => void> = [];

  errorMessage = signal<string>('');
  isLoading = signal<boolean>(true);

  /** Shown while the player is about to jump into the middle of something. */
  readonly resumedFrom = signal<number>(0);

  /** "1:02:15", for the badge. */
  readonly resumedFromLabel = computed(() => formatTimecode(this.resumedFrom()));

  readonly isFullscreen = signal(false);

  ngOnInit() {
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    document.addEventListener('keydown', this.onEscape, true);
  }

  /**
   * A way out that does not depend on finding a button.
   *
   * Captured, and taken before anything else sees it, so that full screen is
   * left rather than the player being closed or the app being backed out of.
   * Being unable to leave full screen is a worse place to be than any of the
   * things this pre-empts.
   */
  private readonly onEscape = (event: KeyboardEvent) => {
    if (!document.fullscreenElement) {
      return;
    }
    if (event.key !== 'Escape' && event.key !== 'Backspace' && event.key !== 'GoBack') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void document.exitFullscreen().catch(() => undefined);
  };

  /**
   * Goes full screen, and comes back.
   *
   * Asked of the containing element rather than the video, so that the loading
   * spinner and the resume badge drawn over it come along -- requesting it on
   * the video alone hands the screen to the element's own chrome and loses
   * everything this component draws on top.
   */
  toggleFullscreen(): void {
    const video = this.videoElement().nativeElement;
    const target = video?.parentElement ?? video;
    if (!target) {
      return;
    }

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }

    void target.requestFullscreen().catch((error: unknown) => {
      // Some WebViews refuse without a user gesture they recognise. Not worth
      // interrupting playback over; the player still works windowed.
      console.warn('Could not enter full screen', error);
    });
  }

  /**
   * Keeps the label honest when the platform leaves full screen on its own,
   * which the back button on a remote does.
   */
  private readonly onFullscreenChange = () => {
    this.isFullscreen.set(document.fullscreenElement !== null);
  };

  ngAfterViewInit() {
    this.loadVideo();
    this.watchPlayback();
  }

  ngOnDestroy() {
    this.destroyed = true;
    // Closing the window is the most common way to stop watching, so the last
    // position has to be captured here rather than only on the timer.
    this.report();
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    document.removeEventListener('keydown', this.onEscape, true);

    // Leaving the player while it holds the screen would strand the app in a
    // full-screen view of something that no longer exists.
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    this.detachListeners.forEach(detach => detach());
    this.detachListeners = [];
    this.destroyPlayer();
  }

  loadVideo() {
    const video = this.videoElement().nativeElement;
    const isHLS = this.streamUrl().includes('.m3u8');

    if (isHLS) {
      void this.loadHls(video);
    } else {
      // Regular MP4 or other formats
      video.src = this.streamUrl();
      video.addEventListener('loadedmetadata', () => {
        this.isLoading.set(false);
        this.seekToStart(video);
      });
      video.addEventListener('error', err => {
        console.error('Video error:', err);
        this.reportFailure(`MEDIA_ERR_${video.error?.code ?? 0}`);
        this.errorMessage.set(t('player.loadFailed'));
        this.isLoading.set(false);
      });
    }
  }

  /**
   * A stream the page could not play, as an error report: the browser's or
   * hls.js's code, the kind and container from the address's shape, how long
   * it played (shared/failureReports.ts).
   */
  private reportFailure(code: string, http?: number): void {
    const video = this.videoElement().nativeElement;
    reportFailure('stream', code, {
      player: 'web',
      kind: streamKind(null, this.streamUrl()),
      container: streamContainer(this.streamUrl()),
      codec: null,
      http: http ?? null,
      playedSeconds: Math.max(0, Math.round((video.currentTime || 0) - (this.startPositionSeconds() || 0)))
    });
  }

  /**
   * An HLS stream, through hls.js where the browser has no HLS of its own.
   *
   * hls.js is fetched here, on first use, rather than with the app: it was a
   * quarter of the code every launch read, and the television and the phone
   * never use it -- they play through the native player (the performance
   * audit, 13 October).
   */
  private async loadHls(video: HTMLVideoElement): Promise<void> {
    let HlsPlayer: typeof Hls | null = null;
    try {
      HlsPlayer = (await import('hls.js')).default;
    } catch (error) {
      console.error('Could not load hls.js', error);
    }
    if (this.destroyed) {
      return;
    }

    if (HlsPlayer?.isSupported()) {
      this.hls = new HlsPlayer({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90
      });

      this.hls.loadSource(this.streamUrl());
      this.hls.attachMedia(video);

      this.hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
        this.isLoading.set(false);
        this.seekToStart(video);
        video.play().catch((err: unknown) => {
          console.error('Playback error:', err);
          this.errorMessage.set(t('player.startFailed'));
        });
      });

      this.hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
        // Spelled out field by field. A WebView console hands objects across
        // the bridge as "[object Object]", so logging `data` records that a
        // stream failed and nothing whatever about why.
        console.error(
          `HLS error: type=${data.type} details=${data.details} fatal=${data.fatal}` +
            ` status=${data.response?.code ?? 'none'} url=${safeToLog(data.url)}`
        );
        if (data.fatal) {
          this.reportFailure(String(data.details), data.response?.code);
          this.errorMessage.set(t('player.streamError', { type: data.type, details: data.details }));
          this.isLoading.set(false);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = this.streamUrl();
      video.addEventListener('loadedmetadata', () => {
        this.isLoading.set(false);
        this.seekToStart(video);
        video.play().catch((err: unknown) => {
          console.error('Playback error:', err);
          this.errorMessage.set(t('player.startFailed'));
        });
      });
    } else {
      this.errorMessage.set(t('player.noHls'));
      this.isLoading.set(false);
      console.error('HLS not supported in this browser');
    }
  }

  /**
   * Jumps to the saved position.
   *
   * Only once metadata has arrived: before that the element has no duration to
   * seek within and the assignment is silently dropped. A position at or past
   * the end is ignored -- being dropped on the closing frame is worse than
   * starting over.
   */
  private seekToStart(video: HTMLVideoElement): void {
    const target = this.startPositionSeconds();
    if (!target || target <= 0) {
      return;
    }

    const duration = video.duration;
    if (Number.isFinite(duration) && duration > 0 && target >= duration - 5) {
      return;
    }

    try {
      video.currentTime = target;
      this.resumedFrom.set(target);
      this.lastReportedAt = target;
    } catch (error) {
      // Some streams refuse a seek before they are buffered; playing from the
      // start is a worse experience than resuming, not a broken one.
      console.warn('Could not resume at', target, error);
    }
  }

  /**
   * Reports the position periodically and whenever playback stops.
   *
   * Listeners are added here rather than in the template so they can be
   * removed on destroy, and so the same set applies whichever pipeline above
   * ended up loading the stream.
   */
  private watchPlayback(): void {
    const video = this.videoElement().nativeElement;

    const onTimeUpdate = () => {
      if (Math.abs(video.currentTime - this.lastReportedAt) < REPORT_INTERVAL_SECONDS) {
        return;
      }
      this.lastReportedAt = video.currentTime;
      this.report();
    };

    const onPause = () => this.report();

    const onEnded = () => {
      this.report();
      this.finished.emit();
    };

    /**
     * Sound but no picture.
     *
     * A browser with no decoder for the video track does not fail -- it plays
     * the audio and leaves the frame black, which looks exactly like a broken
     * app and is in fact the browser saying it cannot show this. Common with
     * 4K HEVC, which is a large part of this provider's film catalogue and
     * which Chrome will not decode without help from the platform.
     *
     * Checked once playback is genuinely under way, because videoWidth is
     * legitimately zero until the first frame is decoded.
     */
    const onPlaying = () => {
      if (video.videoWidth === 0 && video.videoHeight === 0) {
        this.errorMessage.set(t('player.cannotDecode'));
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('playing', onPlaying);

    this.detachListeners = [
      () => video.removeEventListener('timeupdate', onTimeUpdate),
      () => video.removeEventListener('pause', onPause),
      () => video.removeEventListener('ended', onEnded),
      () => video.removeEventListener('playing', onPlaying)
    ];
  }

  /** Emits the current position, with a runtime only when there is a real one. */
  private report(): void {
    const video = this.videoElement().nativeElement;
    if (!video) {
      return;
    }

    const position = video.currentTime;
    if (!Number.isFinite(position) || position <= 0) {
      return;
    }

    // A live stream reports Infinity, or a duration that is only how much of
    // the sliding window is buffered. Neither is something to resume within.
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;

    this.progress.emit({ positionSeconds: position, durationSeconds: duration });
  }

  destroyPlayer() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }

  onClose() {
    this.destroyPlayer();
    this.close.emit();
  }
}
