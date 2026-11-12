import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SETTING_KEYS, Stream, StreamType } from '@shared/types';
import { TmdbKind } from '@shared/tmdb/client';
import { AgeLock, ageLocks, lockRating, loosens, readAgeLock, writeAgeLock } from '@shared/tmdb/age';
import { DescriptionsService } from './descriptions.service';
import { ParentalLockService } from './parental-lock.service';
import { SettingsService } from './settings.service';
import { TmdbService } from './tmdb.service';
import { t } from '../utils/i18n';

/** Where each title's ratings are kept on this device, by "movie:603". */
const RATINGS_KEY = 'xtream_age_ratings';

/** Ratings change rarely; a month before asking again. */
const RATINGS_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

interface KeptRating {
  c: Record<string, string>;
  at: number;
}

/**
 * Films and shows locked by age rating (round 6, TV-31, D-21, P-19).
 *
 * The limit and the country are an account setting beside the locked
 * categories, and like them mean nothing without a PIN. A title is locked
 * when TMDB rates it at or over the limit -- the chosen country's rating,
 * then Germany's, then the United States'. A title TMDB does not rate, or
 * does not know, stays open.
 *
 * It is enforced where films and episodes start playing (`mayPlay`), so a
 * title reached from anywhere -- a card, Search, a favourite, a link -- asks
 * for the PIN; and posters whose rating is already known show it locked.
 * Once the PIN is typed, everything is open until the device locks again,
 * exactly as with a locked category.
 */
@Injectable({ providedIn: 'root' })
export class AgeLockService {
  private readonly settings = inject(SettingsService);
  private readonly parental = inject(ParentalLockService);
  private readonly tmdb = inject(TmdbService);
  private readonly descriptions = inject(DescriptionsService);

  readonly lock = computed<AgeLock>(() => readAgeLock(this.settings.get(SETTING_KEYS.ageLock)));

  /** Whether titles over the limit are being kept closed right now. */
  readonly engaged = computed(() => this.lock().limit > 0 && this.parental.engaged());

  /** Whether this device can rate anything at all: without TMDB the setting is not offered. */
  readonly available = signal(false);

  /** Ratings known on this device, by "movie:603", for posters to show locked. */
  private readonly known = signal<ReadonlyMap<string, Record<string, string>>>(
    new Map(Object.entries(readAll()).map(([key, kept]) => [key, kept.c]))
  );

  private readonly asking = new Map<string, Promise<Record<string, string> | null>>();

  constructor() {
    effect(() => {
      this.tmdb.ownKey();
      untracked(() => void this.tmdb.client().then(client => this.available.set(!!client), () => this.available.set(false)));
    });
  }

  /** "16" when a title is locked right now and its rating is known here; '' otherwise. */
  lockedLabel(kind: TmdbKind, id: number): string {
    if (!this.engaged()) {
      return '';
    }
    const certifications = this.known().get(`${kind}:${id}`);
    return certifications && ageLocks(this.lock(), certifications) ? lockRating(certifications, this.lock().country) : '';
  }

  /** Learns the ratings of titles on screen, so their posters can show locked. Only while the lock is on. */
  async learn(kind: TmdbKind, ids: readonly number[]): Promise<void> {
    if (!this.engaged()) {
      return;
    }
    for (const id of ids) {
      if (!this.known().has(`${kind}:${id}`)) {
        await this.certificationsOf(kind, id);
      }
    }
  }

  /**
   * Whether a film may play: open, or the PIN given for it. `find` names its
   * TMDB id; asked only while the lock is on.
   */
  async mayPlay(kind: TmdbKind, find: () => Promise<number | null>, title: string): Promise<boolean> {
    if (!this.engaged()) {
      return true;
    }
    const id = await find().catch(() => null);
    const certifications = id ? await this.certificationsOf(kind, id) : null;
    if (!certifications || !ageLocks(this.lock(), certifications)) {
      return true;
    }
    return this.parental.unlock(t('lock.age.subject', { rating: lockRating(certifications, this.lock().country), title }));
  }

