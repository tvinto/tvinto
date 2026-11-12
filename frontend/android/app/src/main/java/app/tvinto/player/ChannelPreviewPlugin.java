package app.tvinto.player;

import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.lifecycle.Lifecycle;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * A channel playing in a small window over the guide while it is browsed, as
 * TiviMate does.
 *
 * The page keeps an empty box where the picture belongs and tells this where
 * it is; a Media3 player is put over the WebView at that rectangle. It never
 * takes focus -- the remote stays in the guide -- and nothing in the page can
 * be drawn over it, so the page hides it before opening anything on top.
 *
 * One player at most, and the provider allows one connection: `show` stops
 * whatever was playing before it asks for the next channel, `hide` releases
 * the player entirely before it answers, so the full player that follows
 * never overlaps it. The page decides when to show -- after the remote has
 * rested on a channel -- and this only does what it is told.
 */
@CapacitorPlugin(name = "ChannelPreview")
public class ChannelPreviewPlugin extends Plugin {

    private ExoPlayer player;
    private PlayerView view;
    private Player.Listener listener;
    /** The address playing, for the full player to know it may take this one over. */
    private String playing;

    /** Where the box was last, in screen pixels: where a player handed back goes. */
    private int[] lastArea;

    /** The one preview there is, for PlayerActivity to take its player from (`takeOver`). */
    private static ChannelPreviewPlugin current;

    @Override
    public void load() {
        current = this;
    }

    /**
     * The preview's player, still playing `url`, handed to the full player
     * instead of being released -- TiviMate's second press: the picture goes
     * full screen without the stream being opened again, which on a
     * one-connection subscription is the difference between a channel that
     * plays and one the provider refuses. Null unless the preview is playing
     * exactly that address. Called on the main thread, from PlayerActivity.
     */
    public static ExoPlayer takeOver(String url) {
        ChannelPreviewPlugin preview = current;
        if (preview == null || preview.player == null || url == null || !url.equals(preview.playing)
            || preview.player.getPlayerError() != null || preview.player.getPlaybackState() == Player.STATE_IDLE) {
            return null;
        }
        ExoPlayer taken = preview.player;
        if (preview.listener != null) {
            taken.removeListener(preview.listener);
        }
        if (preview.view != null) {
            preview.view.setPlayer(null);
            ViewGroup parent = (ViewGroup) preview.view.getParent();
            if (parent != null) {
                parent.removeView(preview.view);
            }
        }
        preview.player = null;
        preview.view = null;
        preview.listener = null;
        preview.playing = null;
        preview.pictured = false;
        preview.notifyListeners("previewState", state("taken", ""));
        return taken;
    }
    /** Whether a picture has arrived for the channel now asked for: until then an HTTP refusal is final. */
    private boolean pictured = false;

