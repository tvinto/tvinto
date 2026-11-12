import { DestroyRef, Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Stream } from '@shared/types';
import { Recording, RecordingVolume, RecordingWindow, clashesWith, connectionsKey, mayOpenStream, newRecordingId, readBookings, readRecordings, readVolumes, recordUntil } from '@shared/recording/recording';
import {
  PlannedRecording,
  RECORDING_SETTINGS_KEY,
  RecorderDevice,
  RecordingRule,
  RecordingSettings,
  bookingKey,
  episodesToBook,
  readRules,
  ruleKey,
  ruleOf,
  sameTitle,
  writeRule,
  expiredRecordings,
  readPlanned,
  readRecorders,
  readRecordingSettings,
  reconcile,
  recorderKey,
  recordingWindow,
  writePlanned,
  writeRecorder,
  writeRecordingSettings
} from '@shared/recording/plan';
import { untagged } from '@shared/providers/providerRecord';
import { RecorderPlugin, recorderHere } from './native/recorderPlugin';
import { AccountService } from './account.service';
import { SettingsService } from './settings.service';
import { TvNavigationService } from './tv-navigation.service';
import { XtreamService } from './xtream.service';
import { t } from '../utils/i18n';
import { millisecondsOf } from '../utils/guide.utils';

/** What a playback refused because a recording holds the connection reports (failure-messages.utils.ts). */
export const RECORDING_HOLDS_CONNECTION = 'RECORDING_HOLDS_CONNECTION';

/**
 * A recording asks for the channel as one MPEG-TS stream. Live addresses are
 * .m3u8 by default, and an HLS address answers with a playlist, which a
 * recorder writing what arrives would save as a few lines of text.
 */
const RECORDED_FORMAT = 'ts';

/** This device's name among the account's recorders, made once. */
const DEVICE_KEY = 'tvinto_recorder_key';
/** A recorder says it is still there this often, so the others can offer the ones in use first. */
const ANNOUNCE_EVERY_MS = 24 * 60 * 60 * 1000;
/** The native recorders start a booking a minute before the time they are given (Bookings.BEFORE_MS). */
const NATIVE_LEAD_MS = 60_000;
/** A device that records looks again this often: for new airings of a title, and recordings past keeping. */
const LOOK_AGAIN_MS = 60 * 60 * 1000;

/**
 * Recording live channels (private plan: recording), on Android (its
 * RecordingService) and the desktop (electron/src/recorder.ts). Recordings
 * stay on the device that made them; bookings belong to the account
 * (shared/recording/plan.ts), so a programme booked on the phone is recorded
 * by the television. Each recording device books, natively, what the account
 * has booked for it (`reconcile`).
 *
 * It also answers the question every stream asks before it opens: whether a
 * recording holds the connection the subscription allows (`mayOpen`).
 */
@Injectable({ providedIn: 'root' })
export class RecordingsService {
  // Asked for when a recording starts, not when this is made: the player
  // asks this before every stream, and XtreamService needs the player.
  private readonly injector = inject(Injector);
  private readonly settings = inject(SettingsService);

  readonly recordings = signal<Recording[]>([]);
  readonly running = computed(() => this.recordings().filter(one => one.state === 'recording'));
  /** The drives this device can record to: its own, and a USB drive or memory card when one is in. */
  readonly volumes = signal<RecordingVolume[]>([]);
  /** The account's bookings, for every device, soonest first. */
  readonly planned = computed(() => readPlanned(this.settings.all()));
  /** The devices that record, this one among them if it does. */
  readonly recorders = computed(() => readRecorders(this.settings.all()));
  readonly options = computed(() => readRecordingSettings(this.settings.get(RECORDING_SETTINGS_KEY)));
  /** Titles recorded every time they air, for every device. */
  readonly rules = computed(() => readRules(this.settings.all()));

  /** What this device has booked natively, by id, with the times it was given. */
  private nativeBookings: { id: string; startMs: number; endsAt: number }[] = [];
  private listening = false;
  private reconciling: Promise<void> | null = null;
  private again = false;
  private readonly recorder: RecorderPlugin | null = recorderHere();
  readonly deviceKey = this.recorder ? deviceKey() : '';

  constructor() {
    // A recording may be running from before the app was opened: known at
    // once, so the first stream asked for is not let through over it.
    void this.refresh();
    if (this.available()) {
      // A television left on for days still books the next airings and clears old recordings away.
      const timer = setInterval(() => void this.reconcile(), LOOK_AGAIN_MS);
      inject(DestroyRef).onDestroy(() => clearInterval(timer));
    }
    effect(() => {
      // The account's bookings once they have arrived: before that an empty
      // list would cancel every booking here. Without an account, what this
      // device holds is all there is.
      if (!this.settings.loaded() && this.injector.get(AccountService).account() !== null) {
        return;
      }
      this.planned();
      this.options();
      this.rules();
      untracked(() => {
        this.announce();
        void this.reconcile();
      });
    });
  }

