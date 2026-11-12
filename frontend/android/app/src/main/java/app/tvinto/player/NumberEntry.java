package app.tvinto.player;

import android.app.Activity;
import android.graphics.Outline;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;

/**
 * Typing a channel number over the video: design boards PL-TV-3 and PL-TV-3b.
 *
 * Shows on the first digit; each digit extends it and restarts a three-second
 * timer, after which the channel is chosen by itself. OK chooses at once, Back
 * deletes a digit and closes on an empty field. The line under the digits is
 * the live best match. A number no channel has shows PL-TV-3b for two seconds
 * and changes nothing.
 *
 * It draws and keeps time; ChannelSession decides what keys reach it.
 */
final class NumberEntry {

    /** What the entry does when a number has been chosen. */
    interface Listener {
        void chosen(ChannelDirectory.Channel channel);

        /** Shown or hidden, so Back can be taken or given back. */
        void changed();
    }

    private static final long COMMIT_AFTER_MS = 3000L;
    private static final long MISSING_FOR_MS = 2000L;
    private static final int MAX_DIGITS = 4;
    private static final int PANEL = 0xF5060F1E;

    private final Activity activity;
    private final float unit;
    private final Listener listener;
    private final Handler clock = new Handler(Looper.getMainLooper());

    private final FrameLayout root;
    private final View spine;
    private final TextView digits;
    private final View caret;
    private final TextView match;
    private final TextView hint;

    @Nullable
    private ChannelDirectory directory = null;
    private String typed = "";
    private boolean missing = false;

    private final Runnable commitLater = this::commit;
    private final Runnable closeLater = this::close;

