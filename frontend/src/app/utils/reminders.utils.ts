/**
 * Reminders from the guide: a programme that has
 * not started, and a nudge just before it does. Kept on the device where they
 * were set -- a reminder that went off on every screen of the account at once
 * would be three alarms for one programme.
 *
 * Plain functions, so the rules can be tested without a page.
 */

export interface Reminder {
  /** The channel, as the catalogue knows it (provider tag included). */
  streamId: string;
  channel: string;
  icon: string | null;
  title: string;
  /** Milliseconds. */
  start: number;
  stop: number;
  /** Set once it has gone off, so it goes off once. */
  firedAt?: string;
}

/** How long before the start a reminder goes off. */
export const REMIND_BEFORE_MS = 60 * 1000;

/** One reminder per programme on a channel. */
export const reminderKey = (streamId: string | number, start: number): string => `${streamId}@${start}`;

export function readReminders(raw: string | null | undefined): Reminder[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is Reminder =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as Reminder).streamId === 'string' &&
        Number.isFinite((item as Reminder).start) &&
        Number.isFinite((item as Reminder).stop)
    );
  } catch {
    return [];
  }
}

/** Those still worth keeping: not over. */
export const current = (reminders: readonly Reminder[], now: number): Reminder[] =>
  reminders.filter(reminder => reminder.stop > now);

/**
 * The ones to go off now: from a minute before the start until the programme
 * ends -- a device asleep at the start still says so when it wakes, while
 * there is something left to watch -- and only once.
 */
export const due = (reminders: readonly Reminder[], now: number): Reminder[] =>
  reminders
    .filter(reminder => !reminder.firedAt && now >= reminder.start - REMIND_BEFORE_MS && now < reminder.stop)
    .sort((a, b) => a.start - b.start);

/** A reminder set, or taken away when it was already there. */
export function toggled(reminders: readonly Reminder[], reminder: Reminder): Reminder[] {
  const key = reminderKey(reminder.streamId, reminder.start);
  return reminders.some(existing => reminderKey(existing.streamId, existing.start) === key)
    ? reminders.filter(existing => reminderKey(existing.streamId, existing.start) !== key)
    : [...reminders, reminder].sort((a, b) => a.start - b.start);
}