  /** Whether this device records: an Android one, or the desktop app. */
  available(): boolean {
    return this.recorder !== null;
  }

  /** The recorder, where `available()` said there is one. */
  private get rec(): RecorderPlugin {
    if (!this.recorder) {
      throw new Error('This device does not record');
    }
    return this.recorder;
  }

  async refresh(): Promise<Recording[]> {
    if (!this.available()) {
      return [];
    }
    if (!this.listening) {
      this.listening = true;
      void this.rec
        .addListener('changed', () => void this.refresh().then(() => this.reconcile()))
        .catch(() => (this.listening = false));
    }
    const listed = readRecordings((await this.rec.list().catch(() => ({ recordings: [] }))).recordings);
    this.recordings.set(listed);
    this.nativeBookings = readBookings((await this.rec.bookings().catch(() => ({ bookings: [] }))).bookings);
    this.volumes.set(readVolumes((await this.rec.volumes?.().catch(() => null))?.volumes));
    return listed;
  }

  /**
   * Records what is on a channel now, to the end of the programme on air
   * (`onAirStopMs`, from the guide) and the account's minutes after; an hour
   * when the guide does not say.
   */
  async recordNow(channel: Stream, channelName: string, programme: string, onAirStopMs: number | null): Promise<Recording | null> {
    if (!this.available()) {
      return null;
    }
    const xtream = this.injector.get(XtreamService);
    void xtream.learnConnectionsAllowed();
    const url = await firstValueFrom(xtream.getPlaybackUrl('live', String(channel.stream_id), RECORDED_FORMAT));
    const now = Date.now();
    const id = newRecordingId(now);
    const endsAt = recordUntil(onAirStopMs, now, this.options().afterMin * 60_000);
    await this.rec.start({ id, url, title: programme || channelName, channel: channelName, channelId: String(channel.stream_id), endsAt });
    const listed = await this.refresh();
    return listed.find(one => one.id === id) ?? null;
  }

  /**
   * Where to watch a channel that is recording: its recording, served on
   * this device, so the connection the recording holds is not asked for
   * twice. Null when the channel is not recording.
   */
  async watchAddress(channelId: string): Promise<string | null> {
    const recording = this.running().find(one => one.channelId === channelId);
    if (!recording) {
      return null;
    }
    return (await this.rec.watchAddress({ id: recording.id }).catch(() => null))?.url ?? null;
  }

  /** The booking for a programme on a channel, on whichever device, if there is one. */
  bookingFor(channelId: string, startMs: number): PlannedRecording | null {
    return this.planned().find(one => one.channelId === channelId && one.startMs === startMs) ?? null;
  }

  /**
   * The devices a programme can be booked for: this one first when it
   * records, then the others most recently heard from first.
   */
  bookable(): RecorderDevice[] {
    const all = this.recorders();
    const here = this.available() ? (all.find(one => one.key === this.deviceKey) ?? { key: this.deviceKey, name: '', kind: 'desktop' as const, seenAt: Date.now() }) : null;
    return [...(here ? [here] : []), ...all.filter(one => one.key !== this.deviceKey)];
  }

  /** "This device", or the name another recorder gave itself. */
  deviceName(key: string): string {
    return key === this.deviceKey ? t('recordings.thisDevice') : this.recorders().find(one => one.key === key)?.name ?? t('recordings.otherDevice');
  }

  /**
   * Books a programme still to come, for a device (this one by default).
   * Refused, with what it clashes with, when it overlaps recordings and
   * bookings that would need more streams than the subscription allows --
   * on any device, since they share it. Compared by the programmes' own
   * times, so one after another fits (the later one takes the connection
   * over when it starts). A portal's addresses work once, so a portal's
   * channel cannot be booked yet.
   */
  async book(
    channel: Stream,
    channelName: string,
    programme: { title: string; startMs: number; stopMs: number },
    device: string = this.deviceKey
  ): Promise<{ booked: PlannedRecording } | { clash: RecordingWindow[] } | { portal: true } | { nowhere: true }> {
    if (channel.portal_cmd) {
      return { portal: true };
    }
    if (!device) {
      return { nowhere: true };
    }
    await this.refresh();
    const after = this.options().afterMin * 60_000;
    const programmes: RecordingWindow[] = [
      ...this.planned().map(one => ({ title: one.title, startMs: one.startMs, endsAt: one.stopMs })),
      ...this.running().map(one => ({ title: one.title, startMs: one.startedAt, endsAt: one.endsAt - after }))
    ];
    const wanted = { title: programme.title, startMs: programme.startMs, endsAt: programme.stopMs };
    void this.injector.get(XtreamService).learnConnectionsAllowed();
    const clash = clashesWith(programmes, wanted, this.allowed(untagged(String(channel.stream_id)).tag));
    if (clash.length) {
      return { clash };
    }
    const booked: PlannedRecording = {
      id: newRecordingId(Date.now()),
      device,
      channelId: String(channel.stream_id),
      channel: channelName,
      title: programme.title || channelName,
      startMs: programme.startMs,
      stopMs: programme.stopMs
    };
    this.settings.set(bookingKey(booked.id), writePlanned(booked));
    await this.reconcile();
    return { booked };
  }

