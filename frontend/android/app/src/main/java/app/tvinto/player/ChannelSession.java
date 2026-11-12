package app.tvinto.player;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.GestureDetector;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;

import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;

import org.json.JSONException;
import org.json.JSONObject;

import java.lang.ref.WeakReference;

/**
 * Changing channel without leaving the player.
 *
 * Everything about it that is not the video: the keys, Back, swipes on a
 * phone, the switching panel (PL-TV-2), the banner (PL-TV-1), and the
 * conversation with the web app -- which decides what each press means and
 * builds every address. Shared by both players, so Media3 and VLC behave the
 * same; each supplies an {@link Engine} that can stop a stream and open one.
 *
 * Only exists for a live channel opened with `inPlayerSwitching`; without it a
 * channel key closes the player, as before.
 */
final class ChannelSession {

    /** What a player does for the session. Everything is called on the main thread. */
    interface Engine {
        /** Stops the stream and closes its connection, keeping the surface. */
        void stopStream();

        /** Opens this address and plays it. */
        void openStream(String url);

        /** Hands the position to PlaybackReports, as the player's own reporting does. */
        void publishPosition();

        /** Reports this failure as the reason playback ended, and closes. */
        void closeWithFailure(@Nullable String errorCode);

        boolean controlsShowing();

        /** Whether the player has controls of its own to show: Media3 does, VLC has none. */
        boolean hasControls();

        void showControls();

        void hideControls();

        /** Keeps the player's own controls and buffering spinner out of a panel's way. */
        void quietWhileSwitching(boolean switching);

        /** Where swipes and taps land on a phone. */
        @Nullable
        View touchSurface();

        /** Whether the stream has a choice of audio or subtitles to offer (PX-P-3). */
        boolean canChooseTracks();

        /** Where a pause of this channel is (LivePause). */
        ChannelBanner.PauseState pauseState();

        /** Pauses live television, or plays on from where it was paused. */
        void togglePause();

        /** Leaves a pause for the channel as it is now. */
        void backToLive();

        /** The tracks to list and choose in Audio & subtitles (TrackChoices); null before a player exists. */
        @Nullable
        FilmPlayback playback();
    }

    /** What switchStream asked for. */
    static final class Switch {
        final String url;
        final String itemId;
        final ChannelOverlay.Target target;
        final long waitMs;
        final int attempt;
        final ChannelBanner.Info banner;

        Switch(String url, String itemId, ChannelOverlay.Target target, long waitMs, int attempt, ChannelBanner.Info banner) {
            this.url = url;
            this.itemId = itemId;
            this.target = target;
            this.waitMs = Math.max(0L, waitMs);
            this.attempt = attempt;
            this.banner = banner;
        }
    }

    /**
     * Whether Back arrives through OnBackInvokedCallback. It does for this app
     * (targetSdk 36) on Android 16 and later -- and is still dispatched as a
     * key there too, so acting on both closed the player after cancelling.
     * Before 16, without the manifest opt-in, a registered callback is never
     * called and Back is only a key.
     */
    private static final boolean BACK_BY_CALLBACK = Build.VERSION.SDK_INT >= 36;

    /**
     * How far up the subtitles go while the banner is up: clear of the
     * programme's title, which a third of the screen still reached.
     */
    private static final float SUBTITLES_OVER_BANNER = 0.48f;

    /** The open session, for NativePlayerPlugin to hand a switch to. */
    private static volatile WeakReference<ChannelSession> open = new WeakReference<>(null);

    @Nullable
    static ChannelSession running() {
        return open.get();
    }

    private final Activity activity;
    private final Engine engine;
    private final boolean television;
    private final Handler clock = new Handler(Looper.getMainLooper());

    private final ChannelOverlay overlay;
    private final ChannelBanner banner;
    /** PL-TV-3: typing a number. */
    private final NumberEntry numbers;
    /** PL-TV-4: the neighbouring channels, over the video. */
    private final MiniGuide guide;

    /** The channel on screen or being opened, as the web app knows it. */
    private String itemId;

    /** The channel on screen now: the one the preview takes back when the player closes. */
    String currentItemId() {
        return itemId;
    }
    private ChannelOverlay.Target target;

