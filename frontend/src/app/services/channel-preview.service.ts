import { RecordingsService } from './recordings.service';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { firstValueFrom } from 'rxjs';
import { SETTING_KEYS, Stream } from '@shared/types';
import { SettingsService } from './settings.service';
import { XtreamService } from './xtream.service';

interface ChannelPreviewPlugin {
  show(options: { url: string; x: number; y: number; width: number; height: number; scale: number }): Promise<void>;
  hide(): Promise<void>;
  /** APK 1.0.120 and later. */
  move(options: { x: number; y: number; width: number; height: number; scale: number }): Promise<void>;
  addListener(event: 'previewState', listener: (state: { state: 'playing' | 'failed' | 'stopped' | 'taken' | 'returned'; detail: string }) => void): Promise<PluginListenerHandle>;
}

const ChannelPreview = registerPlugin<ChannelPreviewPlugin>('ChannelPreview');

export type PreviewState = 'idle' | 'waiting' | 'opening' | 'playing' | 'failed';

/** How often the window checks it is still on its box (`following`): a quarter second of lag as the guide moves. */
const FOLLOW_EVERY_MS = 250;

/**
 * A channel playing in a small window over the guide while it is browsed, as
 * TiviMate does.
 *
 * As TiviMate does it (19 October): OK on a channel plays it
 * here, and it goes on playing while the remote moves about the guide; OK
 * on it again takes the same stream full screen -- the full player takes
 * the preview's player over (`ChannelPreviewPlugin.takeOver`) rather than
 * opening the channel a second time. The provider allows one connection, so
 * a different channel, here or full screen, waits for this one to be let go
 * (`stop`). On a television with an APK that has the native window (1.0.109
 * and later); absent elsewhere, and when switched off on Account.
 */
@Injectable({ providedIn: 'root' })
export class ChannelPreviewService {
  private readonly xtream = inject(XtreamService);
  private readonly recordings = inject(RecordingsService);
  private readonly settings = inject(SettingsService);

  /** Whether this device can show one at all. */
  readonly supported = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ChannelPreview');

  /** On unless switched off on Account (SETTING_KEYS.channelPreview). */
  readonly enabled = computed(() => this.supported && this.settings.get(SETTING_KEYS.channelPreview) !== 'off');

  readonly state = signal<PreviewState>('idle');
  /** The channel being shown or waited for. */
  readonly streamId = signal<string | null>(null);

  /** Each request's number, so one overtaken by the next does nothing. */
  private turn = 0;
  private active = false;
  private stopping: Promise<void> = Promise.resolve();

  /** Counts each stream handed back by the full player, with the channel it ended on. */
  readonly returned = signal<{ streamId: string; count: number } | null>(null);

  /** How many screens are showing the preview's box now (`host`): only the guide, in practice. */
  private hosts = 0;

  constructor() {
    if (this.supported) {
      void ChannelPreview.addListener('previewState', ({ state, detail }) => {
        if (state === 'returned') {
          // Back from full screen: the stream carries on here, on the channel it ended on.
          this.active = true;
          this.streamId.set(detail || this.streamId());
          this.state.set('playing');
          // Unless the guide is no longer what is on screen -- the app
          // restarted behind the player for an update, say. The picture came
          // back over For You, playing, with nothing there to close it (the
          // owner's TV, 22 October). Let it go instead.
          if (this.hosts === 0) {
            void this.stop();
          } else {
            // Kept on the box, which may have moved while full screen was up.
            this.placed = null;
            this.following();
            if (detail) {
              this.returned.set({ streamId: detail, count: (this.returned()?.count ?? 0) + 1 });
            }
          }
        } else if (state === 'playing') {
          this.state.set('playing');
        } else if (state === 'failed') {
          this.state.set('failed');
        } else {
          // Stopped, or taken over by the full player: nothing of this one is left to let go.
          this.active = false;
          this.state.set('idle');
        }
      });
    }
    inject(DestroyRef).onDestroy(() => void this.stop());
    // A page that has just loaded shows no preview, so one still on the
    // screen was left by the page before it: a reload while the full player
    // was in front, which then handed its stream back to nobody.
    if (this.supported) {
      void ChannelPreview.hide().catch(() => undefined);
    }
  }