  /**
   * Cancels a booking, for every device: the one it was for drops it when it
   * next looks. One airing of a title recorded every time is skipped, so it
   * is not booked again.
   */
  async cancelBooking(id: string): Promise<void> {
    const rule = this.rules().find(one => one.id === ruleOf(id));
    if (rule) {
      this.settings.set(ruleKey(rule.id), writeRule({ ...rule, skip: [...rule.skip, id] }));
    }
    this.settings.delete(bookingKey(id));
    await this.reconcile();
  }

  /** The rule recording every airing of a title on a channel, if there is one. */
  ruleFor(channelId: string, title: string): RecordingRule | null {
    return this.rules().find(one => one.channelId === channelId && sameTitle(one.title, title)) ?? null;
  }

  /**
   * Records every airing of a programme's title on its channel, on a device:
   * that device books each one it finds in the guide ahead.
   */
  async recordEvery(channel: Stream, channelName: string, title: string, device: string = this.deviceKey): Promise<RecordingRule | null> {
    if (channel.portal_cmd || !device || !title.trim()) {
      return null;
    }
    const rule: RecordingRule = {
      id: newRecordingId(Date.now()),
      device,
      channelId: String(channel.stream_id),
      channel: channelName,
      guideId: channel.epg_channel_id || null,
      title: title.trim(),
      skip: []
    };
    this.settings.set(ruleKey(rule.id), writeRule(rule));
    await this.reconcile();
    return rule;
  }

  /** Stops recording a title every time: its airings not yet begun are cancelled too. */
  async stopEvery(ruleId: string): Promise<void> {
    this.settings.delete(ruleKey(ruleId));
    for (const one of this.planned().filter(booked => ruleOf(booked.id) === ruleId && booked.startMs > Date.now())) {
      this.settings.delete(bookingKey(one.id));
    }
    await this.reconcile();
  }

  /** Where new recordings go on this device; those made already stay where they are. */
  async chooseVolume(id: string): Promise<void> {
    await this.rec.chooseVolume?.({ id });
    await this.refresh();
  }

  setOptions(options: RecordingSettings): void {
    this.settings.set(RECORDING_SETTINGS_KEY, writeRecordingSettings(options));
  }

  /**
   * Brings this device's own bookings in line with the account's: books
   * natively what is for it, cancels what was cancelled elsewhere, and
   * clears away bookings done with. One at a time; asked again while
   * running, it runs once more after.
   */
  reconcile(): Promise<void> {
    if (this.reconciling) {
      this.again = true;
      return this.reconciling;
    }
    this.reconciling = this.reconcileOnce()
      .catch(error => console.warn('Recording bookings could not be brought up to date', error))
      .finally(() => {
        this.reconciling = null;
        if (this.again) {
          this.again = false;
          void this.reconcile();
        }
      });
    return this.reconciling;
  }

  private async reconcileOnce(): Promise<void> {
    if (this.available()) {
      await this.refresh();
    }
    const options = this.options();
    if (this.available()) {
      await this.bookAirings();
    }
    const todo = reconcile(this.planned(), this.deviceKey, this.nativeBookings, this.recordings(), Date.now(), options);
    for (const id of todo.forget) {
      this.settings.delete(bookingKey(id));
    }
    if (!this.available()) {
      return;
    }
    // Recordings older than the account keeps them, made here: deleted here.
    const expired = expiredRecordings(this.recordings(), options.keepDays, Date.now());
    for (const one of expired) {
      await this.rec.remove({ id: one.id }).catch(() => null);
    }
    for (const id of todo.cancel) {
      await this.rec.cancelBooking({ id });
    }
    // Booked here already, but with other minutes before or after than the account's now: booked again, which replaces it.
    const stale = this.planned().filter(one => {
      const held = this.nativeBookings.find(native => native.id === one.id);
      const window = recordingWindow(one, options);
      return one.device === this.deviceKey && held && (held.startMs !== window.startMs + NATIVE_LEAD_MS || held.endsAt !== window.endsAt);
    });
    for (const one of [...todo.book, ...stale]) {
      const url = await firstValueFrom(this.injector.get(XtreamService).getPlaybackUrl('live', one.channelId, RECORDED_FORMAT));
      const window = recordingWindow(one, options);
      await this.rec.book({ id: one.id, url, title: one.title, channel: one.channel, channelId: one.channelId, startMs: window.startMs + NATIVE_LEAD_MS, endsAt: window.endsAt });
    }
    if (todo.cancel.length || todo.book.length || stale.length || expired.length) {
      await this.refresh();
    }
  }

