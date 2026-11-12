package app.tvinto.player;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.Nullable;

import java.util.ArrayList;
import java.util.List;

/**
 * The sleep timer in a player (the rules are
 * SleepTimer): the list it is set from, the minute before it runs out, and
 * stopping. A television's only -- 6 October.
 *
 * The list is the audio and subtitles rail's look, on the right; the
 * countdown is a card in the top corner with Keep watching and Stop now.
 * Nothing pressed means stop: somebody asleep presses nothing. Both take
 * the remote while they show, ahead of the film's controls and the channel's
 * banner; every other key passes.
 */
final class SleepTimerPanel {

    /** What a player does for the timer. */
    interface Host {
        /** 0 to 1, for the fade at the end. */
        void setVolume(float volume);

        /** Stops playing, closes the player and puts the app behind the launcher. */
        void stopForSleep();
    }

    /** A player activity that has a panel, for its film controls and channel banner to reach. */
    interface Owner {
        @Nullable
        SleepTimerPanel sleepTimer();
    }

    /** As in ReminderBanner: Back arrives as a callback on Android 16. */
    private static final boolean BACK_BY_CALLBACK = android.os.Build.VERSION.SDK_INT >= 36;

    private final Activity activity;
    private final Host host;
    private final FilmUi ui;
    private final Handler clock = new Handler(Looper.getMainLooper());
    private final Runnable check = this::check;
    private final Runnable listener = () -> clock.post(this::check);

    private final FrameLayout listLayer;
    private final TextView listSummary;
    private final LinearLayout listRows;
    private final ScrollView listScroll;
    private final List<FilmUi.ChoiceRow> rows = new ArrayList<>();
    private List<SleepTimer.Choice> choices = new ArrayList<>();
    private int listFocus = 0;
    @Nullable
    private Runnable onListClosed = null;

    private final View countdownCard;
    private final TextView countdownTime;
    private final FilmUi.Button keepButton;
    private final FilmUi.Button stopButton;
    private int countdownFocus = 0;

    private boolean inFront = false;
    private boolean faded = false;
    @Nullable
    private Object backCallback = null;

    /** For a television; null anywhere else, where the timer is not offered. */
    @Nullable
    static SleepTimerPanel forTelevision(Activity activity, Host host) {
        android.app.UiModeManager modes = (android.app.UiModeManager) activity.getSystemService(Activity.UI_MODE_SERVICE);
        boolean television = modes != null && modes.getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION;
        return television ? new SleepTimerPanel(activity, host) : null;
    }

    /** The panel of a player activity, or null. */
    @Nullable
    static SleepTimerPanel of(Activity activity) {
        return activity instanceof Owner ? ((Owner) activity).sleepTimer() : null;
    }

