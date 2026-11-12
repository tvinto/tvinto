import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { EPGProgram, Stream } from '@shared/types';
import { AccountService } from './account.service';
import { NativePlayerService } from './native-player.service';
import { accountStorageKey } from '../utils/account-storage.utils';
import { takeBrought } from '../utils/local-drawers.utils';
import { Reminder, current, due, readReminders, reminderKey, toggled } from '../utils/reminders.utils';
import { millisecondsOf } from '../utils';
import { t } from '../utils/i18n';
import { nativeReminders } from './native/remindersPlugin';

/** Where an account's reminders are kept on this device. */
const STORAGE_PREFIX = 'xtream_reminders';

/** How often it looks at whether one is due. */
const EVERY_MS = 20 * 1000;

/**
 * Reminders from the guide (reminders.utils.ts): set by pressing a programme
 * that has not started, gone off a minute before it does.
 *
 * On this device only, for the account in use. What goes off is a box over
 * whatever is on screen, with Watch already in focus -- so on a television
 * one press of OK switches to the channel -- and, on the desktop, a Windows
 * notification as well, for when the player or another window is in front.
 *
 * On Android (APK 1.0.58 and later) each reminder also has an alarm of its
 * own (RemindersPlugin.java): it goes off in the player as a banner -- the
 * page behind the player is all but stopped while it plays (CLAUDE.md) -- or
 * as a notification when the app is closed. What went off there is not said
 * again here.
 */
