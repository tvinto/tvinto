import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { StreamType } from '@shared/types';
import { librariesFirst } from '../utils/library-refresh.utils';
import { GuideService } from './guide.service';
import { GuideSourcesService } from './guide-sources.service';
import { ProviderAccessService } from './provider-access.service';
import { XtreamService } from './xtream.service';

export type LoadPart = StreamType | 'guide';
export type PartState = 'waiting' | 'loading' | 'done' | 'failed';

export interface PartView {
  part: LoadPart;
  state: PartState;
  /** Titles (or a guide's programmes) so far, or in all once done; null when not known. */
  count: number | null;
  /** How many titles there are to write, once the listing has been read; null before. */
  of: number | null;
  /** Bytes of the listing downloaded, before any title is counted; null otherwise. */
  bytes: number | null;
}

/** Set from the start of a first load until channels, films and shows are in, across launches. */
const PENDING_KEY = 'tvinto_first_load_pending';
const LIBRARIES: readonly StreamType[] = ['live', 'vod', 'series'];
/** A library that did not arrive is tried again this often, this many times a launch. */
export const RETRY_MS = 30_000;
export const TRIES = 3;

/**
 * Everything a new device needs, loaded while its setup runs (card 42): the
 * channels, films and shows through the library downloads every page uses
 * (XtreamService, one at a time), then the guide, which waits for them
 * (`librariesFirst`) so the provider's one connection is used in turn.
 *
 * Pending is kept in localStorage until the three libraries are in, so a
 * first load cut short -- the app closed, the TV asleep, the network gone --
 * resumes on the waiting screen at the next start rather than in a
 * half-empty app.
 */
@Injectable({ providedIn: 'root' })
export class FirstLoadService {
  private readonly xtream = inject(XtreamService);
  private readonly guide = inject(GuideService);
  private readonly sources = inject(GuideSourcesService);
  private readonly provider = inject(ProviderAccessService);

  private readonly states = signal<Record<StreamType, PartState>>({ live: 'waiting', vod: 'waiting', series: 'waiting' });
  private readonly running = signal(false);

  /** Begun in this launch: what the strip and the waiting screen show. */
  readonly started = signal(false);

  /** Waiting to try a library again after it did not arrive. */
  readonly retrying = signal(false);

  /** Channels, films and shows each arrived or given up on for this launch. */
  readonly librariesIn = computed(() => LIBRARIES.every(type => this.settled(this.states()[type])));

  /**
   * Everything in, the guide too: what the last screen waits for. The owner
   * on 26 November, after entering with two guides still downloading: "It
   * should wait for the guide."
   */
  readonly allIn = computed(() => this.librariesIn() && this.parts().every(part => part.part !== 'guide' || part.state === 'done'));

  readonly failed = computed(() => LIBRARIES.some(type => this.states()[type] === 'failed'));

  /** Rough seconds left of the library downloading now, once it can be told; null before. */
  readonly secondsLeft = signal<number | null>(null);

  readonly parts = computed<PartView[]>(() => {
    const states = this.states();
    const indexing = this.xtream.indexing();
    const progress = this.xtream.indexProgress();
    const titles = this.xtream.libraryTitles();
    const parts: PartView[] = LIBRARIES.map(type => {
      const state = states[type];
      if (state === 'loading' && indexing === type) {
        // Downloaded bytes, then titles read, then titles written of them.
        const written = progress?.titles || null;
        return {
          part: type,
          state,
          count: written ?? progress?.read ?? null,
          of: written ? (progress?.read ?? null) : null,
          bytes: written || progress?.read ? null : (progress?.bytes ?? null)
        };
      }
      return { part: type, state, count: state === 'done' ? (titles[type] ?? null) : null, of: null, bytes: null };
    });
    const loading = this.guide.loading();
    if (loading) {
      parts.push({ part: 'guide', state: 'loading', count: loading.programmes || null, of: null, bytes: null });
    } else if (this.guide.queued().length || (this.running() && this.sources.sources().length)) {
      parts.push({ part: 'guide', state: 'waiting', count: null, of: null, bytes: null });
    } else if (this.sources.sources().length) {
      parts.push({ part: 'guide', state: 'done', count: null, of: null, bytes: null });
    }
    return parts;
  });