    NumberEntry(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
        this.unit = ChannelOverlay.unitFor(activity);

        root = new FrameLayout(activity);
        root.setFocusable(false);

        View scrim = new View(activity);
        scrim.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, new int[] { 0xEF03080F, 0x0003080F }));
        root.addView(scrim, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(420), Gravity.BOTTOM));

        LinearLayout panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.HORIZONTAL);
        panel.setBackgroundColor(PANEL);
        panel.setClipToOutline(true);
        panel.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), px(6));
            }
        });

        spine = new View(activity);
        spine.setBackgroundColor(ChannelOverlay.AIR);
        panel.addView(spine, new LinearLayout.LayoutParams(px(6), ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.HORIZONTAL);
        body.setGravity(Gravity.CENTER_VERTICAL);
        body.setPadding(px(44), px(32), px(44), px(32));
        panel.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // Monospaced, so the string does not shuffle as it grows.
        LinearLayout number = new LinearLayout(activity);
        number.setOrientation(LinearLayout.HORIZONTAL);
        number.setGravity(Gravity.BOTTOM);
        body.addView(number, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        digits = text(96, ChannelOverlay.FG, Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
        digits.setLetterSpacing(0.04f);
        number.addView(digits);

        // A solid block, not a blinking line, which is invisible at three metres.
        caret = new View(activity);
        caret.setBackgroundColor(ChannelOverlay.PRIMARY_BRIGHT);
        LinearLayout.LayoutParams caretAt = new LinearLayout.LayoutParams(px(44), px(8));
        caretAt.leftMargin = px(6);
        caretAt.bottomMargin = px(14);
        number.addView(caret, caretAt);

        LinearLayout words = new LinearLayout(activity);
        words.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams wordsAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        wordsAt.leftMargin = px(40);
        body.addView(words, wordsAt);

        match = text(32, ChannelOverlay.FG, Typeface.create("sans-serif", Typeface.BOLD));
        match.setEllipsize(android.text.TextUtils.TruncateAt.END);
        match.setMaxWidth(px(900));
        words.addView(match);
        hint = text(26, ChannelOverlay.MUTED, Typeface.create("sans-serif", Typeface.NORMAL));
        LinearLayout.LayoutParams hintAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintAt.topMargin = px(8);
        words.addView(hint, hintAt);

        FrameLayout.LayoutParams panelAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.START);
        panelAt.leftMargin = px(96);
        panelAt.bottomMargin = px(54);
        root.addView(panel, panelAt);
        root.setVisibility(View.GONE);

        activity.addContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    void setDirectory(@Nullable ChannelDirectory directory) {
        this.directory = directory;
    }

    boolean isShowing() {
        return root.getVisibility() == View.VISIBLE;
    }

    /** A digit. During "No channel" it starts a fresh entry rather than appending. */
    void digit(int value) {
        if (missing) {
            typed = "";
            missing = false;
        }
        if (typed.length() >= MAX_DIGITS) {
            typed = typed.substring(1);
        }
        typed += value;
        clock.removeCallbacks(closeLater);
        clock.removeCallbacks(commitLater);
        clock.postDelayed(commitLater, COMMIT_AFTER_MS);
        draw();
    }

    /** OK: go to the match now. */
    void commit() {
        clock.removeCallbacks(commitLater);
        if (typed.isEmpty() || missing) {
            return;
        }
        ChannelDirectory.Channel found = directory == null ? null : directory.bestNumberMatch(typed);
        if (found == null) {
            // PL-TV-3b: the channel does not change and the picture is never interrupted.
            missing = true;
            draw();
            clock.postDelayed(closeLater, MISSING_FOR_MS);
            return;
        }
        close();
        listener.chosen(found);
    }

    /** Back: delete a digit, or close when there are none. */
    void back() {
        if (missing || typed.length() <= 1) {
            close();
            return;
        }
        typed = typed.substring(0, typed.length() - 1);
        clock.removeCallbacks(commitLater);
        clock.postDelayed(commitLater, COMMIT_AFTER_MS);
        draw();
    }

    void close() {
        clock.removeCallbacks(commitLater);
        clock.removeCallbacks(closeLater);
        typed = "";
        missing = false;
        boolean was = isShowing();
        root.setVisibility(View.GONE);
        if (was) {
            listener.changed();
        }
    }

    private void draw() {
        digits.setText(typed);
        if (missing) {
            // The digits go grey rather than the panel turning red: a mistyped
            // number is not a fault, and red is kept for on-air marks.
            spine.setVisibility(View.VISIBLE);
            digits.setTextColor(ChannelOverlay.DIM);
            caret.setVisibility(View.GONE);
            match.setText(Texts.t("number.noChannel", typed));
            match.setTextColor(ChannelOverlay.FG);
            String range = directory == null ? "" : directory.numberRange();
            hint.setText(range.isEmpty() ? Texts.t("number.noNumbers") : Texts.t("number.range", range));
            hint.setVisibility(View.VISIBLE);
        } else {
            spine.setVisibility(View.GONE);
            digits.setTextColor(ChannelOverlay.FG);
            caret.setVisibility(View.VISIBLE);
            ChannelDirectory.Channel found = directory == null ? null : directory.bestNumberMatch(typed);
            match.setText(found == null ? Texts.t("number.notYet", typed) : found.label());
            match.setTextColor(found == null ? ChannelOverlay.MUTED : ChannelOverlay.FG);
            // Nothing under the match while typing: "Keep typing, or OK to go
            // now" only said what the keys do, and the number goes on its own
            // after a pause (a user's rule on key hints, 5 October).
            hint.setVisibility(View.GONE);
        }
        boolean was = isShowing();
        root.setVisibility(View.VISIBLE);
        // The panel is as wide as its words, which have just changed.
        root.requestLayout();
        if (!was) {
            listener.changed();
        }
    }

    private TextView text(float size, int colour, Typeface face) {
        TextView view = new TextView(activity);
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * unit);
        view.setTextColor(colour);
        view.setTypeface(face);
        view.setIncludeFontPadding(false);
        view.setSingleLine(true);
        return view;
    }

    private int px(float designPx) {
        return Math.round(designPx * unit);
    }
}
