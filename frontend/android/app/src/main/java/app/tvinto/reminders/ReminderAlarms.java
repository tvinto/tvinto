package app.tvinto.reminders;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import java.util.HashSet;
import java.util.Set;

/**
 * An alarm for each reminder, a minute before its programme starts.
 *
 * Exact where Android allows it: a reminder that came four minutes late, which
 * an inexact alarm in Doze is free to do, would have missed the kick-off it
 * was set for. The app is installed by hand rather than from Play, so the
 * exact-alarm permission is declared rather than asked for (the manifest).
 */
final class ReminderAlarms {

    /** How long before the start a reminder goes off; the same as REMIND_BEFORE_MS in the web app. */
    static final long BEFORE_MS = 60_000L;

    static final String ACTION = "app.tvinto.REMINDER";

    private ReminderAlarms() {}

    /** Sets the alarms for the reminders stored, and cancels those for reminders gone. */
    static void reschedule(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) {
            return;
        }
        long now = System.currentTimeMillis();
        Set<String> wanted = new HashSet<>();
        Set<String> fired = ReminderStore.firedKeys(context);

        for (ReminderStore.Reminder reminder : ReminderStore.all(context)) {
            long at = reminder.start - BEFORE_MS;
            if (reminder.stop <= now || fired.contains(reminder.key)) {
                continue;
            }
            wanted.add(reminder.key);
            // One already due goes off now: the device was off, or asleep, at its minute.
            set(alarms, Math.max(at, now + 1_000L), pendingFor(context, reminder.key));
        }

        for (String key : ReminderStore.scheduledKeys(context)) {
            if (!wanted.contains(key)) {
                alarms.cancel(pendingFor(context, key));
            }
        }
        ReminderStore.setScheduledKeys(context, wanted);
    }

    private static void set(AlarmManager alarms, long at, PendingIntent pending) {
        boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms();
        if (exact) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        }
    }

    /** One per reminder, told apart by its address rather than a request code that could collide. */
    private static PendingIntent pendingFor(Context context, String key) {
        Intent intent = new Intent(context, ReminderReceiver.class)
            .setAction(ACTION)
            .setData(Uri.parse("xtream-reminder:" + Uri.encode(key)));
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