  /**
   * Books the airings ahead of every title this device records every time,
   * from the guide (the next day of it). An airing that would need a stream
   * the subscription has not got is left out, not booked over another.
   */
  private async bookAirings(): Promise<void> {
    const mine = this.rules().filter(rule => rule.device === this.deviceKey);
    if (!mine.length) {
      return;
    }
    const xtream = this.injector.get(XtreamService);
    const after = this.options().afterMin * 60_000;
    for (const rule of mine) {
      const pseudo = { stream_id: rule.channelId, name: rule.channel, epg_channel_id: rule.guideId ?? undefined } as unknown as Stream;
      const guide = await firstValueFrom(xtream.guideForStreams([pseudo])).catch(() => null);
      const programmes = (guide?.[rule.channelId] ?? []).map(one => ({
        title: String(one.title ?? ''),
        start: millisecondsOf(one.start_timestamp ?? one.start),
        stop: millisecondsOf(one.stop_timestamp ?? one.stop ?? one.end)
      }));
      for (const airing of episodesToBook(rule, programmes, this.planned(), Date.now())) {
        const taken: RecordingWindow[] = [
          ...this.planned().map(one => ({ title: one.title, startMs: one.startMs, endsAt: one.stopMs })),
          ...this.running().map(one => ({ title: one.title, startMs: one.startedAt, endsAt: one.endsAt - after }))
        ];
        const wanted = { title: airing.title, startMs: airing.startMs, endsAt: airing.stopMs };
        if (!clashesWith(taken, wanted, this.allowed(untagged(rule.channelId).tag)).length) {
          this.settings.set(bookingKey(airing.id), writePlanned(airing));
        }
      }
    }
  }

  /** Tells the account this device records, once a day, so other devices can book for it. */
  private announce(): void {
    if (!this.available()) {
      return;
    }
    const known = this.recorders().find(one => one.key === this.deviceKey);
    if (known && Date.now() - known.seenAt < ANNOUNCE_EVERY_MS) {
      return;
    }
    const tv = this.injector.get(TvNavigationService).isTelevision();
    const kind = tv ? 'tv' : isDesktop() ? 'desktop' : 'phone';
    const name = known?.name ?? t(kind === 'tv' ? 'recordings.aTelevision' : kind === 'desktop' ? 'recordings.aComputer' : 'recordings.aPhone');
    this.settings.set(recorderKey(this.deviceKey), writeRecorder({ key: this.deviceKey, name, kind, seenAt: Date.now() }));
  }

  stop(id: string): Promise<void> {
    return this.rec.stop({ id }).then(() => undefined);
  }

  async remove(id: string): Promise<boolean> {
    const { removed } = await this.rec.remove({ id });
    await this.refresh();
    return removed;
  }

  /**
   * Whether a stream from the provider may open now. Every recording holds a
   * connection, and the subscription allows so many (`allowed`); a refusal
   * here is better than the provider cutting the recording off.
   */
  mayOpen(channelId?: string | null): boolean {
    // Each provider has its own allowance: only recordings from the same one count.
    const tag = untagged(channelId ?? '').tag;
    const same = channelId == null ? this.running() : this.running().filter(one => untagged(one.channelId).tag === tag);
    return mayOpenStream(same.length, this.allowed(tag));
  }

  /** How many streams a provider allows, as last learned; one when not known. */
  allowed(tag: string): number {
    try {
      return Math.max(1, Number(localStorage.getItem(connectionsKey(tag))) || 1);
    } catch {
      return 1;
    }
  }
}

/** This device's key among the account's recorders: made once, kept. */
function deviceKey(): string {
  try {
    const held = localStorage.getItem(DEVICE_KEY);
    if (held && /^[A-Za-z0-9_-]{8,64}$/.test(held)) {
      return held;
    }
    const made = `d${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 6).toString(36)}`;
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    return 'this-device';
  }
}

const isDesktop = (): boolean =>
  typeof window !== 'undefined' && !!(window as { xtreamDesktop?: unknown }).xtreamDesktop;