  /**
   * A screen showing the preview's box, for as long as it does: the guide.
   * The stream the full player hands back is kept only while one is.
   */
  host(): () => void {
    this.hosts++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.hosts--;
      }
    };
  }

  /** Whether this channel is the one in the preview, playing or on its way. */
  showing(streamId: string | number): boolean {
    return this.streamId() === String(streamId) && (this.state() === 'opening' || this.state() === 'playing');
  }

  /**
   * Whether this channel was asked for and not yet handed to the window --
   * its address still being looked up. Full screen cannot take that stream
   * over, because there is none yet: OK twice in quick succession opened the
   * channel full screen and then the preview's own copy behind it, which
   * took the sound and paused the full player (a user's TV, 24 October).
   * The guide lets this one go and plays full screen from scratch instead.
   */
  pending(streamId: string | number): boolean {
    return this.streamId() === String(streamId) && this.state() === 'opening' && !this.handed;
  }

  /**
   * Plays this channel in the box `area` gives -- the first OK on it. What
   * was playing before is let go first.
   */
  async start(stream: Stream, area: () => DOMRect | null): Promise<void> {
    if (!this.enabled() || this.showing(stream.stream_id)) {
      return;
    }
    // A preview is a stream like any other: not while a recording holds the connection.
    if (!this.recordings.mayOpen(String(stream.stream_id))) {
      return;
    }
    const turn = ++this.turn;
    this.streamId.set(String(stream.stream_id));
    this.state.set('opening');
    this.handed = false;
    this.area = area;
    await this.release();
    await this.open(turn, stream, area);
  }

  /** Nothing previewing, and the connection let go: before anything else plays. */
  async stop(): Promise<void> {
    ++this.turn;
    this.streamId.set(null);
    this.state.set('idle');
    this.handed = false;
    this.following();
    await this.release();
  }

  /** Whether the current request has reached the window (`pending`). */
  private handed = false;

  /** Where the box is, as the screen showing it says. */
  private area: (() => DOMRect | null) | null = null;
  private placed: DOMRect | null = null;
  private follow: ReturnType<typeof setInterval> | null = null;

  /**
   * Keeps the window on its box while it plays, or stops following. The box
   * moves when the guide makes room for the category list, and the window,
   * placed once, stayed where the box had been, over the menu (a user's
   * TV, 24 October). A box that has gone lets the preview go; an APK
   * without `move` (before 1.0.120) does the same rather than leave it there.
   */
  private following(): void {
    const wanted = this.active && this.area !== null;
    if (!wanted && this.follow !== null) {
      clearInterval(this.follow);
      this.follow = null;
      window.removeEventListener('keydown', this.afterKey, true);
    } else if (wanted && this.follow === null) {
      this.follow = setInterval(() => void this.keepOnBox(), FOLLOW_EVERY_MS);
      window.addEventListener('keydown', this.afterKey, true);
    }
  }

  /**
   * A key moves the box, if it moves at all: going to the categories makes
   * room for them. Looked at on the frame after and once more a little later,
   * for a page that draws it late, so the window keeps up with the box
   * instead of trailing it by up to FOLLOW_EVERY_MS (the owner's TV,
   * 10 November). The interval stays, for anything else that moves it.
   */
  private readonly afterKey = (): void => {
    requestAnimationFrame(() => requestAnimationFrame(() => void this.keepOnBox()));
    setTimeout(() => void this.keepOnBox(), 120);
  };

  private async keepOnBox(): Promise<void> {
    const box = this.area?.();
    if (!this.active) {
      this.following();
      return;
    }
    if (!box || box.width < 40) {
      void this.stop();
      return;
    }
    const was = this.placed;
    if (was && Math.abs(was.left - box.left) < 1 && Math.abs(was.top - box.top) < 1 && Math.abs(was.width - box.width) < 1 && Math.abs(was.height - box.height) < 1) {
      return;
    }
    this.placed = box;
    try {
      await ChannelPreview.move({ x: box.left, y: box.top, width: box.width, height: box.height, scale: window.devicePixelRatio || 1 });
    } catch {
      void this.stop();
    }
  }

  private async open(turn: number, stream: Stream, area: () => DOMRect | null): Promise<void> {
    const box = area();
    if (turn !== this.turn || !box || box.width < 40) {
      return;
    }
    let url: string;
    try {
      url = await firstValueFrom(this.xtream.getPlaybackUrl('live', String(stream.stream_id)));
    } catch {
      if (turn === this.turn) {
        this.state.set('failed');
      }
      return;
    }
    if (turn !== this.turn) {
      return;
    }
    this.active = true;
    this.handed = true;
    this.placed = box;
    this.following();
    try {
      await ChannelPreview.show({ url, x: box.left, y: box.top, width: box.width, height: box.height, scale: window.devicePixelRatio || 1 });
    } catch {
      this.active = false;
      if (turn === this.turn) {
        this.state.set('failed');
      }
    }
  }

  private release(): Promise<void> {
    if (!this.active) {
      return this.stopping;
    }
    this.active = false;
    this.stopping = ChannelPreview.hide().catch(() => undefined);
    return this.stopping;
  }

}
