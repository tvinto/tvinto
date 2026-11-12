package app.tvinto.recording;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Recordings booked for later (private plan: recording): kept in the app's
 * private storage, each with an exact alarm that starts RecordingService a
 * little before the programme, set again after the device restarts -- the
 * way reminders are (reminders/ReminderAlarms).
 *
 * A booking keeps the stream's address, which carries the provider's login,
 * in the app's own private preferences, as the app keeps the login itself;
 * never in the alarm, a log line or anything the web app is shown back.
 */
public final class Bookings extends BroadcastReceiver {

    private static final String FILE = "recording_bookings";
    private static final String KEY = "bookings";
    static final String ACTION = "app.tvinto.RECORD_BOOKED";
    /** A booking starts recording this long before the programme does. */
    static final long BEFORE_MS = 60_000L;

    /** Sets an alarm for every booking still to come, and forgets those past. */
    static void reschedule(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        JSONArray all = all(context);
        JSONArray kept = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < all.length(); i++) {
            JSONObject booking = all.optJSONObject(i);
            if (booking == null || booking.optLong("endsAt") <= now) {
                if (booking != null && alarms != null) {
                    alarms.cancel(pendingFor(context, booking.optString("id")));
                }
                continue;
            }
            kept.put(booking);
            if (alarms != null) {
                long at = Math.max(booking.optLong("startMs") - BEFORE_MS, now + 1_000L);
                boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms();
                PendingIntent pending = pendingFor(context, booking.optString("id"));
                if (exact) {
                    alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
                } else {
                    alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
                }
            }
        }
        save(context, kept);
    }

    /** Adds a booking, or replaces the one with its id (new minutes before or after). */
    static void add(Context context, JSONObject booking) {
        JSONArray all = all(context);
        JSONArray kept = new JSONArray();
        String id = booking.optString("id");
        for (int i = 0; i < all.length(); i++) {
            JSONObject one = all.optJSONObject(i);
            if (one != null && !id.equals(one.optString("id"))) {
                kept.put(one);
            }
        }
        kept.put(booking);
        save(context, kept);
        reschedule(context);
    }

    static void cancel(Context context, String id) {
        JSONArray all = all(context);
        JSONArray kept = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject booking = all.optJSONObject(i);
            if (booking != null && !id.equals(booking.optString("id"))) {
                kept.put(booking);
            }
        }
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms != null) {
            alarms.cancel(pendingFor(context, id));
        }
        save(context, kept);
    }

    /** The bookings as the web app sees them: without their addresses. */
    static JSONArray listed(Context context) {
        JSONArray all = all(context);
        JSONArray shown = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject booking = all.optJSONObject(i);
            if (booking == null) {
                continue;
            }
            try {
                JSONObject copy = new JSONObject(booking.toString());
                copy.remove("url");
                shown.put(copy);
            } catch (JSONException ignored) {
                // Left out.
            }
        }
        return shown;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            reschedule(context);
            return;
        }
        if (!ACTION.equals(action) || intent.getData() == null) {
            return;
        }
        String id = Uri.decode(intent.getData().getSchemeSpecificPart());
        JSONObject booking = find(context, id);
        cancel(context, id);
        if (booking == null || booking.optLong("endsAt") <= System.currentTimeMillis()) {
            return;
        }
        // A recording still running is in its minutes after the end: the web
        // app booked nothing that overlaps the programmes themselves
        // (shared/recording, clashesWith). It lets go of the connection.
        for (String running : RecordingService.runningIds()) {
            ContextCompat.startForegroundService(context, new Intent(context, RecordingService.class)
                .setAction(RecordingService.ACTION_STOP)
                .putExtra(RecordingService.EXTRA_ID, running));
        }
        // An exact alarm may start a foreground service: this is that.
        Intent start = new Intent(context, RecordingService.class)
            .setAction(RecordingService.ACTION_START)
            .putExtra(RecordingService.EXTRA_ID, id)
            .putExtra(RecordingService.EXTRA_URL, booking.optString("url"))
            .putExtra(RecordingService.EXTRA_TITLE, booking.optString("title"))
            .putExtra(RecordingService.EXTRA_CHANNEL, booking.optString("channel"))
            .putExtra(RecordingService.EXTRA_CHANNEL_ID, booking.optString("channelId"))
            .putExtra(RecordingService.EXTRA_ENDS_AT, booking.optLong("endsAt"));
        ContextCompat.startForegroundService(context, start);
    }

    @Nullable
    private static JSONObject find(Context context, String id) {
        JSONArray all = all(context);
        for (int i = 0; i < all.length(); i++) {
            JSONObject booking = all.optJSONObject(i);
            if (booking != null && id.equals(booking.optString("id"))) {
                return booking;
            }
        }
        return null;
    }

    private static JSONArray all(Context context) {
        try {
            return new JSONArray(prefs(context).getString(KEY, "[]"));
        } catch (JSONException broken) {
            return new JSONArray();
        }
    }

    private static void save(Context context, JSONArray all) {
        prefs(context).edit().putString(KEY, all.toString()).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    private static PendingIntent pendingFor(Context context, String id) {
        Intent intent = new Intent(context, Bookings.class)
            .setAction(ACTION)
            .setData(Uri.parse("tvinto-booking:" + Uri.encode(id)));
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
