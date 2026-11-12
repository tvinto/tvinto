package app.tvinto.reminders;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import app.tvinto.MainActivity;
import app.tvinto.player.ReminderBanner;

/**
 * A reminder's alarm going off, and the device starting up (alarms do not
 * survive a restart, so they are set again from the store).
 *
 * Who says it depends on what is on screen:
 * <ul>
 *   <li>the app's own player: a banner over the video, since the page behind
 *   it is all but stopped and cannot (CLAUDE.md);</li>
 *   <li>the app itself: nothing here -- the web app's own box says it, with
 *   Watch in focus;</li>
 *   <li>anything else, or nothing (the app closed): a notification that opens
 *   the channel.</li>
 * </ul>
 */
public class ReminderReceiver extends BroadcastReceiver {

    private static final String CHANNEL = "reminders";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            ReminderAlarms.reschedule(context);
            return;
        }
        if (!ReminderAlarms.ACTION.equals(action) || intent.getData() == null) {
            return;
        }

        String key = Uri.decode(intent.getData().getSchemeSpecificPart());
        ReminderStore.Reminder reminder = ReminderStore.find(context, key);
        long now = System.currentTimeMillis();
        if (reminder == null || ReminderStore.firedKeys(context).contains(key) || now >= reminder.stop) {
            return;
        }

        if (ReminderBanner.ringInPlayer(reminder.key, reminder.streamId, reminder.channel, reminder.title,
            ReminderStore.text(context, "starting", "Starting: %s"),
            ReminderStore.text(context, "watchHint", "OK: watch"),
            reminder.watchLink())) {
            android.util.Log.i(TAG, "Reminder said in the player");
            ReminderStore.markFired(context, key);
            return;
        }
        if (MainActivity.isInFront()) {
            android.util.Log.i(TAG, "Reminder left to the app, which is in front");
            return;
        }
        // Not marked when it could not be posted: the app says it on its return instead.
        if (notify(context, reminder)) {
            android.util.Log.i(TAG, "Reminder said as a notification");
            ReminderStore.markFired(context, key);
        } else {
            android.util.Log.i(TAG, "Reminder kept for the app: notifications are not allowed");
        }
    }

    private static final String TAG = "TvintoReminder";

    /** Posts the notification; false when it cannot be. */
    private static boolean notify(Context context, ReminderStore.Reminder reminder) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL,
                ReminderStore.text(context, "channelName", "Reminders"),
                NotificationManager.IMPORTANCE_HIGH
            );
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(reminder.watchLink()), context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(
            context, reminder.key.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL)
            : new Notification.Builder(context);
        builder
            .setSmallIcon(app.tvinto.R.drawable.ic_stat_reminder)
            .setContentTitle(String.format(ReminderStore.text(context, "starting", "Starting: %s"), reminder.title))
            .setContentText(reminder.channel)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setWhen(reminder.start)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(tap);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Gone once the programme is over: it has nothing left to offer.
            builder.setTimeoutAfter(Math.max(60_000L, reminder.stop - System.currentTimeMillis()));
        } else {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }
        manager.notify(reminder.key.hashCode(), builder.build());
        return true;
    }
}
