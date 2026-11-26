import { Injectable, inject } from '@angular/core';
import { decideGuideReload } from '@shared/xtream/guideReload';
import { GuideService } from './guide.service';
import { isShortGuide, rememberLoadedHere, shortGuides, wasLoadedHere } from './guide-loaded-here';
import { GuideSourcesService } from './guide-sources.service';
import { GuideSource } from '@shared/xtream/guideSources';
import { NativePlayerService } from './native-player.service';
import { isMeteredConnection } from '../utils/connection.utils';
import { librariesFirst, untilIdleWork } from '../utils/library-refresh.utils';

/** Long enough for the first screen and its catalogue requests to finish. */
const FIRST_CHECK_AFTER_MS = 45 * 1000;

/**
 * How often to ask again while the app stays open.
 *
 * A television can run for days without being restarted, and a check that
 * happens only at launch would let its guide run out exactly as before. Asking
 * is free -- a couple of local reads per guide; `decideGuideReload` is what
 * keeps the downloads rare.
 */
const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;

/**
 * The most programmes a guide may hold and still reload while something plays.
 *
 * Standing aside for every guide during playback meant a television that
 * opens straight onto the last channel, and is only ever watched, never
 * reloaded at all (28 October). EPG Share's Croatian guide, the
 * one a user uses, was 27,580 programmes in a 1.9 MB download that day: a
 * few seconds beside a stream. A provider's whole guide -- 200,000 programmes
 * and 68 MB, measured 10 October -- still waits.
 */
export const SMALL_ENOUGH_TO_LOAD_WHILE_PLAYING = 60_000;

/** Per device, and deliberately not synced: this is about this device's copy. */
const attemptKey = (sourceId: string) => `xtream_guide_reload_attempt:${sourceId}`;

/**
 * Keeps the guides on this device from running out.
 *
 * Guides loaded only when somebody pressed Reload, so they expired quietly --
 * see `shared/xtream/guideReload.ts` for what that looked like and for the
 * rules. This is only the part that needs a device: when to ask, what to skip,
 * and not getting in anybody's way.
 *
 * It stands aside for three things. A guide somebody is loading by hand. A
 * video playing, when the guide is a big one, because a download of tens of
 * megabytes competing with a live stream is a stutter the viewer did nothing
 * to deserve (SMALL_ENOUGH_TO_LOAD_WHILE_PLAYING). And a connection the
 * system says is metered or in data-saving mode -- the same reason the first
 * download of a guide is never automatic.
 */
@Injectable({ providedIn: 'root' })
export class GuideReloadService {
  private readonly guide = inject(GuideService);
  private readonly sources = inject(GuideSourcesService);
  private readonly nativePlayer = inject(NativePlayerService);

  private started = false;
  private checking = false;

