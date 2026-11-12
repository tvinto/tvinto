package app.tvinto.player;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.view.Display;
import android.view.WindowManager;

import androidx.annotation.Nullable;

/**
 * The television's refresh rate, matched to the video.
 *
 * A screen running at 60 Hz shows 25 frames a second unevenly -- some for
 * three refreshes, some for two -- and a pan across a football pitch or a
 * film's slow camera move judders with it. European channels are 25 or 50,
 * films mostly 23.976 or 24. So once the stream's rate is known, the window
 * asks for the display mode that fits it, at the resolution the screen is
 * already in; the system switches, and the screen goes dark for a moment as
 * it does. When the player closes, its window goes and the screen returns to
 * the mode the rest of the app runs in.
 *
 * The rate is taken from the stream when it says (an HLS playlist, a film's
 * container), and otherwise measured: live MPEG-TS seldom declares one, but
 * every frame carries a presentation time, and sixty of them settle it.
 *
 * Nothing changes when the screen has no mode that fits, or when the mode it
 * is in fits already -- changing between two 50 Hz channels costs no blink.
 * Only on a television, and only when the app asked (the setting on Account).
 */
final class FrameRateMatch {

    /** Whether the app asked for it; a television's setting, sent with each play. */
    static final String EXTRA = "matchFrameRate";

    /** Frames skipped after a stream opens, while timing settles. */
    private static final int SKIP_FRAMES = 10;
    /** Frames timed for a measurement. */
    private static final int TIMED_FRAMES = 60;
    /** A gap this long between two frames is a discontinuity, not a rate. */
    private static final long GAP_US = 250_000L;

    /** The rates video comes in, for a measurement to settle on. */
    private static final float[] STANDARD = { 23.976f, 24f, 25f, 29.97f, 30f, 47.952f, 48f, 50f, 59.94f, 60f };

    /**
     * How far a refresh rate may be from a multiple of the video's and still
     * fit it. Wide enough for 59.94 against 60 to be told apart (0.1%) only by
     * preference, not refused; narrow enough that 25 never fits 24.
     */
    private static final float TOLERANCE = 0.002f;

    /** Below this a mode flickers in menus on some sets: 50 is chosen over 25 when both fit. */
    private static final float PREFERRED_MINIMUM_HZ = 47f;

    private final Activity activity;
    private final boolean enabled;
    private final Handler main = new Handler(Looper.getMainLooper());

    // Measurement, on the playback thread.
    private int seen = 0;
    private int timed = 0;
    private long firstUs = 0L;
    private long previousUs = 0L;
    private volatile boolean settled = false;

    private FrameRateMatch(Activity activity, boolean enabled) {
        this.activity = activity;
        this.enabled = enabled;
    }

    static FrameRateMatch start(Activity activity) {
        boolean asked = activity.getIntent().getBooleanExtra(EXTRA, false);
        return new FrameRateMatch(activity, asked && isTelevision(activity));
    }

    /** A new stream: its rate is found again. The mode stays as it is until then. */
    synchronized void restart() {
        seen = 0;
        timed = 0;
        settled = false;
    }

    /**
     * A frame about to be shown, from the playback thread. The rate the stream
     * declared, when it declared one, settles it at once.
     */
    void onFrame(long presentationTimeUs, float declaredRate) {
        if (!enabled || settled) {
            return;
        }
        if (declaredRate > 1f) {
            settle(snap(declaredRate));
            return;
        }
        float measured;
        synchronized (this) {
            seen++;
            if (seen <= SKIP_FRAMES) {
                previousUs = presentationTimeUs;
                return;
            }
            long step = presentationTimeUs - previousUs;
            previousUs = presentationTimeUs;
            if (step <= 0 || step > GAP_US) {
                // A jump in the timeline: start the count again from here.
                timed = 0;
            }
            if (timed == 0) {
                firstUs = presentationTimeUs;
            }
            timed++;
            if (timed < TIMED_FRAMES) {
                return;
            }
            measured = (timed - 1) * 1_000_000f / (presentationTimeUs - firstUs);
        }
        settle(snap(measured));
    }

    /** The rate a player read from the stream itself (VLC's video track). */
    void onDeclaredRate(float rate) {
        if (enabled && !settled && rate > 1f) {
            settle(snap(rate));
        }
    }

    private void settle(float rate) {
        settled = true;
        main.post(() -> apply(rate));
    }

