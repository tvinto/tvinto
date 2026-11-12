package app.tvinto.recording;

import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web app's way to record (RecordingService) and to see what was
 * recorded (Recordings). Deciding whether a recording may start -- the
 * provider's connection limit, a clash -- is the web app's (shared/recording);
 * this only does it.
 */
@CapacitorPlugin(name = "Recorder")
public class RecorderPlugin extends Plugin {

    @Override
    public void load() {
        RecordingService.listener = id -> {
            JSObject changed = new JSObject();
            changed.put("id", id);
            notifyListeners("changed", changed);
        };
    }

    /** Starts recording `url` until `endsAt` (ms since 1970), as `id`. Carries a login: never logged. */
    @PluginMethod
    public void start(PluginCall call) {
        String id = call.getString("id", "");
        String url = call.getString("url", "");
        // getData().optLong, not getLong: a number JavaScript sends that fits an
        // Integer comes back from getLong as the default (CLAUDE.md).
        long endsAt = call.getData().optLong("endsAt", 0L);
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,64}") || url == null || !url.matches("(?i)^https?://.+") || endsAt <= System.currentTimeMillis()) {
            call.reject("Not something that can be recorded");
            return;
        }
        Intent intent = new Intent(getContext(), RecordingService.class)
            .setAction(RecordingService.ACTION_START)
            .putExtra(RecordingService.EXTRA_ID, id)
            .putExtra(RecordingService.EXTRA_URL, url)
            .putExtra(RecordingService.EXTRA_TITLE, call.getString("title", ""))
            .putExtra(RecordingService.EXTRA_CHANNEL, call.getString("channel", ""))
            .putExtra(RecordingService.EXTRA_CHANNEL_ID, call.getString("channelId", ""))
            .putExtra(RecordingService.EXTRA_ENDS_AT, endsAt);
        ContextCompat.startForegroundService(getContext(), intent);
        JSObject started = new JSObject();
        started.put("id", id);
        call.resolve(started);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        String id = call.getString("id", "");
        Intent intent = new Intent(getContext(), RecordingService.class)
            .setAction(RecordingService.ACTION_STOP)
            .putExtra(RecordingService.EXTRA_ID, id);
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    /** Where to watch a recording while it records, on this device only (RecordingTail). */
    @PluginMethod
    public void watchAddress(PluginCall call) {
        String id = call.getString("id", "");
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,64}")) {
            call.reject("No such recording");
            return;
        }
        try {
            JSObject answer = new JSObject();
            answer.put("url", RecordingTail.address(getContext(), id));
            call.resolve(answer);
        } catch (java.io.IOException failed) {
            call.reject("Could not serve the recording", failed);
        }
    }

    /**
     * Books a recording for later: an exact alarm starts it a minute before
     * `startMs`, and it runs until `endsAt`. The address is kept in the app's
     * private storage until then (Bookings).
     */
    @PluginMethod
    public void book(PluginCall call) {
        String id = call.getString("id", "");
        String url = call.getString("url", "");
        long startMs = call.getData().optLong("startMs", 0L);
        long endsAt = call.getData().optLong("endsAt", 0L);
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,64}") || url == null || !url.matches("(?i)^https?://.+") || endsAt <= startMs || endsAt <= System.currentTimeMillis()) {
            call.reject("Not something that can be booked");
            return;
        }
        org.json.JSONObject booking = new org.json.JSONObject();
        try {
            booking.put("id", id);
            booking.put("url", url);
            booking.put("title", call.getString("title", ""));
            booking.put("channel", call.getString("channel", ""));
            booking.put("channelId", call.getString("channelId", ""));
            booking.put("startMs", startMs);
            booking.put("endsAt", endsAt);
        } catch (org.json.JSONException impossible) {
            call.reject("Could not book");
            return;
        }
        Bookings.add(getContext(), booking);
        call.resolve();
    }

    @PluginMethod
    public void cancelBooking(PluginCall call) {
        Bookings.cancel(getContext(), call.getString("id", ""));
        call.resolve();
    }

    /** The bookings still to come, without their addresses. */
    @PluginMethod
    public void bookings(PluginCall call) {
        JSObject answer = new JSObject();
        answer.put("bookings", Bookings.listed(getContext()));
        call.resolve(answer);
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSObject answer = new JSObject();
        answer.put("recordings", Recordings.read(getContext()));
        call.resolve(answer);
    }

    /** The drives recordings can go to: the device's own, a USB drive, a memory card (Recordings). */
    @PluginMethod
    public void volumes(PluginCall call) {
        JSObject answer = new JSObject();
        answer.put("volumes", Recordings.volumes(getContext()));
        call.resolve(answer);
    }

    /** Where new recordings go, by a drive's id from volumes(). */
    @PluginMethod
    public void chooseVolume(PluginCall call) {
        JSObject answer = new JSObject();
        answer.put("chosen", Recordings.choose(getContext(), call.getString("id", "")));
        call.resolve(answer);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        JSObject answer = new JSObject();
        answer.put("removed", Recordings.remove(getContext(), call.getString("id", "")));
        call.resolve(answer);
    }
}
