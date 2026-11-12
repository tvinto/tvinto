package app.tvinto.device;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.Nullable;
import androidx.tvprovider.media.tv.PreviewChannel;
import androidx.tvprovider.media.tv.PreviewChannelHelper;
import androidx.tvprovider.media.tv.PreviewProgram;
import androidx.tvprovider.media.tv.TvContractCompat;
import androidx.tvprovider.media.tv.WatchNextProgram;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * The app on an Android TV's home screen: a row of
 * the favourite channels, and what is half watched in the system's own
 * "Play next" row. Each opens the app with an tvinto:// link
 * (DeepLinksService in the web app).
 *
 * The web app sends both lists whole; this keeps the row in step with them --
 * updating what stayed, adding what is new, taking away what went -- rather
 * than emptying and refilling a row somebody may be looking at.
 *
 * Something the person took out of "Play next" themselves stays out until it
 * is watched again: putting it straight back would be the app overruling them.
 *
 * Android TV 8 and later only. Google TV's own home screen shows few app rows,
 * so there the row may only be found under the app; "Play next" is shown more
 * widely.
 */
@CapacitorPlugin(name = "HomeScreen")
public class HomeScreenPlugin extends Plugin {

    private static final String FILE = "home_screen";
    private static final String CHANNEL_ID = "channel";
    private static final String ROW = "row";
    private static final String NEXT = "next";
    private static final String NEXT_WATCHED = "nextWatched";

    @PluginMethod
    public void publish(PluginCall call) {
        JSObject result = new JSObject();
        if (!supported()) {
            result.put("published", false);
            call.resolve(result);
            return;
        }
        try {
            PreviewChannelHelper helper = new PreviewChannelHelper(getContext());
            long channel = channel(helper, call.getString("rowName", "Favourite channels"));
            syncRow(helper, channel, call.getArray("channels", new JSArray()));
            syncPlayNext(helper, call.getArray("playNext", new JSArray()));
            result.put("published", true);
            call.resolve(result);
        } catch (Exception failure) {
            // A home screen that will not take the row is not worth failing over.
            android.util.Log.w("TvintoHome", "Could not publish to the home screen: " + failure.getClass().getSimpleName());
            result.put("published", false);
            call.resolve(result);
        }
    }

    private boolean supported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** The app's row, made the first time and renamed when the language changes. */
    private long channel(PreviewChannelHelper helper, String name) throws java.io.IOException {
        long id = prefs().getLong(CHANNEL_ID, -1L);
        PreviewChannel existing = id >= 0 ? helper.getPreviewChannel(id) : null;
        PreviewChannel wanted = new PreviewChannel.Builder()
            .setDisplayName(name)
            .setAppLinkIntentUri(Uri.parse("tvinto://open"))
            .setInternalProviderId("favourites")
            .setLogo(logo(getContext()))
            .build();
        if (existing == null) {
            // The first row an app makes is shown without asking; this is it.
            id = helper.publishDefaultChannel(wanted);
            prefs().edit().putLong(CHANNEL_ID, id).putString(ROW, "{}").apply();
        } else if (!name.contentEquals(existing.getDisplayName())) {
            helper.updatePreviewChannel(id, wanted);
        }
        return id;
    }

