package app.tvinto.player;

import android.content.Intent;

import androidx.activity.result.ActivityResult;
import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web app's way of asking for the native player.
 *
 * Deliberately one method. The Activity owns everything about playback once it
 * starts -- transport, tracks, subtitles -- because it is a real Android screen
 * and can do all of that better than anything driving it through a bridge. What
 * comes back is the one fact the app above needs and cannot know: where the
 * playhead was when the viewer left.
 *
 * That single return is also why this is `startActivityForResult` rather than
 * an event stream. There is nothing to say while it plays, and a stream of
 * positions across the bridge would be a message every ten seconds that nobody
 * reads until the end.
 */
@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {

    /**
     * The loaded plugin, for a player to send events through.
     *
     * Changing channel inside the player is the
     * one thing that needs saying while playback runs: the player asks, the
     * web app -- which knows the list and builds each address -- answers with
     * switchStream. Only one bridge exists per app, so one instance.
     */
    @Nullable
    private static volatile NativePlayerPlugin loaded = null;

    @Override
    public void load() {
        loaded = this;
    }

    private static void onMain(Runnable work) {
        new android.os.Handler(android.os.Looper.getMainLooper()).post(work);
    }

    /** Tells the web app something about the running player. Dropped when nothing is listening. */
    static void emit(String event, JSObject data) {
        NativePlayerPlugin plugin = loaded;
        if (plugin != null) {
            plugin.notifyListeners(event, data);
        }
    }

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("A url is required");
            return;
        }

        // Which engine. Media3 by default because it is leaner and uses hardware
        // decoding where hardware will have it; VLC when asked, which is what
        // the app does after Media3 has failed to decode something.
        boolean useVlc = "vlc".equalsIgnoreCase(call.getString("engine", "media3"));

        // Cleared before starting, so this play cannot collect the last one's
        // report if the Activity dies before saying anything.
        PlaybackReports.clear();
        // A film or an episode keeps its position while it plays (PlaybackCheckpoint).
        String progressItem = call.getString("progressItemId", "");
        if (progressItem != null && !progressItem.isEmpty()) {
            PlaybackReports.item(progressItem);
        }
        PlaybackCheckpoint.begin(Boolean.TRUE.equals(call.getBoolean("reportProgress", false)));
        lateBanner = null;
        lateChannels = null;

        Intent intent = new Intent(getContext(), useVlc ? VlcPlayerActivity.class : PlayerActivity.class);
        intent.putExtra(PlayerActivity.EXTRA_URL, url);
        intent.putExtra(PlayerActivity.EXTRA_TITLE, call.getString("title", ""));
        intent.putExtra(PlayerActivity.EXTRA_START_AT, call.getInt("startAtSeconds", 0).longValue());
        intent.putExtra(ChannelKeys.EXTRA, Boolean.TRUE.equals(call.getBoolean("channelKeys", false)));
        // Whether the web app will answer channel keys with switchStream, rather
        // than expecting the player to close. A web bundle older than this APK
        // does not send it and keeps the close-and-reopen path.
        intent.putExtra(ChannelKeys.EXTRA_IN_PLAYER, Boolean.TRUE.equals(call.getBoolean("inPlayerSwitching", false)));
        intent.putExtra(ChannelKeys.EXTRA_ITEM_ID, call.getString("itemId", ""));
        intent.putExtra(ChannelKeys.EXTRA_NUMBER, call.getString("channelNumber", ""));
        intent.putExtra(ChannelKeys.EXTRA_NAME, call.getString("channelName", ""));
        intent.putExtra(ChannelKeys.EXTRA_MONOGRAM, call.getString("monogram", ""));
        com.getcapacitor.JSObject banner = call.getObject("banner");
        intent.putExtra(ChannelKeys.EXTRA_BANNER, banner == null ? "" : banner.toString());

        // A film or an episode gets the app's own controls (design section 5b)
        // and says what it is. A web bundle older than this APK sends none of
        // it, and the player keeps Media3's controls as before.
        intent.putExtra(FilmControls.EXTRA_KIND, call.getString("kind", ""));
        intent.putExtra(FilmControls.EXTRA_HEADING, call.getString("heading", ""));
        intent.putExtra(FilmControls.EXTRA_NAME, call.getString("displayTitle", ""));
        intent.putExtra(FilmControls.EXTRA_META, call.getString("meta", ""));
        intent.putExtra(FilmControls.EXTRA_POSTER, call.getString("poster", ""));
        intent.putExtra(FilmControls.EXTRA_OPENING_LINE, call.getString("openingLine", ""));
        intent.putExtra(FilmControls.EXTRA_DESCRIPTION, call.getString("description", ""));
        com.getcapacitor.JSObject upNext = call.getObject("upNext");
        intent.putExtra(FilmControls.EXTRA_UP_NEXT, upNext == null ? "" : upNext.toString());
        com.getcapacitor.JSArray skips = call.getArray("skips");
        intent.putExtra(FilmControls.EXTRA_SKIPS, skips == null ? "" : skips.toString());
        intent.putExtra(FilmControls.EXTRA_SKIP_MODE, call.getString("skipIntros", "button"));
        intent.putExtra(PlayerActivity.EXTRA_SUBTITLE_SCALE, call.getInt("subtitleScale", 100));
        intent.putExtra(PlayerActivity.EXTRA_SUBTITLE_COLOUR, call.getString("subtitleColour", "#ffffff"));
        intent.putExtra(PlayerActivity.EXTRA_SUBTITLE_BACKGROUND, call.getString("subtitleBackground", "translucent"));
        intent.putExtra(PlayerActivity.EXTRA_SUBTITLE_EDGE, call.getString("subtitleEdge", "outline"));
        intent.putExtra(PlayerActivity.EXTRA_AUDIO_LANGUAGE, call.getString("audioLanguage", ""));
        intent.putExtra(PlayerActivity.EXTRA_SUBTITLE_LANGUAGE, call.getString("subtitleLanguage", ""));
        intent.putExtra(PlayerActivity.EXTRA_AUDIO_TITLE, call.getString("audioTitle", ""));
        intent.putExtra(PlayerActivity.EXTRA_LANGUAGE, call.getString("language", "en"));
        intent.putExtra(PlayerActivity.EXTRA_TEXTS, call.getString("texts", ""));
        intent.putExtra(FrameRateMatch.EXTRA, Boolean.TRUE.equals(call.getBoolean("matchFrameRate", false)));
        intent.putExtra(PlayerActivity.EXTRA_SUBTITLE_TITLE, call.getString("subtitleTitle", ""));
        intent.putExtra(
            PlayerActivity.EXTRA_SUBTITLES_ENABLED,
            Boolean.TRUE.equals(call.getBoolean("subtitlesEnabled", false))
        );

        // Subtitles the account added from OpenSubtitles, written to the cache
        // here because neither player takes text.
        intent.putExtra(AddedSubtitles.EXTRA, AddedSubtitles.write(getContext(), call.getArray("subtitles", null)));

        startActivityForResult(call, intent, "playerClosed");
    }

    /**
     * A film or an episode whose player never closed -- the app or the device
     * went down mid-way -- with where it had got to, once; empty when there is
     * none. Read at launch, so the viewing can still be saved.
     */
    @PluginMethod
    public void takeUnfinished(PluginCall call) {
        JSObject held = PlaybackCheckpoint.take(getContext());
        call.resolve(held == null ? new JSObject() : held);
    }

    /**
     * Plays another channel in the player that is already open.
     *
     * The player has not stopped anything yet when it asks: it stops the old
     * stream on receiving this, waits waitMs -- the provider goes on counting
     * a closed stream for a moment -- and then opens the new one. A second
     * call before that replaces the first.
     */
    @PluginMethod
    public void switchStream(PluginCall call) {
        String url = call.getString("url");
        ChannelSession player = ChannelSession.running();
        if (url == null || url.isEmpty() || player == null) {
            call.reject(player == null ? "No player is open" : "A url is required");
            return;
        }

        ChannelSession.Switch order = new ChannelSession.Switch(
            url,
            call.getString("itemId", ""),
            new ChannelOverlay.Target(
                call.getString("channelNumber", ""),
                call.getString("channelName", ""),
                call.getString("monogram", ""),
                call.getString("from", ""),
                call.getString("back", "")
            ),
            call.getData().optLong("waitMs", 1500L),
            call.getData().optInt("attempt", 1),
            ChannelBanner.Info.from(
                call.getString("channelNumber", ""),
                call.getString("channelName", ""),
                call.getString("monogram", ""),
                call.getData().optJSONObject("banner")
            )
        );
        onMain(() -> player.switchTo(order));
        call.resolve();
    }

    /** The banner for a channel, arriving after the player opened. Ignored if the player has moved on. */
    @PluginMethod
    public void updateBanner(PluginCall call) {
        ChannelSession player = ChannelSession.running();
        org.json.JSONObject banner = call.getData().optJSONObject("banner");
        String itemId = call.getString("itemId", "");
        if (banner == null) {
            call.resolve();
            return;
        }
        if (player != null) {
            onMain(() -> player.updateBanner(itemId, banner));
        } else {
            // Sent while the player is still opening: kept for it to collect.
            lateBanner = new Object[] { itemId, banner };
        }
        call.resolve();
    }

    /**
     * The channels number entry and the mini guide can reach (PL-TV-3, PL-TV-4),
     * sent once the device's guide has been read.
     */
    @PluginMethod
    public void setChannels(PluginCall call) {
        org.json.JSONObject directory = call.getData();
        ChannelSession player = ChannelSession.running();
        if (player != null) {
            onMain(() -> player.setDirectory(directory));
        } else {
            lateChannels = directory;
        }
        call.resolve();
    }

    @Nullable
    private static volatile org.json.JSONObject lateChannels = null;

    @Nullable
    static org.json.JSONObject takeLateChannels() {
        org.json.JSONObject held = lateChannels;
        lateChannels = null;
        return held;
    }

    /** A banner that arrived before the player it was for had opened. */
    @Nullable
    private static volatile Object[] lateBanner = null;

    /** The banner kept for this channel, if one arrived early; cleared either way. */
    @Nullable
    static org.json.JSONObject takeLateBanner(String itemId) {
        Object[] held = lateBanner;
        lateBanner = null;
        return held != null && itemId.equals(held[0]) ? (org.json.JSONObject) held[1] : null;
    }

    /** Both attempts failed: the player says so and waits for Back. */
    @PluginMethod
    public void giveUp(PluginCall call) {
        ChannelSession player = ChannelSession.running();
        if (player == null) {
            call.reject("No player is open");
            return;
        }
        String backTo = call.getString("backTo", "");
        onMain(() -> player.showGaveUp(backTo));
        call.resolve();
    }

    /** Closes the player with the failure it last had, for the close-and-reopen path to handle. */
    @PluginMethod
    public void closePlayer(PluginCall call) {
        ChannelSession player = ChannelSession.running();
        if (player != null) {
            onMain(player::closeWithFailure);
        }
        call.resolve();
    }

    /**
     * More of the season for an open player, once the web app has caught up
     * with an episode the player went on to by itself (design board PL-TV-6b).
     */
    /**
     * The show's seasons for the player about to open (PX-TV-3), in a call of
     * their own just before `play`.
     *
     * Not in `play`: Capacitor keeps the options of a call that opens an
     * activity, and Android saves them with the app's state when the player
     * covers it. Supernatural's 327 episodes made that 665 KB, twice over,
     * past Binder's 1 MB -- the app closed each time an episode opened (the
     * owner's television, 29 October). This call resolves at once, so nothing
     * keeps it.
     */
    @PluginMethod
    public void setSeasons(PluginCall call) {
        FilmControls.handSeasons(call.getData());
        call.resolve();
    }

    @PluginMethod
    public void setEpisodesAhead(PluginCall call) {
        FilmControls controls = FilmControls.running();
        if (controls == null) {
            call.reject("No player is open");
            return;
        }
        String itemId = call.getString("itemId", "");
        org.json.JSONObject upNext = call.getObject("upNext");
        onMain(() -> controls.setEpisodesAhead(itemId, upNext));
        call.resolve();
    }

    /**
     * Called when the player screen goes away, however it went.
     *
     * The position is collected from the Activity rather than carried in the
     * result, because the Activity can also be finished by the system -- by the
     * back key, or by Android reclaiming memory -- and those paths never set a
     * result at all. Leaving it somewhere to be picked up covers every way out.
     */
    @ActivityCallback
    private void playerClosed(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }

        PlaybackReports.PlaybackReport report = PlaybackReports.take();
        // The result carries the position from here on.
        PlaybackCheckpoint.finished(getContext());

        JSObject payload = new JSObject();
        payload.put("positionSeconds", report == null ? 0 : report.positionSeconds);
        payload.put("durationSeconds", report == null ? 0 : report.durationSeconds);
        payload.put("errorCode", report == null ? null : report.errorCode);

        // Whether there is a position worth recording. A failure carries one
        // too -- it is where the stream got to before giving up -- but it is
        // not somewhere the viewer chose to stop, so it should not become a
        // resume point.
        payload.put("played", report != null && report.errorCode == null);

        // Which channel was on screen at the end, which after switching inside
        // the player is not the one that was asked for.
        String itemId = PlaybackReports.takeItem();
        payload.put("itemId", itemId == null ? JSObject.NULL : itemId);

        String step = PlaybackReports.takeChannelStep();
        payload.put("channelStep", step == null ? JSObject.NULL : step);

        // The tracks it actually played with, so the app can ask for the same
        // ones next time this item is opened. Left out entirely when the
        // player never said: the app reads absence as "nobody has chosen", and
        // an empty answer would erase what another device remembered.
        PlaybackReports.TrackReport tracks = PlaybackReports.takeTracks();
        if (tracks != null) {
            payload.put("audioLanguage", tracks.audioLanguage);
            payload.put("subtitleLanguage", tracks.subtitleLanguage);
            payload.put("audioTitle", tracks.audioTitle);
            payload.put("subtitleTitle", tracks.subtitleTitle);
            payload.put("subtitlesEnabled", tracks.subtitlesEnabled);
        }

        call.resolve(payload);
    }
}
