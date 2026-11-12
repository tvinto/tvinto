package app.tvinto.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;

/**
 * Where a film or an episode had got to, kept while it plays.
 *
 * The position used to reach the watch history only when the player closed,
 * so a crash, a power cut or Android killing the app while the television sat
 * in standby lost the whole of that viewing (27 October). Two
 * things now happen every time a player reports its position:
 *
 * - it is written on the device, with the item it belongs to, so the next
 *   launch can save a viewing that never closed (`take`);
 * - once a minute it is sent to the web app, which saves it and syncs it as
 *   it would at the end. Sent and not waited on: the page behind the player is
 *   slowed to a crawl (CLAUDE.md), and nothing in playback may depend on it.
 *
 * Only when the web app asked (`reportProgress`), which it does for films and
 * episodes and never for a live channel, whose position means nothing.
 */
final class PlaybackCheckpoint {

    private static final String STORE = "playback_checkpoint";
    private static final long SEND_EVERY_MS = 60_000L;

    private static volatile boolean reporting = false;
    private static volatile long lastSentAt = 0L;

    private PlaybackCheckpoint() {}

    /** A new play: whether this one reports, and nothing sent for it yet. */
    static void begin(boolean report) {
        reporting = report;
        lastSentAt = SystemClock.elapsedRealtime();
    }

    /** The player is at this point of the item on screen. */
    static void reached(Context context, long positionSeconds, long durationSeconds) {
        String itemId = PlaybackReports.currentItem();
        if (!reporting || itemId == null || itemId.isEmpty() || durationSeconds <= 0 || positionSeconds <= 0) {
            return;
        }

        context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
            .edit()
            .putString("itemId", itemId)
            .putLong("positionSeconds", positionSeconds)
            .putLong("durationSeconds", durationSeconds)
            .putLong("at", System.currentTimeMillis())
            .apply();

        long now = SystemClock.elapsedRealtime();
        if (now - lastSentAt >= SEND_EVERY_MS) {
            lastSentAt = now;
            JSObject data = new JSObject();
            data.put("itemId", itemId);
            data.put("positionSeconds", positionSeconds);
            data.put("durationSeconds", durationSeconds);
            NativePlayerPlugin.emit("progress", data);
        }
    }

    /** The player closed and its result reached the web app: nothing is left to save. */
    static void finished(Context context) {
        reporting = false;
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().clear().apply();
    }

    /** A viewing that never closed, once, or null. */
    @Nullable
    static JSObject take(Context context) {
        SharedPreferences store = context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
        String itemId = store.getString("itemId", null);
        if (itemId == null) {
            return null;
        }
        JSObject held = new JSObject();
        held.put("itemId", itemId);
        held.put("positionSeconds", store.getLong("positionSeconds", 0L));
        held.put("durationSeconds", store.getLong("durationSeconds", 0L));
        held.put("at", store.getLong("at", 0L));
        store.edit().clear().apply();
        return held;
    }
}
