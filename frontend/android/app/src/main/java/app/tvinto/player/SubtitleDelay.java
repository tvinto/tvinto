package app.tvinto.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Looper;

import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlaybackException;
import androidx.media3.exoplayer.ForwardingRenderer;
import androidx.media3.exoplayer.Renderer;
import androidx.media3.exoplayer.text.TextOutput;

import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Subtitles earlier or later, for the subtitles a stream carries itself.
 *
 * Added subtitles have their cue times shifted before they are handed over
 * (stage 6); a track inside the stream cannot be. VLC has a setting for it.
 * Media3 has none, so its text renderers are told a clock shifted by the
 * delay: rendering at an earlier moment shows each line later, at a later
 * moment earlier -- as far as the player has the subtitles buffered ahead,
 * which is normally tens of seconds. The rest of the player keeps its own
 * clock.
 *
 * Kept per film or episode on this device, not on the account: a delay
 * belongs to one stream more than to one person.
 */
final class SubtitleDelay {

    /** One press of Earlier or Later. */
    static final long STEP_MS = 100L;

    /** Half a minute either way: more than any stream needs, and a stop on a key held down too long. */
    static final long LIMIT_MS = 30_000L;

    private static final String PREFERENCES = "subtitle_delay";

    /** How many films' delays are kept before the oldest go. */
    private static final int KEPT = 200;

    private SubtitleDelay() {}

    /** The delay in use, read by Media3's playback thread as it renders. */
    static final class Shift {
        private final AtomicLong micros = new AtomicLong(0L);

        long ms() {
            return micros.get() / 1000L;
        }

        void setMs(long ms) {
            micros.set(clamp(ms) * 1000L);
        }

        long micros() {
            return micros.get();
        }
    }

    /** Media3's renderers, the text ones on the shifted clock. */
    static DefaultRenderersFactory renderers(Context context, Shift shift) {
        return new DefaultRenderersFactory(context) {
            @Override
            protected void buildTextRenderers(
                Context context,
                TextOutput output,
                Looper outputLooper,
                int extensionRendererMode,
                ArrayList<Renderer> out
            ) {
                ArrayList<Renderer> built = new ArrayList<>();
                super.buildTextRenderers(context, output, outputLooper, extensionRendererMode, built);
                for (Renderer renderer : built) {
                    out.add(new Shifted(renderer, shift));
                }
            }
        };
    }

    /** A text renderer that sees the clock as it would be if the subtitles were that much late. */
    private static final class Shifted extends ForwardingRenderer {
        private final Shift shift;

        Shifted(Renderer renderer, Shift shift) {
            super(renderer);
            this.shift = shift;
        }

        @Override
        public void render(long positionUs, long elapsedRealtimeUs) throws ExoPlaybackException {
            super.render(positionUs - shift.micros(), elapsedRealtimeUs);
        }

        @Override
        public void resetPosition(long positionUs, boolean sampleStreamIsResetToKeyFrame) throws ExoPlaybackException {
            super.resetPosition(positionUs - shift.micros(), sampleStreamIsResetToKeyFrame);
        }
    }

    static long clamp(long ms) {
        return Math.max(-LIMIT_MS, Math.min(LIMIT_MS, ms));
    }

    /** "+0.5 s", "−1.2 s", "0.0 s": tenths, with the sign that says which way. */
    static String label(long ms) {
        return Texts.t("film.subtitleTiming", amount(ms));
    }

    /** "+0.5", "−1.0" or "0.0": the amount alone, where the line already says what it is (PX-TV-5). */
    static String amount(long ms) {
        String number = String.format(Locale.ROOT, "%.1f", Math.abs(ms) / 1000.0);
        String sign = ms > 0 ? "+" : ms < 0 ? "−" : "";
        return sign + number;
    }

    /** The delay kept for this film or episode on this device, or 0. */
    static long load(Context context, String itemId) {
        if (itemId == null || itemId.isEmpty()) {
            return 0L;
        }
        return clamp(preferences(context).getLong(itemId, 0L));
    }

    /** Keeps it; 0 is kept as nothing. */
    static void store(Context context, String itemId, long ms) {
        if (itemId == null || itemId.isEmpty()) {
            return;
        }
        SharedPreferences preferences = preferences(context);
        SharedPreferences.Editor edit = preferences.edit();
        if (ms == 0L) {
            edit.remove(itemId);
        } else {
            edit.putLong(itemId, clamp(ms));
            // A small drawer: past the limit, everything goes but this one --
            // simpler than an order, and a delay is quick to set again.
            if (preferences.getAll().size() > KEPT) {
                edit.clear().putLong(itemId, clamp(ms));
            }
        }
        edit.apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
