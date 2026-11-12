package app.tvinto.player;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;

import java.lang.ref.WeakReference;

/**
 * A reminder going off while the player has the screen: what is starting and where, in the top corner, for
 * twenty seconds.
 *
 * OK watches it -- inside the player when the channel is one it can reach
 * (the mini guide's list), and otherwise by closing the player and opening
 * the app on the channel, as the phone's notification does. Back puts it
 * away. Every other key passes, so the remote works as before around it.
 *
 * The alarm, not the web app, says when: the page behind the player is all
 * but stopped while it plays (CLAUDE.md).
 */
public final class ReminderBanner {

    /** What the player does with a reminder it was asked to watch. */
    interface Watcher {
        /** Switches to the channel inside the player; false when it cannot reach it. */
        boolean switchTo(String streamId);

        /** Closes the player for the app to open the channel instead. */
        void openInApp(String link);
    }

    private static final long SHOWN_MS = 20_000L;

    /**
     * Android 16 hands Back to callbacks rather than as a key, for an app that
     * targets it: the key never came, and Back closed the player under the
     * banner (the TV emulator, 4 October). As in ChannelSession.
     */
    private static final boolean BACK_BY_CALLBACK = android.os.Build.VERSION.SDK_INT >= 36;

    @Nullable
    private Object backCallback = null;

    /** The banner of the player in front, if one is. */
    private static WeakReference<ReminderBanner> inFront = new WeakReference<>(null);

    private final Activity activity;
    private final Watcher watcher;
    private final Handler clock = new Handler(Looper.getMainLooper());
    private final Runnable hide = this::hide;

    @Nullable
    private View view = null;
    @Nullable
    private String streamId = null;
    @Nullable
    private String link = null;

    ReminderBanner(Activity activity, Watcher watcher) {
        this.activity = activity;
        this.watcher = watcher;
    }

    /** The player came to the front: reminders go here. */
    void resumed() {
        inFront = new WeakReference<>(this);
    }

    /** The player went behind something, or away. */
    void paused() {
        if (inFront.get() == this) {
            inFront = new WeakReference<>(null);
        }
    }

    void destroy() {
        paused();
        hide();
    }

    /**
     * Says a reminder in the player in front, from the alarm. False when no
     * player is in front, for the alarm to say it some other way.
     */
    public static boolean ringInPlayer(String key, String streamId, String channel, String title,
                                       String starting, String watchHint, String link) {
        ReminderBanner banner = inFront.get();
        if (banner == null || banner.activity.isFinishing()) {
            return false;
        }
        banner.show(streamId, channel, String.format(starting, title), watchHint, link);
        return true;
    }

    private void show(String forStream, String channel, String heading, String hint, String watchLink) {
        hide();
        streamId = forStream;
        link = watchLink;

        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        card.setPadding(pad, dp(12), pad, dp(12));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(235, 18, 24, 40));
        background.setCornerRadius(dp(12));
        background.setStroke(dp(2), Color.rgb(108, 132, 255));
        card.setBackground(background);

        card.addView(line(heading, 20, Color.WHITE, true));
        card.addView(line(channel, 16, Color.rgb(170, 186, 255), false));
        TextView hintLine = line(hint, 14, Color.rgb(200, 205, 220), false);
        hintLine.setPadding(0, dp(6), 0, 0);
        card.addView(hintLine);

        FrameLayout.LayoutParams place = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        place.setMargins(dp(24), dp(24), dp(24), dp(24));
        activity.addContentView(card, place);
        view = card;
        clock.postDelayed(hide, SHOWN_MS);
        if (BACK_BY_CALLBACK) {
            android.window.OnBackInvokedCallback callback = this::hide;
            activity.getOnBackInvokedDispatcher()
                .registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_OVERLAY + 1, callback);
            backCallback = callback;
        }
    }

    private TextView line(String text, int sp, int colour, boolean bold) {
        TextView line = new TextView(activity);
        line.setText(text);
        line.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        line.setTextColor(colour);
        line.setMaxLines(2);
        line.setMaxWidth(dp(420));
        line.setEllipsize(android.text.TextUtils.TruncateAt.END);
        if (bold) {
            line.setTypeface(line.getTypeface(), android.graphics.Typeface.BOLD);
        }
        return line;
    }

    boolean isShowing() {
        return view != null;
    }

    void hide() {
        clock.removeCallbacks(hide);
        if (BACK_BY_CALLBACK && backCallback != null) {
            activity.getOnBackInvokedDispatcher()
                .unregisterOnBackInvokedCallback((android.window.OnBackInvokedCallback) backCallback);
            backCallback = null;
        }
        if (view != null && view.getParent() instanceof android.view.ViewGroup) {
            ((android.view.ViewGroup) view.getParent()).removeView(view);
        }
        view = null;
    }

    /** OK and Back while it shows; null for every other key, and when it does not show. */
    @Nullable
    Boolean onKey(KeyEvent event) {
        if (view == null) {
            return null;
        }
        int code = event.getKeyCode();
        boolean ok = code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
        if (!ok && code != KeyEvent.KEYCODE_BACK) {
            return null;
        }
        if (event.getAction() == KeyEvent.ACTION_UP) {
            String stream = streamId;
            String watchLink = link;
            hide();
            if (ok && stream != null && !watcher.switchTo(stream) && watchLink != null) {
                watcher.openInApp(watchLink);
            }
        }
        return true;
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }
}
