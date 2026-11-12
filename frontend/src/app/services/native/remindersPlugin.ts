import { Capacitor, registerPlugin } from '@capacitor/core';

/** A reminder as the APK keeps it, for its alarm (ReminderStore.java). */
export interface NativeReminder {
  key: string;
  streamId: string;
  channel: string;
  title: string;
  start: number;
  stop: number;
}

/** The words the APK says a reminder in: "%s" is the programme. */
export interface NativeReminderTexts {
  starting: string;
  watchHint: string;
  channelName: string;
}

interface RemindersPlugin {
  schedule(options: { reminders: NativeReminder[]; texts: NativeReminderTexts }): Promise<void>;
  fired(): Promise<{ keys: string[] }>;
}

const plugin = registerPlugin<RemindersPlugin>('Reminders');

/**
 * The APK's reminders (RemindersPlugin.java), or null where there are none:
 * a browser, the desktop, or an APK older than 1.0.58, whose reminders go
 * off only while the app is open.
 */
export function nativeReminders(): RemindersPlugin | null {
  return Capacitor.isPluginAvailable('Reminders') ? plugin : null;
}