    private void syncRow(PreviewChannelHelper helper, long channel, JSONArray items) throws JSONException {
        Map<String, Long> before = readIds(ROW);
        Map<String, Long> after = new HashMap<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            String key = item.getString("id");
            PreviewProgram program = new PreviewProgram.Builder()
                .setChannelId(channel)
                .setType(TvContractCompat.PreviewPrograms.TYPE_CHANNEL)
                .setLive(true)
                .setTitle(item.optString("title", ""))
                .setDescription(item.optString("description", ""))
                .setPosterArtUri(posterOf(item))
                .setPosterArtAspectRatio(TvContractCompat.PreviewPrograms.ASPECT_RATIO_16_9)
                .setIntentUri(Uri.parse(item.getString("link")))
                .setInternalProviderId(key)
                // Higher first: the order the web app sent.
                .setWeight(items.length() - i)
                .build();
            Long id = before.remove(key);
            if (id != null && helper.getPreviewProgram(id) != null) {
                helper.updatePreviewProgram(id, program);
            } else {
                id = helper.publishPreviewProgram(program);
            }
            after.put(key, id);
        }
        for (Long gone : before.values()) {
            helper.deletePreviewProgram(gone);
        }
        writeIds(ROW, after);
    }

    private void syncPlayNext(PreviewChannelHelper helper, JSONArray items) throws JSONException {
        Map<String, Long> before = readIds(NEXT);
        Map<String, Long> watched = readIds(NEXT_WATCHED);
        Map<String, Long> after = new HashMap<>();
        Map<String, Long> afterWatched = new HashMap<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            String key = item.getString("id");
            long lastWatched = item.optLong("lastWatched", System.currentTimeMillis());
            Long id = before.remove(key);
            WatchNextProgram existing = id == null ? null : helper.getWatchNextProgram(id);
            Long seenAt = watched.get(key);

            // Taken out by the person: left out, unless watched since.
            if (existing != null && !existing.isBrowsable() && seenAt != null && seenAt >= lastWatched) {
                after.put(key, id);
                afterWatched.put(key, seenAt);
                continue;
            }

            boolean film = "movie".equals(item.optString("kind"));
            WatchNextProgram.Builder builder = new WatchNextProgram.Builder();
            builder
                .setType(film ? TvContractCompat.WatchNextPrograms.TYPE_MOVIE : TvContractCompat.WatchNextPrograms.TYPE_TV_SERIES)
                .setWatchNextType(TvContractCompat.WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE)
                .setLastEngagementTimeUtcMillis(lastWatched)
                .setTitle(item.optString("title", ""))
                .setDescription(item.optString("description", ""))
                .setPosterArtUri(posterOf(item))
                .setPosterArtAspectRatio(TvContractCompat.PreviewPrograms.ASPECT_RATIO_2_3)
                .setIntentUri(Uri.parse(item.getString("link")))
                .setInternalProviderId(key)
                .setBrowsable(true);
            int duration = (int) Math.min(Integer.MAX_VALUE, item.optLong("durationMs", 0L));
            int position = (int) Math.min(Integer.MAX_VALUE, item.optLong("positionMs", 0L));
            if (duration > 0) {
                builder.setDurationMillis(duration).setLastPlaybackPositionMillis(position);
            }
            WatchNextProgram program = builder.build();

            if (existing != null) {
                helper.updateWatchNextProgram(program, id);
            } else {
                id = helper.publishWatchNextProgram(program);
            }
            after.put(key, id);
            afterWatched.put(key, lastWatched);
        }
        for (Long gone : before.values()) {
            getContext().getContentResolver().delete(TvContractCompat.buildWatchNextProgramUri(gone), null, null);
        }
        writeIds(NEXT, after);
        writeIds(NEXT_WATCHED, afterWatched);
    }

    @Nullable
    private static Uri posterOf(JSONObject item) {
        String poster = item.optString("poster", "");
        return poster.isEmpty() ? null : Uri.parse(poster);
    }

    private Map<String, Long> readIds(String name) {
        Map<String, Long> ids = new HashMap<>();
        try {
            JSONObject json = new JSONObject(prefs().getString(name, "{}"));
            Iterator<String> keys = json.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                ids.put(key, json.getLong(key));
            }
        } catch (JSONException ignored) {
            // Unreadable: treated as nothing published, and published again.
        }
        return ids;
    }

    private void writeIds(String name, Map<String, Long> ids) {
        prefs().edit().putString(name, new JSONObject(ids).toString()).apply();
    }

    /** The app's icon, drawn into a bitmap for the row's logo: a launcher icon may be adaptive, not a file. */
    private static Bitmap logo(Context context) {
        Drawable icon = context.getApplicationInfo().loadIcon(context.getPackageManager());
        int size = 256;
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        icon.setBounds(0, 0, size, size);
        icon.draw(canvas);
        return bitmap;
    }
}