    /**
     * Plays `url` in the rectangle x, y, width, height, in the page's CSS
     * pixels, times `scale` (the page's devicePixelRatio). Resolves once
     * asked; `previewState` events say playing or failed.
     */
    @PluginMethod
    public void show(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("A url is required");
            return;
        }
        double scale = call.getData().optDouble("scale", 1.0);
        int x = (int) Math.round(call.getData().optDouble("x", 0) * scale);
        int y = (int) Math.round(call.getData().optDouble("y", 0) * scale);
        int width = (int) Math.round(call.getData().optDouble("width", 0) * scale);
        int height = (int) Math.round(call.getData().optDouble("height", 0) * scale);
        if (width <= 0 || height <= 0) {
            call.reject("An area is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            // Not behind the full player. OK twice in quick succession sent
            // this after the second OK had opened the channel full screen:
            // the preview then opened the same channel a second time behind
            // it, on a one-connection subscription, and took the sound -- the
            // full player paused itself (a user's TV, 24 October).
            if (!getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) {
                call.reject("The app is not in front");
                return;
            }
            try {
                place(x, y, width, height);
                lastArea = new int[] { x, y, width, height };
                pictured = false;
                player.stop();
                playing = url;
                player.setMediaItem(MediaItem.fromUri(url));
                player.prepare();
                player.setPlayWhenReady(true);
                call.resolve();
            } catch (Exception failure) {
                call.reject("Could not start the preview (" + failure.getClass().getSimpleName() + ")");
            }
        });
    }

    /**
     * Moves the window to the box's new place, in the same terms as `show`,
     * and nothing else: the stream plays on. The box moves when the guide
     * makes room for the category list, and the window stayed where the box
     * had been, over the menu (a user's TV, 24 October).
     */
    @PluginMethod
    public void move(PluginCall call) {
        double scale = call.getData().optDouble("scale", 1.0);
        int x = (int) Math.round(call.getData().optDouble("x", 0) * scale);
        int y = (int) Math.round(call.getData().optDouble("y", 0) * scale);
        int width = (int) Math.round(call.getData().optDouble("width", 0) * scale);
        int height = (int) Math.round(call.getData().optDouble("height", 0) * scale);
        if (width <= 0 || height <= 0) {
            call.reject("An area is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (view != null) {
                place(x, y, width, height);
            }
            lastArea = new int[] { x, y, width, height };
            call.resolve();
        });
    }

    /** Stops and lets the connection go, removing the window. Resolves once released. */
    @PluginMethod
    public void hide(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            release();
            call.resolve();
        });
    }

    /**
     * The full player's player, handed back when it closes onto the guide:
     * TiviMate's return, the channel still playing in the box -- and still
     * on the one connection, never opened again. `itemId` is the channel it
     * ended on, which may not be the one it began with. False when there is
     * no box to put it in; the full player then releases it as before.
     * Called on the main thread, from PlayerActivity.
     */
    public static boolean giveBack(ExoPlayer returned, String url, String itemId) {
        ChannelPreviewPlugin preview = current;
        if (preview == null || preview.lastArea == null || preview.player != null || returned == null) {
            return false;
        }
        try {
            preview.player = returned;
            preview.playing = url;
            preview.pictured = true;
            int[] area = preview.lastArea;
            preview.place(area[0], area[1], area[2], area[3]);
            preview.listen(returned);
            returned.setPlayWhenReady(true);
            preview.notifyListeners("previewState", state("returned", itemId == null ? "" : itemId));
            return true;
        } catch (Exception failure) {
            preview.player = null;
            preview.playing = null;
            return false;
        }
    }

    @Override
    protected void handleOnStop() {
        // The app going to the background takes the preview with it, and the
        // connection. On stop rather than on pause: opening the full player
        // pauses this activity first, before the player can take the preview
        // over, and only stops it after.
        if (player != null) {
            release();
            notifyListeners("previewState", state("stopped", ""));
        }
        super.handleOnStop();
    }

    @Override
    protected void handleOnDestroy() {
        release();
        super.handleOnDestroy();
    }

    private void place(int x, int y, int width, int height) {
        View web = getBridge().getWebView();
        int[] origin = new int[2];
        web.getLocationInWindow(origin);
        ViewGroup root = getActivity().findViewById(android.R.id.content);
        int[] rootOrigin = new int[2];
        root.getLocationInWindow(rootOrigin);

        // Placed at the corner and moved by translation: a move is then only
        // drawn again, where new layout parameters laid out the whole
        // activity, the WebView with it, every time the guide moved the box
        // (the owner's TV lagged going to the categories, 10 November). Only
        // a new size is laid out.
        float left = origin[0] - rootOrigin[0] + x;
        float top = origin[1] - rootOrigin[1] + y;
        FrameLayout.LayoutParams area = new FrameLayout.LayoutParams(width, height);

        if (view == null) {
            view = new PlayerView(getContext());
            view.setUseController(false);
            view.setFocusable(false);
            view.setFocusableInTouchMode(false);
            view.setClickable(false);
            view.setShutterBackgroundColor(Color.BLACK);
            view.setBackgroundColor(Color.BLACK);
            view.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
            view.setKeepContentOnPlayerReset(false);
            root.addView(view, area);
        } else if (view.getLayoutParams() == null || view.getLayoutParams().width != width || view.getLayoutParams().height != height) {
            view.setLayoutParams(area);
        }
        view.setTranslationX(left);
        view.setTranslationY(top);

        if (player == null) {
            player = build();
        }
        view.setPlayer(player);
    }

    private ExoPlayer build() {
        // As the full player's: patient with a slow provider, and while nothing
        // has played an HTTP refusal is final -- each retry is one more request
        // on a one-connection subscription.
        androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy loadErrors =
            new androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy() {
                @Override
                public long getRetryDelayMsFor(LoadErrorInfo info) {
                    if (!pictured && info.exception instanceof androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) {
                        return C.TIME_UNSET;
                    }
                    return super.getRetryDelayMsFor(info);
                }
            };
        androidx.media3.datasource.DefaultHttpDataSource.Factory http =
            new androidx.media3.datasource.DefaultHttpDataSource.Factory()
                .setConnectTimeoutMs(15_000)
                .setReadTimeoutMs(20_000);
        ExoPlayer made = new ExoPlayer.Builder(
            getContext(),
            new androidx.media3.exoplayer.DefaultRenderersFactory(getContext()).setEnableDecoderFallback(true)
        )
            .setMediaSourceFactory(
                new androidx.media3.exoplayer.source.DefaultMediaSourceFactory(
                    new androidx.media3.datasource.DefaultDataSource.Factory(getContext(), http)
                ).setLoadErrorHandlingPolicy(loadErrors)
            )
            .build();
        listen(made);
        return made;
    }

    /** Tells the page when a picture arrives and when the stream fails. */
    private void listen(ExoPlayer target) {
        listener = new Player.Listener() {
            @Override
            public void onRenderedFirstFrame() {
                pictured = true;
                notifyListeners("previewState", state("playing", ""));
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                notifyListeners("previewState", state("failed", error.getErrorCodeName()));
            }
        };
        target.addListener(listener);
    }

    private void release() {
        if (player != null) {
            player.stop();
            player.release();
            player = null;
        }
        if (view != null) {
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) {
                parent.removeView(view);
            }
            view = null;
        }
        pictured = false;
        playing = null;
        listener = null;
    }

    private static JSObject state(String state, String detail) {
        JSObject result = new JSObject();
        result.put("state", state);
        result.put("detail", detail);
        return result;
    }
}