  /** A film from the provider's library, by stream. */
  mayPlayFilm(streamId: string, name: string, title = name): Promise<boolean> {
    return this.mayPlay('movie', async () => (await this.descriptions.filmTmdbId(streamId, name))?.id ?? null, title);
  }

  /** Each library title's TMDB id, by "vod:2169856", as found from its name; 0 for none. */
  private readonly streamTitles = signal<ReadonlyMap<string, number>>(new Map());

  /** "16" when a library poster's title is locked right now and known to be; '' otherwise. */
  lockedStreamLabel(type: StreamType, streamId: string | number): string {
    if (!this.engaged() || (type !== 'vod' && type !== 'series')) {
      return '';
    }
    const id = this.streamTitles().get(`${type}:${streamId}`);
    return id ? this.lockedLabel(type === 'vod' ? 'movie' : 'tv', id) : '';
  }

  /**
   * Learns which library posters on screen are locked: each title found on
   * TMDB from its name alone -- never a request to the provider, which a
   * screen of posters would turn into a sweep -- and its ratings asked once.
   * Only while the lock is on.
   */
  async learnStreams(type: StreamType, streams: readonly Stream[]): Promise<void> {
    if (!this.engaged() || (type !== 'vod' && type !== 'series')) {
      return;
    }
    const kind: TmdbKind = type === 'vod' ? 'movie' : 'tv';
    for (const stream of streams) {
      const key = `${type}:${stream.stream_id}`;
      if (this.streamTitles().has(key) || !this.engaged()) {
        continue;
      }
      const id =
        (kind === 'movie'
          ? await this.descriptions.filmTmdbIdByName(stream.name)
          : await this.descriptions.showTmdbId(null, stream.name).catch(() => null)) ?? 0;
      this.streamTitles.update(map => new Map(map).set(key, id));
      if (id) {
        await this.learn(kind, [id]);
      }
    }
  }

  /** A show from the provider's library, from what its page already holds. */
  mayPlayShow(seriesInfo: unknown, name: string, title = name): Promise<boolean> {
    return this.mayPlay('tv', () => this.descriptions.showTmdbId(seriesInfo, name), title);
  }

  /**
   * Saves a new limit or country. A first lock asks for a PIN to be chosen;
   * a change that opens anything up asks for the PIN.
   */
  async save(next: AgeLock): Promise<boolean> {
    const now = this.lock();
    if (next.limit > 0 && !this.parental.hasPin()) {
      if (!(await this.parental.choosePin())) {
        return false;
      }
    } else if (loosens(now, next) && !(await this.parental.unlock())) {
      return false;
    }
    this.settings.set(SETTING_KEYS.ageLock, writeAgeLock(next));
    return true;
  }

  private certificationsOf(kind: TmdbKind, id: number): Promise<Record<string, string> | null> {
    const key = `${kind}:${id}`;
    const held = readAll()[key];
    if (held && Date.now() - held.at < RATINGS_KEEP_MS) {
      return Promise.resolve(held.c);
    }
    const already = this.asking.get(key);
    if (already) {
      return already;
    }
    const asked = (async () => {
      const client = await this.tmdb.client();
      const certifications = client ? await client.certifications(kind, id).catch(() => undefined) : undefined;
      if (certifications === undefined) {
        // TMDB not answering: the title is let through, and asked about next time.
        return null;
      }
      keep(key, certifications ?? {});
      this.known.update(map => new Map(map).set(key, certifications ?? {}));
      return certifications ?? {};
    })().finally(() => this.asking.delete(key));
    this.asking.set(key, asked);
    return asked;
  }
}

function readAll(): Record<string, KeptRating> {
  try {
    const held = JSON.parse(localStorage.getItem(RATINGS_KEY) ?? '{}') as unknown;
    return held && typeof held === 'object' ? (held as Record<string, KeptRating>) : {};
  } catch {
    return {};
  }
}

function keep(key: string, certifications: Record<string, string>): void {
  try {
    localStorage.setItem(RATINGS_KEY, JSON.stringify({ ...readAll(), [key]: { c: certifications, at: Date.now() } }));
  } catch {
    // Storage unavailable: asked again next time.
  }
}