    private SleepTimerPanel(Activity activity, Host host) {
        this.activity = activity;
        this.host = host;
        this.ui = new FilmUi(activity, ChannelOverlay.unitFor(activity));

        FrameLayout root = new FrameLayout(activity);
        root.setFocusable(false);
        root.setClipChildren(false);

        // --- The list ---------------------------------------------------------------
        // As Audio & subtitles draws itself (PX-TV-5, TrackChoices): the
        // picture dimmed, a large title, plain rows with the one in use ticked.
        // It was a boxed panel on the right in the old style (31
        // October: "looks horrible on the new layout").
        listLayer = new FrameLayout(activity);
        listLayer.setBackgroundColor(FilmUi.fade(0.82f));

        LinearLayout panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        TextView title = ui.text(44, FilmUi.WHITE, Typeface.BOLD);
        title.setText(Texts.t("sleep.title"));
        title.setPadding(ui.px(22), 0, 0, 0);
        panel.addView(title);
        listSummary = ui.text(26, FilmUi.QUIET, Typeface.NORMAL);
        listSummary.setPadding(ui.px(22), 0, 0, 0);
        LinearLayout.LayoutParams summaryAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        summaryAt.topMargin = ui.px(10);
        summaryAt.bottomMargin = ui.px(36);
        panel.addView(listSummary, summaryAt);
        listRows = new LinearLayout(activity);
        listRows.setOrientation(LinearLayout.VERTICAL);
        listScroll = new ScrollView(activity);
        listScroll.setVerticalScrollBarEnabled(false);
        listScroll.setFocusable(false);
        listScroll.addView(listRows, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        panel.addView(listScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        FrameLayout.LayoutParams panelAt = new FrameLayout.LayoutParams(ui.px(760), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START);
        panelAt.leftMargin = ui.px(96);
        panelAt.topMargin = ui.px(120);
        panelAt.bottomMargin = ui.px(72);
        listLayer.addView(panel, panelAt);
        listLayer.setVisibility(View.GONE);
        root.addView(listLayer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // --- The minute before, in the top corner ------------------------------------
        // The player's pieces (round 14): a dark rounded card with no coloured
        // edge, the time in white, and the two answers as pills -- white when
        // focused, glass at rest -- where it was a boxed panel with a blue
        // spine and the old buttons.
        LinearLayout body = ui.panel(0x00000000, 0, FilmUi.fade(0.88f), 20, 28, 32);
        countdownCard = (View) body.getParent();
        // As wide as its words and buttons, which are longer in Croatian: the
        // panel's column is made to share a fixed width, and this one has none.
        body.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView kicker = ui.label(22, FilmUi.QUIET, 0.06f);
        kicker.setText(Texts.t("sleep.title").toUpperCase(java.util.Locale.ROOT));
        ui.stack(body, kicker, 0);
        countdownTime = ui.text(40, FilmUi.WHITE, Typeface.BOLD);
        ui.stack(body, countdownTime, 8);
        LinearLayout buttons = ui.row(false);
        keepButton = ui.pill(FilmUi.Icon.PLAY, Texts.t("sleep.keepWatching"), 72, 28, 26, 30);
        stopButton = ui.pill(-1, Texts.t("sleep.stopNow"), 72, 28, 26, 30);
        buttons.addView(keepButton);
        buttons.addView(stopButton, ui.beside(16));
        ui.stack(body, buttons, 24);
        FrameLayout.LayoutParams cardAt = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        cardAt.topMargin = ui.px(54);
        cardAt.rightMargin = ui.px(96);
        countdownCard.setVisibility(View.GONE);
        root.addView(countdownCard, cardAt);

        activity.addContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // --- The player tells the panel ---------------------------------------------

    void resumed() {
        inFront = true;
        // Ran out while no player was in front -- somebody back in the app,
        // or the app away: nothing was playing for it to stop, so it simply
        // ends, rather than stopping the next thing opened.
        if (SleepTimer.ranOut(System.currentTimeMillis())) {
            SleepTimer.cancel();
        }
        SleepTimer.listen(listener);
        check();
    }

    void paused() {
        inFront = false;
        SleepTimer.stopListening(listener);
        clock.removeCallbacks(check);
    }

    void destroy() {
        paused();
        clock.removeCallbacksAndMessages(null);
        closeList();
        hideCountdown();
        // The end of a film was this player's; another opened later is not
        // what it was set for.
        if (SleepTimer.endsWithItem() && activity.isFinishing()) {
            SleepTimer.cancel();
        }
    }

    /**
     * The film or episode ended. True when the timer was waiting for that and
     * has stopped the player; false to carry on as usual (the next episode).
     */
    boolean stopAtEnd() {
        if (!SleepTimer.endsWithItem()) {
            return false;
        }
        SleepTimer.cancel();
        host.stopForSleep();
        return true;
    }

    // --- The list ------------------------------------------------------------------

    /**
     * Opens the list. `programmeEnd` is when the programme on now ends, or 0;
     * `item` says a film (false) or an episode (true) is playing, or null for
     * a channel. `onClosed` runs when it goes, for focus to go back.
     */
    void openList(long programmeEnd, @Nullable Boolean item, @Nullable Runnable onClosed) {
        long now = System.currentTimeMillis();
        choices = SleepTimer.choices(now, programmeEnd, item);
        onListClosed = onClosed;
        listRows.removeAllViews();
        rows.clear();
        listFocus = 0;
        SleepTimer.Choice chosen = SleepTimer.chosen();
        for (int i = 0; i < choices.size(); i++) {
            if (chosen != null && choices.get(i).same(chosen)) {
                listFocus = i;
            }
            FilmUi.ChoiceRow row = new FilmUi.ChoiceRow(ui);
            LinearLayout.LayoutParams rowAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ui.px(70));
            rowAt.bottomMargin = ui.px(6);
            listRows.addView(row, rowAt);
            rows.add(row);
        }
        drawList();
        listLayer.setVisibility(View.VISIBLE);
        updateBack();
    }

    boolean isShowing() {
        return listLayer.getVisibility() == View.VISIBLE || countdownCard.getVisibility() == View.VISIBLE;
    }

    private void drawList() {
        long now = System.currentTimeMillis();
        String summary = SleepTimer.summary(now);
        // What is set, when something is; nothing when it is off. It said how
        // the timer works when off, and the rule is no explanatory tips (the
        // owner, 1 November).
        listSummary.setText(summary == null ? "" : summary);
        listSummary.setVisibility(summary == null ? View.GONE : View.VISIBLE);
        SleepTimer.Choice chosen = SleepTimer.chosen();
        for (int i = 0; i < rows.size(); i++) {
            SleepTimer.Choice choice = choices.get(i);
            boolean inUse = chosen == null ? choice.kind == SleepTimer.Kind.OFF && !SleepTimer.isOn(now) : choice.same(chosen);
            rows.get(i).set(inUse && summary != null ? choice.label() + "  ·  " + summary : choice.label(), inUse, i == listFocus);
        }
        if (listFocus < rows.size()) {
            View row = rows.get(listFocus);
            listScroll.post(() -> {
                int top = row.getTop() - ui.px(60);
                int bottom = row.getBottom() + ui.px(60);
                int scrolled = listScroll.getScrollY();
                int height = listScroll.getHeight();
                if (top < scrolled) {
                    listScroll.smoothScrollTo(0, Math.max(0, top));
                } else if (bottom > scrolled + height) {
                    listScroll.smoothScrollTo(0, bottom - height);
                }
            });
        }
    }

    private void chooseInList() {
        if (listFocus >= choices.size()) {
            return;
        }
        SleepTimer.choose(choices.get(listFocus), System.currentTimeMillis());
        closeList();
    }

    private void closeList() {
        if (listLayer.getVisibility() != View.VISIBLE) {
            return;
        }
        listLayer.setVisibility(View.GONE);
        updateBack();
        Runnable closed = onListClosed;
        onListClosed = null;
        if (closed != null) {
            closed.run();
        }
    }

    // --- The minute before -----------------------------------------------------------

    /** Looks at the timer and does what it says now, then looks again when it next matters. */
    private void check() {
        clock.removeCallbacks(check);
        if (!inFront) {
            return;
        }
        long now = System.currentTimeMillis();
        if (SleepTimer.ranOut(now)) {
            SleepTimer.cancel();
            hideCountdown();
            host.stopForSleep();
            return;
        }
        long left = SleepTimer.remainingMs(now);
        if (left <= 0L) {
            // Off, or waiting for the end of the film.
            hideCountdown();
            return;
        }
        if (left <= SleepTimer.WARNING_MS) {
            showCountdown(left);
            clock.postDelayed(check, 250L);
            return;
        }
        hideCountdown();
        clock.postDelayed(check, Math.min(left - SleepTimer.WARNING_MS, 60_000L));
    }

    private void showCountdown(long left) {
        countdownTime.setText(Texts.t("sleep.stoppingIn", SleepTimer.countdown(left)));
        float volume = SleepTimer.volume(left);
        if (volume < 1f) {
            faded = true;
        }
        host.setVolume(volume);
        if (countdownCard.getVisibility() != View.VISIBLE) {
            // The list is the other thing that takes the remote: one at a time.
            closeList();
            setCountdownFocus(0);
            countdownCard.setVisibility(View.VISIBLE);
            updateBack();
        }
    }

    private void hideCountdown() {
        if (faded) {
            host.setVolume(1f);
            faded = false;
        }
        if (countdownCard.getVisibility() == View.VISIBLE) {
            countdownCard.setVisibility(View.GONE);
            updateBack();
        }
    }

    private void setCountdownFocus(int index) {
        countdownFocus = index;
        keepButton.setFocusedLook(index == 0);
        stopButton.setFocusedLook(index == 1);
    }

    private void keepWatching() {
        SleepTimer.keepWatching(System.currentTimeMillis());
        check();
    }

    private void stopNow() {
        SleepTimer.cancel();
        hideCountdown();
        host.stopForSleep();
    }

    // --- Keys ----------------------------------------------------------------------------

    /** Returns true or false when the panel took the key, null when it is not showing or passes it. */
    @Nullable
    Boolean onKey(KeyEvent event) {
        int code = event.getKeyCode();
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        boolean press = down && event.getRepeatCount() == 0;
        boolean ok = code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER;

        if (listLayer.getVisibility() == View.VISIBLE) {
            if (code == KeyEvent.KEYCODE_BACK) {
                if (press && !BACK_BY_CALLBACK) {
                    closeList();
                }
            } else if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) {
                if (down) {
                    listFocus = Math.max(0, Math.min(rows.size() - 1, listFocus + (code == KeyEvent.KEYCODE_DPAD_UP ? -1 : 1)));
                    drawList();
                }
            } else if (ok) {
                if (press) {
                    chooseInList();
                }
            }
            // Everything else is inert while the list is up.
            return true;
        }

        if (countdownCard.getVisibility() == View.VISIBLE) {
            if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
                if (down) {
                    setCountdownFocus(code == KeyEvent.KEYCODE_DPAD_LEFT ? 0 : 1);
                }
                return true;
            }
            if (ok) {
                if (press) {
                    if (countdownFocus == 0) {
                        keepWatching();
                    } else {
                        stopNow();
                    }
                }
                return true;
            }
            if (code == KeyEvent.KEYCODE_BACK) {
                // A deliberate press is somebody awake: the same as Keep watching.
                if (press && !BACK_BY_CALLBACK) {
                    keepWatching();
                }
                return true;
            }
        }
        return null;
    }

    private void onBack() {
        if (listLayer.getVisibility() == View.VISIBLE) {
            closeList();
        } else if (countdownCard.getVisibility() == View.VISIBLE) {
            keepWatching();
        }
    }

    /** Takes Back while either part shows, above the player's other overlays. */
    private void updateBack() {
        if (!BACK_BY_CALLBACK) {
            return;
        }
        android.window.OnBackInvokedDispatcher dispatcher = activity.getOnBackInvokedDispatcher();
        boolean wanted = isShowing();
        if (wanted && backCallback == null) {
            android.window.OnBackInvokedCallback callback = this::onBack;
            dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_OVERLAY + 2, callback);
            backCallback = callback;
        } else if (!wanted && backCallback != null) {
            dispatcher.unregisterOnBackInvokedCallback((android.window.OnBackInvokedCallback) backCallback);
            backCallback = null;
        }
    }
}
