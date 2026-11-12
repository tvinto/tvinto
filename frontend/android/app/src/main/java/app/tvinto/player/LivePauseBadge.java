package app.tvinto.player;

import android.app.Activity;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.util.Locale;
import java.util.function.LongSupplier;

/**
 * Where a paused channel stands, in the top corner (LivePause): "PAUSED ·
 * 1:23" while paused, counting, and "3:20 behind live" while it plays on from
 * the pause. Gone at live.
 */
final class LivePauseBadge {

    private final TextView view;
    private final Handler clock = new Handler(Looper.getMainLooper());
    private LongSupplier pausedFor = () -> 0L;
    private LongSupplier behindBy = () -> 0L;
    private boolean paused = false;
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            draw();
            clock.postDelayed(this, 1000L);
        }
    };

    LivePauseBadge(Activity activity) {
        float unit = ChannelOverlay.unitFor(activity);
        view = new TextView(activity);
        view.setTextColor(0xFFFFFFFF);
        view.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, 26 * unit);
        view.setLetterSpacing(0.04f);
        int across = Math.round(22 * unit);
        int down = Math.round(10 * unit);
        view.setPadding(across, down, across, down);
        GradientDrawable ground = new GradientDrawable();
        ground.setColor(0xCC0B1220);
        ground.setCornerRadius(12 * unit);
        view.setBackground(ground);
        view.setVisibility(View.GONE);
        FrameLayout.LayoutParams place = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        int margin = Math.round(48 * unit);
        place.setMargins(margin, margin, margin, margin);
        activity.addContentView(view, place);
    }

    /** Paused now: counts how long. */
    void showPaused(LongSupplier sincePaused) {
        paused = true;
        pausedFor = sincePaused;
        start();
    }

    /** Playing on from a pause: how far behind live. */
    void showBehind(LongSupplier behind) {
        paused = false;
        behindBy = behind;
        start();
    }

    void hide() {
        clock.removeCallbacks(tick);
        view.setVisibility(View.GONE);
    }

    private void start() {
        clock.removeCallbacks(tick);
        view.setVisibility(View.VISIBLE);
        tick.run();
    }

    private void draw() {
        view.setText(paused
            ? Texts.t("film.paused") + " · " + clockOf(pausedFor.getAsLong())
            : Texts.t("live.behind", clockOf(behindBy.getAsLong())));
    }

    /** "1:23", "12:05", "1:02:03". */
    static String clockOf(long ms) {
        long seconds = Math.max(0L, ms) / 1000L;
        long hours = seconds / 3600L;
        long minutes = (seconds / 60L) % 60L;
        long rest = seconds % 60L;
        return hours > 0
            ? String.format(Locale.ROOT, "%d:%02d:%02d", hours, minutes, rest)
            : String.format(Locale.ROOT, "%d:%02d", minutes, rest);
    }
}