    /** Whether the stream now open came from a switch, whose failures the web app decides about. */
    private boolean switched = false;
    private boolean started = false;
    @Nullable
    private String lastSwitchError = null;

    @Nullable
    private Runnable pendingOpen = null;
    private final Runnable startedWithoutPicture = this::onFirstFrame;
    private long cancelledAt = 0L;
    @Nullable
    private Object backCallback = null;

    /** A session for this player, or null when the web app did not ask for one. */
    @Nullable
    static ChannelSession start(Activity activity, Engine engine) {
        Intent intent = activity.getIntent();
        boolean wanted = intent.getBooleanExtra(ChannelKeys.EXTRA, false)
            && intent.getBooleanExtra(ChannelKeys.EXTRA_IN_PLAYER, false);
        if (!wanted) {
            return null;
        }
        ChannelSession session = new ChannelSession(activity, engine, intent);
        open = new WeakReference<>(session);
        return session;
    }

    private ChannelSession(Activity activity, Engine engine, Intent intent) {
        this.activity = activity;
        this.engine = engine;
        android.app.UiModeManager modes = (android.app.UiModeManager) activity.getSystemService(Activity.UI_MODE_SERVICE);
        this.television = modes != null && modes.getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION;

        itemId = orEmpty(intent.getStringExtra(ChannelKeys.EXTRA_ITEM_ID));
        String number = orEmpty(intent.getStringExtra(ChannelKeys.EXTRA_NUMBER));
        String name = orEmpty(intent.getStringExtra(ChannelKeys.EXTRA_NAME));
        String monogram = orEmpty(intent.getStringExtra(ChannelKeys.EXTRA_MONOGRAM));
        target = new ChannelOverlay.Target(number, name, monogram, "", "");
        PlaybackReports.item(itemId.isEmpty() ? null : itemId);

        overlay = new ChannelOverlay(activity);
        banner = new ChannelBanner(activity, television);
        banner.onHidden = () -> {
            updateBackHandling();
            FilmPlayback playback = engine.playback();
            if (playback != null) {
                playback.liftSubtitles(0f);
            }
        };
        banner.onShown = () -> {
            FilmPlayback playback = engine.playback();
            if (playback != null) {
                playback.liftSubtitles(SUBTITLES_OVER_BANNER);
            }
        };
        choices = new TrackChoices(activity, television, this::updateBackHandling);
        banner.describe(ChannelBanner.Info.from(number, name, monogram, parseJson(intent.getStringExtra(ChannelKeys.EXTRA_BANNER))));

        NumberEntry.Listener chosenByNumber = new NumberEntry.Listener() {
            @Override
            public void chosen(ChannelDirectory.Channel channel) {
                jumpTo(channel);
            }

            @Override
            public void changed() {
                updateBackHandling();
            }
        };
        numbers = new NumberEntry(activity, chosenByNumber);
        guide = new MiniGuide(activity, new MiniGuide.Listener() {
            @Override
            public void chosen(ChannelDirectory.Channel channel) {
                jumpTo(channel);
            }

            @Override
            public void changed() {
                updateBackHandling();
            }
        });
        if (television) {
            banner.offerOnTelevision(this::canChooseTracks, guide::canOpen, engine.pauseState());
        }
        // PX-P-3: a phone's banner carries what a remote has keys for.
        if (!television) {
            banner.offerPauseOnPhone(engine.pauseState(), engine::togglePause, engine::backToLive);
            banner.offerOnPhone(
                guide::canOpen,
                () -> {
                    banner.hide();
                    guide.open(itemId);
                    updateBackHandling();
                },
                this::canChooseTracks,
                () -> {
                    banner.hide();
                    openTracks();
                }
            );
        }

        JSONObject lateChannels = NativePlayerPlugin.takeLateChannels();
        if (lateChannels != null) {
            setDirectory(lateChannels);
        }

        JSONObject late = NativePlayerPlugin.takeLateBanner(itemId);
        if (late != null) {
            updateBanner(itemId, late);
        }

        engine.quietWhileSwitching(false);
        if (!television) {
            listenForSwipes();
        }
    }

