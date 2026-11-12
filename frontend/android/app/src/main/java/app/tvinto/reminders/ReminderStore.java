package app.tvinto.reminders;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The reminders the web app set (reminders.service.ts), kept where an alarm can
 * read them with the app closed: after a restart of the device, or when the
 * system ended the app long before the programme.
 *
 * The web app owns them and sends the whole list whenever it changes; this
 * only remembers the last list, the words to say them in, and which ones went
 * off here -- so the web app does not say a reminder again that the player or
 * a notification already said.
 */
final class ReminderStore {

    private static final String FILE = "reminders";
    private static final String LIST = "list";
    private static final String TEXTS = "texts";
    private static final String FIRED = "fired";
    private static final String SCHEDULED = "scheduled";

    /** One reminder, as the web app describes it. */
    static final class Reminder {
        final String key;
        final String streamId;
        final String channel;
        final String title;
        final long start;
        final long stop;

        Reminder(JSONObject json) {
            key = json.optString("key", "");
            streamId = json.optString("streamId", "");
            channel = json.optString("channel", "");
            title = json.optString("title", "");
            start = json.optLong("start", 0L);
            stop = json.optLong("stop", 0L);
        }

        /** The address that opens the app on this channel (DeepLinks in the web app). */
        String watchLink() {
            return "tvinto://watch?stream=" + android.net.Uri.encode(streamId)
                + "&name=" + android.net.Uri.encode(channel)
                + "&kind=reminder";
        }
    }

    private ReminderStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static void save(Context context, JSONArray list, JSONObject texts) {
        Set<String> keys = new HashSet<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject entry = list.optJSONObject(i);
            if (entry != null) {
                keys.add(entry.optString("key", ""));
            }
        }
        // What went off is forgotten with the reminder itself.
        Set<String> fired = new HashSet<>(firedKeys(context));
        fired.retainAll(keys);
        prefs(context).edit()
            .putString(LIST, list.toString())
            .putString(TEXTS, texts.toString())
            .putStringSet(FIRED, fired)
            .apply();
    }

    static List<Reminder> all(Context context) {
        List<Reminder> reminders = new ArrayList<>();
        try {
            JSONArray list = new JSONArray(prefs(context).getString(LIST, "[]"));
            for (int i = 0; i < list.length(); i++) {
                JSONObject entry = list.optJSONObject(i);
                if (entry != null) {
                    Reminder reminder = new Reminder(entry);
                    if (!reminder.key.isEmpty() && reminder.start > 0) {
                        reminders.add(reminder);
                    }
                }
            }
        } catch (JSONException ignored) {
            // Nothing readable: no reminders, rather than a crash in a receiver.
        }
        return reminders;
    }

    @Nullable
    static Reminder find(Context context, String key) {
        for (Reminder reminder : all(context)) {
            if (reminder.key.equals(key)) {
                return reminder;
            }
        }
        return null;
    }

    /** A word the web app sent, "%s" filled in where it has one. */
    static String text(Context context, String name, String fallback) {
        try {
            String text = new JSONObject(prefs(context).getString(TEXTS, "{}")).optString(name, fallback);
            return text.isEmpty() ? fallback : text;
        } catch (JSONException ignored) {
            return fallback;
        }
    }

    static Set<String> firedKeys(Context context) {
        return new HashSet<>(prefs(context).getStringSet(FIRED, new HashSet<>()));
    }

    static void markFired(Context context, String key) {
        Set<String> fired = firedKeys(context);
        fired.add(key);
        prefs(context).edit().putStringSet(FIRED, fired).apply();
    }

    /** The keys alarms are set for, so one taken away can be cancelled. */
    static Set<String> scheduledKeys(Context context) {
        return new HashSet<>(prefs(context).getStringSet(SCHEDULED, new HashSet<>()));
    }

    static void setScheduledKeys(Context context, Set<String> keys) {
        prefs(context).edit().putStringSet(SCHEDULED, keys).apply();
    }
}