  constructor() {
    // Time left from how fast titles are written of those read, or else
    // categories of those known, once some are; begun again for each library.
    let first: { type: StreamType; done: number; at: number } | null = null;
    effect(() => {
      const type = this.xtream.indexing();
      const progress = this.xtream.indexProgress();
      const [done, all] = progress?.read && progress.titles ? [progress.titles, progress.read] : [progress?.filed ?? 0, progress?.total ?? 0];
      if (!type || !all || !done) {
        if (!type) {
          first = null;
          this.secondsLeft.set(null);
        }
        return;
      }
      const now = performance.now();
      if (first?.type !== type) {
        first = { type, done, at: now };
        return;
      }
      const since = done - first.done;
      this.secondsLeft.set(since > 0 ? Math.max(0, Math.round((((now - first.at) / since) * (all - done)) / 1000)) : null);
    });
  }

  /** A first load started on this device and not yet finished, in this launch or an earlier one. */
  pending(): boolean {
    try {
      return localStorage.getItem(PENDING_KEY) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Brings in whatever of the three libraries this device does not hold yet,
   * and lets the guide go after. Once a launch at a time; a library held
   * already counts as in at once, so a small or held library passes through.
   */
  async start(): Promise<void> {
    this.started.set(true);
    if (!this.provider.supported) {
      // A browser: nothing is downloaded here to wait for.
      this.states.set({ live: 'done', vod: 'done', series: 'done' });
      return;
    }
    if (this.running()) {
      return;
    }
    this.running.set(true);
    this.setPending(true);
    this.holdGuides();
    try {
      for (const type of LIBRARIES) {
        await this.loadOne(type);
      }
    } finally {
      this.releaseGuides();
      this.running.set(false);
    }
    if (!this.failed()) {
      this.setPending(false);
    }
  }

  /**
   * Guides wait from now until the libraries are in. Before a provider is
   * added, whose own guide starts downloading as it is (GuideSourcesService.
   * addGuidesOf), and before an account's guides arrive with it.
   */
  holdGuides(): void {
    if (!librariesFirst.done) {
      librariesFirst.done = new Promise<void>(resolve => (this.release = resolve));
    }
  }

  /** Guides go again: the libraries are in, or the provider was not added after all. */
  releaseGuides(): void {
    librariesFirst.done = undefined;
    this.release?.();
    this.release = undefined;
  }

  private release?: () => void;

  private async loadOne(type: StreamType): Promise<void> {
    if (this.states()[type] === 'done') {
      return;
    }
    this.setState(type, 'loading');
    for (let tried = 1; ; tried++) {
      if ((await this.xtream.libraryHeld(type).catch(() => false)) || (await this.xtream.fetchLibraryIfNeverHeld(type).catch(() => false))) {
        this.setState(type, 'done');
        return;
      }
      if (tried >= TRIES) {
        // Quietly: the waiting screen says so, and the next start tries again.
        console.warn(`The ${type} library did not arrive on a first load`);
        this.setState(type, 'failed');
        return;
      }
      this.retrying.set(true);
      await new Promise(resolve => setTimeout(resolve, RETRY_MS));
      this.retrying.set(false);
    }
  }

  private setState(type: StreamType, state: PartState): void {
    this.states.update(states => ({ ...states, [type]: state }));
  }

  private settled(state: PartState): boolean {
    return state === 'done' || state === 'failed';
  }

  private setPending(on: boolean): void {
    try {
      if (on) {
        localStorage.setItem(PENDING_KEY, '1');
      } else {
        localStorage.removeItem(PENDING_KEY);
      }
    } catch {
      // Not resumed after a restart, which is all it costs.
    }
  }
}