    /** Whether the stream now open has shown a picture. */
    boolean started() {
        return started;
    }

    // --- The player tells the session ------------------------------------------

    /** The first frame, or playing for a while with no picture to wait for. */
    void onFirstFrame() {
        clock.removeCallbacks(startedWithoutPicture);
        if (started) {
            return;
        }
        started = true;
        overlay.hide();
        engine.quietWhileSwitching(false);

        // PL-TV-1: four seconds on arrival, the first channel as well as each switch.
        engine.hideControls();
        banner.show();
        updateBackHandling();

        JSObject data = new JSObject();
        data.put("itemId", itemId);
        NativePlayerPlugin.emit("channelStarted", data);
    }

    /** Playing or not, for a stream that may never draw a frame (radio). */
    void onPlaying(boolean playing) {
        clock.removeCallbacks(startedWithoutPicture);
        if (playing && !started) {
            clock.postDelayed(startedWithoutPicture, 1500L);
        }
    }

    /**
     * A failure. Returns true when the session takes it -- a switched stream,
     * about which the web app decides -- and false when the player should end
     * as it always has.
     */
    boolean onFailure(String errorCode) {
        if (!switched) {
            return false;
        }
        lastSwitchError = errorCode;
        engine.stopStream();
        JSObject data = new JSObject();
        data.put("itemId", itemId);
        data.put("errorCode", errorCode);
        NativePlayerPlugin.emit("switchFailed", data);
        return true;
    }

    /**
     * A key. Returns true or false when the session handled it, null when the
     * player should.
     */
    @Nullable
    Boolean onKey(KeyEvent event) {
        int code = event.getKeyCode();
        boolean switching = overlay.isShowing();
        boolean bannerShowing = banner.isShowing();
        boolean press = event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0;
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        boolean controlsShowing = engine.controlsShowing();
        int digit = digitOf(code);
        boolean channelKey = code == KeyEvent.KEYCODE_CHANNEL_UP || code == KeyEvent.KEYCODE_CHANNEL_DOWN;

        if (code == KeyEvent.KEYCODE_BACK && (switching || bannerShowing || numbers.isShowing() || guide.isShowing() || choices.isShowing())) {
            if (press && !BACK_BY_CALLBACK) {
                backInOverlay();
            }
            return true;
        }

        // Audio & subtitles has every key while it is up, as the film's does;
        // a channel key still changes channel, and closes it.
        if (choices.isShowing()) {
            if (channelKey) {
                choices.close();
                updateBackHandling();
            } else {
                choices.onKey(code, down, press);
                return true;
            }
        }

        // PL-TV-4 has the keys while it is up: Up and Down move the highlight
        // and nothing streams until OK.
        if (guide.isShowing()) {
            if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) {
                if (down) {
                    guide.move(code == KeyEvent.KEYCODE_DPAD_UP ? -1 : 1);
                }
                return true;
            }
            if (isOk(code)) {
                if (press) {
                    guide.choose();
                }
                return true;
            }
            if (digit >= 0) {
                if (press) {
                    guide.close();
                    numbers.digit(digit);
                }
                return true;
            }
            if (channelKey) {
                // Closes the guide and switches directly.
                if (press) {
                    guide.close();
                    requestChannel(code == KeyEvent.KEYCODE_CHANNEL_UP ? ChannelKeys.NEXT : ChannelKeys.PREVIOUS);
                }
                return true;
            }
            return true;
        }

        // PL-TV-3 has digits, OK and Back; a channel key cancels it and steps
        // from the channel playing.
        if (numbers.isShowing()) {
            if (digit >= 0) {
                if (press) {
                    numbers.digit(digit);
                }
                return true;
            }
            if (isOk(code)) {
                if (press) {
                    numbers.commit();
                }
                return true;
            }
            if (ChannelKeys.stepFor(code, false) == null) {
                return true;
            }
            if (press) {
                numbers.close();
            }
        }

        // Also part way through a switch: a number typed then chooses again, as a channel key would.
        if (digit >= 0) {
            if (press) {
                banner.hide();
                numbers.digit(digit);
            }
            return true;
        }