@Injectable({ providedIn: 'root' })
export class RemindersService {
  private readonly accounts = inject(AccountService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  private readonly stored = signal<Reminder[]>([]);
  readonly all = this.stored.asReadonly();

  private readonly keys = computed(() => new Set(this.stored().map(reminder => reminderKey(reminder.streamId, reminder.start))));

  /** What has gone off and is waiting to be answered, oldest first. */
  readonly ringing = signal<Reminder[]>([]);

  private started = false;

  constructor() {
    // Each account its own: following the account keeps a profile switch, or
    // a sign-in as somebody else, from inheriting the last one's reminders.
    effect(() => {
      this.accounts.storageName();
      untracked(() => {
        this.stored.set(current(readReminders(this.read()), Date.now()));
        this.handToDevice();
      });
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.ring();
    const timer = setInterval(() => void this.ring(), EVERY_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  has(streamId: string | number, start: number): boolean {
    return this.keys().has(reminderKey(String(streamId), start));
  }

  /** Sets a reminder for a programme that has not started, or takes it away. True when one is now set. */
  toggle(stream: Stream, program: EPGProgram): boolean {
    return this.toggleProgramme(stream, {
      title: program.title || '',
      start: millisecondsOf(program.start_timestamp),
      stop: millisecondsOf(program.stop_timestamp)
    });
  }

  /** The same, for a programme whose times are already milliseconds: one found by guide search. */
  toggleProgramme(stream: Stream, programme: { title: string; start: number; stop: number }): boolean {
    const next = toggled(this.stored(), {
      streamId: String(stream.stream_id),
      channel: stream.name,
      icon: stream.stream_icon || null,
      title: programme.title,
      start: programme.start,
      stop: programme.stop
    });
    this.save(next);
    return this.has(stream.stream_id, programme.start);
  }

  /** Switches to the channel of a reminder that went off. */
  watch(reminder: Reminder): void {
    this.dismiss(reminder);
    void this.router.navigate(['/tv'], {
      queryParams: { play: reminder.streamId, kind: 'reminder', name: reminder.channel, icon: reminder.icon ?? '' }
    });
  }

  dismiss(reminder: Reminder): void {
    const key = reminderKey(reminder.streamId, reminder.start);
    this.ringing.update(list => list.filter(item => reminderKey(item.streamId, item.start) !== key));
  }

  /** Whether a look at what is due is under way, so two cannot overlap. */
  private checking = false;

  private async ring(): Promise<void> {
    if (this.checking) {
      return;
    }
    this.checking = true;
    try {
      await this.takeFiredOnDevice();
      this.ringNow();
    } finally {
      this.checking = false;
    }
  }

  /** Those the APK already said -- in the player, or as a notification -- are not said again. */
  private async takeFiredOnDevice(): Promise<void> {
    const device = nativeReminders();
    if (!device) {
      return;
    }
    const fired = new Set((await device.fired().catch(() => ({ keys: [] as string[] }))).keys);
    if (!this.stored().some(reminder => !reminder.firedAt && fired.has(reminderKey(reminder.streamId, reminder.start)))) {
      return;
    }
    const firedAt = new Date().toISOString();
    this.save(
      this.stored().map(reminder =>
        !reminder.firedAt && fired.has(reminderKey(reminder.streamId, reminder.start)) ? { ...reminder, firedAt } : reminder
      )
    );
  }

  private ringNow(): void {
    const now = Date.now();
    const kept = current(this.stored(), now);
    // Held back while the device's own player has the screen: the box could
    // not be seen, and a Watch pressed blind would switch channel under the
    // viewer. It goes off as the player closes.
    if (this.player().active()) {
      return;
    }
    const going = due(kept, now);
    if (!going.length) {
      if (kept.length !== this.stored().length) {
        this.save(kept);
      }
      return;
    }
    const firedAt = new Date(now).toISOString();
    const goingKeys = new Set(going.map(reminder => reminderKey(reminder.streamId, reminder.start)));
    this.save(kept.map(reminder => (goingKeys.has(reminderKey(reminder.streamId, reminder.start)) ? { ...reminder, firedAt } : reminder)));
    this.ringing.update(list => [...list, ...going]);
    for (const reminder of going) {
      this.notifyOutside(reminder);
    }
  }

  /** A Windows notification on the desktop, for when the app is not what is in front. */
  private notifyOutside(reminder: Reminder): void {
    const isDesktop = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent);
    if (!isDesktop || typeof Notification === 'undefined') {
      return;
    }
    try {
      const notification = new Notification(t('remind.starting', { title: reminder.title }), {
        body: reminder.channel,
        icon: reminder.icon ?? undefined
      });
      notification.onclick = () => {
        window.focus();
        this.watch(reminder);
      };
    } catch {
      // The box in the app says it anyway.
    }
  }

  private player(): NativePlayerService {
    return this.injector.get(NativePlayerService);
  }

  private save(reminders: Reminder[]): void {
    this.stored.set(reminders);
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(reminders));
    } catch {
      // Kept for this run.
    }
    this.handToDevice();
  }

  /** The ones still to go off, for the APK's alarms; the whole list each time. */
  private handToDevice(): void {
    const device = nativeReminders();
    if (!device) {
      return;
    }
    const waiting = this.stored().filter(reminder => !reminder.firedAt);
    void device
      .schedule({
        reminders: waiting.map(reminder => ({
          key: reminderKey(reminder.streamId, reminder.start),
          streamId: reminder.streamId,
          channel: reminder.channel,
          title: reminder.title,
          start: reminder.start,
          stop: reminder.stop
        })),
        texts: {
          starting: t('remind.starting', { title: '%s' }),
          watchHint: t('remind.okWatch'),
          channelName: t('remind.channelName')
        }
      })
      .catch(() => undefined);
  }

  private read(): string | null {
    try {
      const raw = localStorage.getItem(this.storageKey());
      // A device's reminders brought into an account that had its own here
      // (local-drawers.utils.ts): both kept.
      const brought = takeBrought(localStorage, 'xtream_reminders', this.accounts.storageName());
      if (!brought) {
        return raw;
      }
      const mine = readReminders(raw);
      const known = new Set(mine.map(reminder => reminderKey(reminder.streamId, reminder.start)));
      const merged = [...mine, ...readReminders(brought).filter(reminder => !known.has(reminderKey(reminder.streamId, reminder.start)))];
      const text = JSON.stringify(merged);
      localStorage.setItem(this.storageKey(), text);
      return text;
    } catch {
      return null;
    }
  }

  private storageKey(): string {
    return accountStorageKey(STORAGE_PREFIX, this.accounts.storageName());
  }
}