    private void apply(float rate) {
        if (activity.isFinishing() || activity.isDestroyed()) {
            return;
        }
        Display display = activity.getWindowManager().getDefaultDisplay();
        Mode current = Mode.of(display.getMode());
        Display.Mode[] supported = display.getSupportedModes();
        Mode[] modes = new Mode[supported.length];
        for (int i = 0; i < supported.length; i++) {
            modes[i] = Mode.of(supported[i]);
        }
        Mode best = bestMode(modes, current, rate);
        if (best == null) {
            android.util.Log.i("TvintoPlayer", String.format(java.util.Locale.ROOT,
                "No display mode fits %.3f fps; staying at %.3f Hz", rate, current.rate));
            return;
        }
        if (best.id == current.id) {
            android.util.Log.i("TvintoPlayer", String.format(java.util.Locale.ROOT,
                "%.3f fps already fits %.3f Hz", rate, current.rate));
            return;
        }
        android.util.Log.i("TvintoPlayer", String.format(java.util.Locale.ROOT,
            "Display to %.3f Hz for %.3f fps (was %.3f Hz)", best.rate, rate, current.rate));
        WindowManager.LayoutParams attributes = activity.getWindow().getAttributes();
        attributes.preferredDisplayModeId = best.id;
        activity.getWindow().setAttributes(attributes);
    }

    /**
     * The mode to ask for: the screen's own resolution, a refresh rate that is
     * a whole multiple of the video's, 47 Hz or more where there is the choice,
     * then the closest fit, then the lowest rate. The mode already in use when
     * it fits as well as the best does, so as not to blink for nothing. Null
     * when nothing fits.
     */
    @Nullable
    static Mode bestMode(Mode[] modes, Mode current, float rate) {
        Mode best = null;
        float bestMiss = 0f;
        for (Mode mode : modes) {
            if (mode.width != current.width || mode.height != current.height) {
                continue;
            }
            float miss = miss(mode.rate, rate);
            if (miss > TOLERANCE) {
                continue;
            }
            if (best == null || better(mode, miss, best, bestMiss)) {
                best = mode;
                bestMiss = miss;
            }
        }
        if (best != null && best.id != current.id) {
            float currentMiss = miss(current.rate, rate);
            boolean sameClass = (current.rate >= PREFERRED_MINIMUM_HZ) == (best.rate >= PREFERRED_MINIMUM_HZ);
            if (currentMiss <= bestMiss && sameClass) {
                return current;
            }
        }
        return best;
    }

    private static boolean better(Mode mode, float miss, Mode best, float bestMiss) {
        boolean high = mode.rate >= PREFERRED_MINIMUM_HZ;
        boolean bestHigh = best.rate >= PREFERRED_MINIMUM_HZ;
        if (high != bestHigh) {
            return high;
        }
        if (Math.abs(miss - bestMiss) > 0.0001f) {
            return miss < bestMiss;
        }
        return mode.rate < best.rate;
    }

    /** A display mode, as far as choosing one goes -- apart from Display.Mode, so it can be tested. */
    static final class Mode {
        final int id;
        final int width;
        final int height;
        final float rate;

        Mode(int id, int width, int height, float rate) {
            this.id = id;
            this.width = width;
            this.height = height;
            this.rate = rate;
        }

        static Mode of(Display.Mode mode) {
            return new Mode(mode.getModeId(), mode.getPhysicalWidth(), mode.getPhysicalHeight(), mode.getRefreshRate());
        }
    }

    /** How far a refresh rate is from the nearest whole multiple of a video rate, as a fraction. */
    static float miss(float refresh, float rate) {
        int multiple = Math.max(1, Math.round(refresh / rate));
        if (multiple > 4) {
            return Float.MAX_VALUE;
        }
        float target = multiple * rate;
        return Math.abs(refresh - target) / target;
    }

    /** A measured rate, settled on the standard one it is next to. */
    static float snap(float rate) {
        for (float standard : STANDARD) {
            if (Math.abs(rate - standard) / standard < 0.003f) {
                // 23.976 and 24 are 0.1% apart, inside the window: the nearer wins.
                float nearest = standard;
                for (float other : STANDARD) {
                    if (Math.abs(rate - other) < Math.abs(rate - nearest)) {
                        nearest = other;
                    }
                }
                return nearest;
            }
        }
        return rate;
    }

    private static boolean isTelevision(Activity activity) {
        return activity.getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK);
    }
}