        // The details' actions on a television: Left and Right between them,
        // rather than the mini guide, while they show.
        if ((code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT)
            && !switching && bannerShowing && banner.isShowingDetails() && banner.hasActions()) {
            if (down) {
                banner.moveAction(code == KeyEvent.KEYCODE_DPAD_LEFT ? -1 : 1);
            }
            return true;
        }

        if ((code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) && !switching && !controlsShowing && guide.canOpen()) {
            if (press) {
                banner.hide();
                guide.open(itemId);
            }
            return true;
        }

        if (code == KeyEvent.KEYCODE_BACK && (switching || bannerShowing)) {
            if (press && !BACK_BY_CALLBACK) {
                backInOverlay();
            }
            return true;
        }

        String step = ChannelKeys.stepFor(code, controlsShowing && !switching);
        if (step != null) {
            if (press) {
                // The banner never swallows a press: it goes, and the key acts.
                banner.hide();
                requestChannel(step);
            }
            return true;
        }

        if (switching || controlsShowing) {
            return null;
        }

        boolean ok = isOk(code);
        if (ok || code == KeyEvent.KEYCODE_INFO) {
            if (press) {
                if (ok && bannerShowing && banner.isShowingDetails() && banner.hasActions()) {
                    // A television's details end in actions: OK presses the
                    // one in focus. Back puts the banner away.
                    act(banner.focusedAction());
                } else if (bannerShowing && !banner.isShowingDetails() && (banner.hasDetails() || banner.hasActions())) {
                    // A second OK or Info: the details of what is on now
                    // (asked for by 25 September). Menu still
                    // brings the player's own controls.
                    banner.showDetails();
                    updateBackHandling();
                } else if (bannerShowing) {
                    // A third press, or a second on a channel with no guide:
                    // it goes. With no details to show, OK brings the
                    // player's own controls as it always did.
                    boolean hadDetails = banner.isShowingDetails();
                    banner.hide();
                    // A phone's channel with no guide: OK brings the player's
                    // own controls. A television has its actions instead.
                    if (ok && !hadDetails && !television) {
                        engine.showControls();
                    }
                } else {
                    banner.show();
                    updateBackHandling();
                }
            }
            return true;
        }

        if (code == KeyEvent.KEYCODE_MENU) {
            if (press) {
                if (television && banner.hasActions()) {
                    // The actions, as a second OK shows them: Audio &
                    // subtitles, the guide, the sleep timer.
                    banner.show();
                    banner.showDetails();
                    updateBackHandling();
                } else {
                    banner.hide();
                    engine.showControls();
                }
            }
            return true;
        }