  /** Begins checking, once per app run. Safe to call more than once. */
  start(): void {
    if (this.started || !this.guide.supported) {
      return;
    }
    this.started = true;

    setTimeout(() => void this.check(), FIRST_CHECK_AFTER_MS);
    setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  /** One pass over this account's guides. Public so it can be asked for directly. */
  async check(): Promise<void> {
    // Not during a first load's libraries: the guide comes after them (card 42).
    if (this.checking || this.guide.isLoading() || isMeteredConnection() || librariesFirst.done || shortGuides.on) {
      return;
    }
    this.checking = true;

    try {
      for (const { source, programmes } of await this.smallestFirst(this.sources.enabled())) {
        // Asked again before every guide: the viewer may have pressed play
        // while the previous one was downloading. Smallest first, so the
        // first guide too big to load beside a stream ends the pass.
        if (this.standingAside(programmes)) {
          return;
        }

        const loadedAt = await this.guide.lastLoadedAt(source.id);

        // A guide the store holds was loaded here, whether or not that was
        // written down at the time: guides loaded before the record existed
        // are marked now, so that losing them later is recognised as a loss.
        if (loadedAt) {
          rememberLoadedHere(source.id);
        }

        // How much of the guide is left is read only when it could decide:
        // it goes through every programme the source holds, which on a
        // television just started held the database for 8 s with the guide
        // screen waiting behind it (23 October). Most checks end sooner, on
        // a guide loaded or tried within the day.
        const state = {
          loadedAt,
          loadedHereBefore: loadedAt !== null || wasLoadedHere(source.id),
          runsOutAt: Infinity,
          lastAttemptAt: this.readAttempt(source.id)
        };
        // Loaded with the next days only during a first load: the rest now,
        // once nobody is using the app -- writing a whole guide took the
        // owner's TV minutes (card 42).
        const short = loadedAt !== null && isShortGuide(source.id);
        let decision = decideGuideReload(state, Date.now());
        if (!short && decision.reason === 'enough-left') {
          decision = decideGuideReload({ ...state, runsOutAt: await this.guide.runsOutAt(source.id) }, Date.now());
        }

        if (!short && !decision.reload) {
          continue;
        }
        if (short) {
          await untilIdleWork();
          if (this.standingAside(programmes) || this.guide.isLoading()) {
            return;
          }
        }

        // Recorded before the download rather than after it. A load that
        // fails, or a device that is switched off half way through, then
        // counts as an attempt -- which is what stops a broken feed becoming
        // a request against the provider every three hours.
        this.writeAttempt(source.id);

        try {
          const report = await this.guide.load(source.id, source.url);
          console.info(
            `Reloaded the guide "${source.label}" (${short ? 'the rest after a first load' : decision.reason}): ` +
              `${report.channels} channels, ${report.programmes} programmes`
          );
        } catch (failure) {
          console.warn(`Could not reload the guide "${source.label}": ${describe(failure)}`);
        }
      }
    } finally {
      this.checking = false;
    }
  }

  /**
   * The guides in the order to reload them: the smallest first, by what each
   * held last time.
   *
   * One guide loads at a time, and they went in the order they are listed, so
   * a big guide listed first held up a small one behind it for as long as it
   * took -- and the small one was the one a user used (28 October). A small
   * guide is done in seconds either way. One whose size is not known goes last,
   * keeping the listed order among those of the same size.
   */
  private async smallestFirst(sources: readonly GuideSource[]): Promise<{ source: GuideSource; programmes: number }[]> {
    const sized = await Promise.all(
      sources.map(async (source, index) => ({
        source,
        index,
        programmes: (await this.guide.summaryFor(source.id).catch(() => null))?.programmes ?? Infinity
      }))
    );
    return sized.sort((a, b) => a.programmes - b.programmes || a.index - b.index);
  }

  /** Whether to leave a guide of this many programmes for later; a size not known counts as big. */
  private standingAside(programmes: number): boolean {
    return (
      this.guide.isLoading() ||
      isMeteredConnection() ||
      (programmes > SMALL_ENOUGH_TO_LOAD_WHILE_PLAYING && this.someoneIsWatching())
    );
  }

  private someoneIsWatching(): boolean {
    if (this.nativePlayer.active()) {
      return true;
    }
    return Array.from(document.querySelectorAll('video')).some(
      video => !video.paused && !video.ended
    );
  }

  private readAttempt(sourceId: string): string | null {
    try {
      return localStorage.getItem(attemptKey(sourceId));
    } catch {
      return null;
    }
  }

  private writeAttempt(sourceId: string): void {
    try {
      localStorage.setItem(attemptKey(sourceId), new Date().toISOString());
    } catch {
      // Storage refused: the check still runs, and the day-long floor is then
      // kept only by the load time. Worse, not dangerous.
    }
  }
}

/**
 * A failure, fit for a log.
 *
 * The provider's guide address is built from the subscription and carries the
 * username and password in its query string, and a fetch error can repeat the
 * address it failed on. Anything that looks like a URL goes.
 */
const describe = (failure: unknown): string =>
  (failure instanceof Error ? failure.message : String(failure)).replace(
    /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
    '[address removed]'
  );