        if (bannerShowing && press) {
            banner.hide();
        }
        return null;
    }

    void destroy() {
        choices.close();
        numbers.close();
        guide.close();
        clock.removeCallbacks(startedWithoutPicture);
        if (pendingOpen != null) {
            clock.removeCallbacks(pendingOpen);
            pendingOpen = null;
        }
        banner.hide();
        if (open.get() == this) {
            open = new WeakReference<>(null);
        }
    }

    // --- The web app tells the session ------------------------------------------

    /**
     * Stops what is playing, says where it is going, and opens it after the wait.
     *
     * The old stream is stopped here, on the answer rather than on the key,
     * so the wait counts from the moment its connection closed -- which the
     * provider's single connection needs. A second switch before the wait is
     * over replaces the first; if the first had already started opening,
     * stopping again closes that too.
     */
    void switchTo(Switch order) {
        if (activity.isFinishing()) {
            return;
        }
        if (pendingOpen != null) {
            clock.removeCallbacks(pendingOpen);
        }
        clock.removeCallbacks(startedWithoutPicture);

        engine.stopStream();

        itemId = order.itemId;
        target = order.target;
        banner.hide();
        banner.describe(order.banner);
        switched = true;
        started = false;
        lastSwitchError = null;
        PlaybackReports.item(itemId.isEmpty() ? null : itemId);

        overlay.showSwitching(order.target, order.attempt);
        engine.quietWhileSwitching(true);
        updateBackHandling();

        android.util.Log.i("TvintoPlayer", "Switching to " + PlayerActivity.safeToLog(order.url) + " after " + order.waitMs + " ms");
        pendingOpen = () -> {
            pendingOpen = null;
            engine.openStream(order.url);
        };
        clock.postDelayed(pendingOpen, order.waitMs);
    }

    /** The channels number entry and the mini guide can reach, from the web app. */
    void setDirectory(JSONObject json) {
        ChannelDirectory directory = ChannelDirectory.from(json);
        this.directory = directory;
        numbers.setDirectory(directory);
        guide.setDirectory(directory);
    }

    /** What is on, for the channel on screen, when it arrives late. */
    void updateBanner(String forItem, JSONObject data) {
        if (!forItem.equals(itemId)) {
            return;
        }
        banner.describe(ChannelBanner.Info.from(target.number, target.name, target.monogram, data));
    }

    /** Both attempts refused: the still strip, and where Back goes. */
    void showGaveUp(String backTo) {
        overlay.showGaveUp(target, backTo);
        engine.quietWhileSwitching(true);
        updateBackHandling();
    }

    /** Leaves the player with the switched stream's failure, for the close-and-reopen path. */
    void closeWithFailure() {
        engine.closeWithFailure(lastSwitchError);
    }

    // --- Inside -----------------------------------------------------------------

    /** The channels number entry and the mini guide reach, once the web app has sent them. */
    @Nullable
    private ChannelDirectory directory = null;

    /**
     * A reminder's channel, watched from its banner: switched to as a channel
     * chosen in the mini guide is. False when this player cannot reach it,
     * for the app to open it instead; true for the channel already on.
     */
    boolean switchToItem(String wanted) {
        if (wanted.equals(itemId)) {
            return true;
        }
        int index = directory == null ? -1 : directory.indexOf(wanted);
        if (index < 0) {
            return false;
        }
        jumpTo(directory.channels.get(index));
        return true;
    }

    /** A channel chosen by number or in the mini guide: the web app switches to it, as for a key. */
    private void jumpTo(ChannelDirectory.Channel channel) {
        if (channel.itemId.equals(itemId)) {
            return;
        }
        engine.publishPosition();
        JSObject data = new JSObject();
        data.put("step", "jump");
        data.put("to", channel.itemId);
        data.put("itemId", itemId);
        data.put("started", started);
        NativePlayerPlugin.emit("channelRequested", data);
    }

    private static boolean isOk(int code) {
        return code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
    }

    /** 0-9 from the remote's digits or a keypad, or -1. */
    private static int digitOf(int code) {
        if (code >= KeyEvent.KEYCODE_0 && code <= KeyEvent.KEYCODE_9) {
            return code - KeyEvent.KEYCODE_0;
        }
        if (code >= KeyEvent.KEYCODE_NUMPAD_0 && code <= KeyEvent.KEYCODE_NUMPAD_9) {
            return code - KeyEvent.KEYCODE_NUMPAD_0;
        }
        return -1;
    }

    private void requestChannel(String step) {
        engine.publishPosition();
        JSObject data = new JSObject();
        data.put("step", step);
        data.put("itemId", itemId);
        data.put("started", started);
        NativePlayerPlugin.emit("channelRequested", data);
    }

    /** Audio & subtitles, opened from the banner: a panel on a television, a sheet on a phone. */
    private final TrackChoices choices;

    private boolean canChooseTracks() {
        return engine.playback() != null && engine.canChooseTracks();
    }

    private void openTracks() {
        FilmPlayback playback = engine.playback();
        if (playback != null) {
            choices.open(playback);
            updateBackHandling();
        }
    }

    /** One of the details' actions: pause or play, back to live, audio and subtitles, the guide, or the sleep timer's list. */
    private void act(int action) {
        long programmeEnd = banner.programmeEnd();
        banner.hide();
        if (action == ChannelBanner.ACTION_PAUSE) {
            engine.togglePause();
            return;
        }
        if (action == ChannelBanner.ACTION_LIVE) {
            engine.backToLive();
            return;
        }
        if (action == ChannelBanner.ACTION_TRACKS) {
            openTracks();
            return;
        }
        if (action == ChannelBanner.ACTION_GUIDE) {
            if (guide.canOpen()) {
                guide.open(itemId);
                updateBackHandling();
            }
            return;
        }
        SleepTimerPanel panel = SleepTimerPanel.of(activity);
        if (panel != null) {
            panel.openList(programmeEnd, null, null);
        }
    }

    /** Back while something is drawn over the video: cancel the switch, or put the banner away. */
    private void backInOverlay() {
        if (choices.isShowing()) {
            choices.close();
            updateBackHandling();
            return;
        }
        if (guide.isShowing()) {
            guide.close();
            return;
        }
        if (numbers.isShowing()) {
            numbers.back();
            return;
        }
        if (overlay.isShowing()) {
            // Once per press, however many ways the press arrived.
            long now = SystemClock.uptimeMillis();
            if (now - cancelledAt < 500L) {
                return;
            }
            cancelledAt = now;
            requestChannel("cancel");
        } else if (banner.isShowing()) {
            banner.hide();
        }
    }

    /** Whether more than the plain banner is over the picture: then Left and Right are its, not a step behind live. */
    boolean showingMoreThanBanner() {
        return overlay.isShowing() || banner.isShowingDetails() || numbers.isShowing() || guide.isShowing() || choices.isShowing();
    }

    /** Whether anything of the session's is drawn over the picture: then OK is its, not a paused channel's. */
    boolean showingAnything() {
        return overlay.isShowing() || banner.isShowing() || numbers.isShowing() || guide.isShowing() || choices.isShowing();
    }

    /** Takes Back for the overlays while any is showing, and gives it back when none is. */
    private void updateBackHandling() {
        if (!BACK_BY_CALLBACK) {
            return;
        }
        boolean wanted = overlay.isShowing() || banner.isShowing() || numbers.isShowing() || guide.isShowing() || choices.isShowing();
        android.window.OnBackInvokedDispatcher dispatcher = activity.getOnBackInvokedDispatcher();
        if (wanted && backCallback == null) {
            android.window.OnBackInvokedCallback callback = this::backInOverlay;
            dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_OVERLAY, callback);
            backCallback = callback;
        } else if (!wanted && backCallback != null) {
            dispatcher.unregisterOnBackInvokedCallback((android.window.OnBackInvokedCallback) backCallback);
            backCallback = null;
        }
    }

    /**
     * PL-P-1 on a phone: a swipe up or down changes channel, a tap shows the
     * banner, and a tap with the banner up hides it and shows the controls.
     */
    private void listenForSwipes() {
        View surface = engine.touchSurface();
        if (surface == null) {
            return;
        }
        float reach = 60f * activity.getResources().getDisplayMetrics().density;
        GestureDetector gestures = new GestureDetector(activity, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent event) {
                return true;
            }

            @Override
            public boolean onFling(@Nullable MotionEvent start, MotionEvent end, float velocityX, float velocityY) {
                if (start == null) {
                    return false;
                }
                float dy = end.getY() - start.getY();
                float dx = end.getX() - start.getX();
                if (Math.abs(dy) < reach || Math.abs(dy) < Math.abs(dx)) {
                    return false;
                }
                banner.hide();
                requestChannel(dy < 0 ? ChannelKeys.NEXT : ChannelKeys.PREVIOUS);
                return true;
            }

            @Override
            public boolean onSingleTapConfirmed(MotionEvent event) {
                if (overlay.isShowing()) {
                    return true;
                }
                if (banner.isShowing()) {
                    banner.hide();
                    engine.showControls();
                } else if (engine.controlsShowing()) {
                    engine.hideControls();
                } else {
                    banner.show();
                    updateBackHandling();
                }
                return true;
            }
        });
        surface.setOnTouchListener((view, event) -> {
            gestures.onTouchEvent(event);
            // Every touch is this session's to answer, and no click is passed
            // on: Media3's PlayerView answers a click by toggling its own
            // controls, which came up beside the banner the same tap had shown,
            // or were hidden again by it.
            return true;
        });
    }

    private static String orEmpty(@Nullable String value) {
        return value == null ? "" : value;
    }

    @Nullable
    private static JSONObject parseJson(@Nullable String json) {
        if (json == null || json.isEmpty()) {
            return null;
        }
        try {
            return new JSONObject(json);
        } catch (JSONException ignored) {
            return null;
        }
    }
}
