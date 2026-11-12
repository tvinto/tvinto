package app.tvinto.player;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * The channel banner: number, name, what is on and what is next.
 *
 * Design boards PX-TV-6 and, on a phone, PX-P-3: no box, a fade along the
 * bottom, what is on large and a red LIVE bar between its start and end. They
 * replaced PL-TV-1's panel (round 12, "more Netflix-style"). Shown for four
 * seconds when a channel arrives and again on OK or Info; the activity decides
 * which keys do that. It takes no focus and swallows no press.
 *
 * What it says comes from the web app, which holds the guide
 * (src/app/utils/player-banner.utils.ts); the times arrive as milliseconds so
 * the bar can keep moving here.
 *
 * On a television its details -- the second OK -- end in a row of the
 * films' pills (PX-TV-1): Audio & subtitles, the guide, the sleep timer. They
 * replaced a "Player controls" button that opened Media3's own bar, which hid
 * the subtitles a click deeper and looked like nothing else in the app (the
 * owner, 31 October). Focus there is drawn, a white pill, as in the film's
 * controls; ChannelSession hands it the keys.
 */
final class ChannelBanner {

    static final long SHOW_MS = 4000L;
    /** The details a second OK shows are read, not glanced at. */
    static final long DETAILS_MS = 15_000L;

    /** The scrim under the banner: oklch(0.13 0.02 255) at 0.96, 0.82, then clear. */
    private static final int[] SCRIM = { 0xF403080F, 0xD103080F, 0x0003080F };
    /** The hatched plate of a channel with no guide: oklch(0.26 0.05 262) and oklch(0.22 0.042 261). */
    private static final int HATCH_LIGHT = 0xFF16243C;
    private static final int HATCH_DARK = 0xFF0F1A2E;

    /** What the web app sent about a channel. */
    static final class Info {
        final String number;
        final String name;
        final String tags;
        final String monogram;
        final boolean hasGuide;
        @Nullable final String nowTitle;
        /** What the guide says about the programme on now; empty when it says nothing. */
        final String nowDescription;
        final long nowStart;
        final long nowStop;
        @Nullable final String nextTitle;
        final long nextStart;

        Info(String number, String name, String tags, String monogram, boolean hasGuide,
             @Nullable String nowTitle, String nowDescription, long nowStart, long nowStop, @Nullable String nextTitle, long nextStart) {
            this.number = number;
            this.name = name;
            this.tags = tags;
            this.monogram = monogram;
            this.hasGuide = hasGuide;
            this.nowTitle = nowTitle;
            this.nowDescription = nowDescription;
            this.nowStart = nowStart;
            this.nowStop = nowStop;
            this.nextTitle = nextTitle;
            this.nextStart = nextStart;
        }

        /** From the banner the web app sends, with the channel's own fields beside it. */
        static Info from(String number, String name, String monogram, @Nullable JSONObject banner) {
            if (banner == null) {
                // Not "no guide": not known yet. The name alone until updateBanner.
                return new Info(number, name, "", monogram, true, null, "", 0, 0, null, 0);
            }
            JSONObject now = banner.optJSONObject("now");
            JSONObject next = banner.optJSONObject("next");
            return new Info(
                number,
                name,
                banner.optString("tags", ""),
                monogram,
                banner.optBoolean("hasGuide", false),
                now == null ? null : now.optString("title", ""),
                now == null ? "" : now.optString("description", ""),
                now == null ? 0 : now.optLong("startMs", 0),
                now == null ? 0 : now.optLong("stopMs", 0),
                next == null ? null : next.optString("title", ""),
                next == null ? 0 : next.optLong("startMs", 0)
            );
        }
    }

    private final boolean television;
    private final float unit;
    private final Activity activity;

    private final FrameLayout root;
    private final TextView plate;
    private final TextView number;
    private final TextView name;
    private final TextView tags;
    private final LinearLayout programme;
    private final TextView title;
    /** When the programme on now began, and when it ends, either side of its bar. */
    private final TextView time;
    private final TextView stop;
    /** LIVE, before the programme's times: not while behind live (LivePause), where it would not be true. */
    private final TextView liveTag;
    private final Progress progress;
    /** The programme's description: shown by a second OK, hidden otherwise. */
    private final TextView description;
    private boolean details = false;
    private final LinearLayout nextRow;
    private final TextView nextLabel;
    private final TextView nextTitle;
    private final TextView noGuide;
    /** "Sleep timer · 23 min left", beside the name while the timer runs. */
    private final TextView sleepLine;

    /** The actions in the details; a television's only. */
    static final int ACTION_PAUSE = 0;
    static final int ACTION_LIVE = 1;
    static final int ACTION_TRACKS = 2;
    static final int ACTION_GUIDE = 3;
    static final int ACTION_SLEEP = 4;

    /** Where a pause is (LivePause), for the first two actions: Pause or Play, and Back to live. */
    interface PauseState {
        boolean canPause();

        boolean paused();

        /** Behind live: paused now, or playing what was written while it was. */
        boolean behind();
    }

    @Nullable
    private PauseState pauseState = null;
    @Nullable
    private final LinearLayout actions;
    private final List<FilmUi.Pill> actionButtons = new ArrayList<>();
    private int actionFocus = 0;

    @Nullable
    private Info info = null;

    private final Handler clock = new Handler(Looper.getMainLooper());
    private final Runnable hideLater = this::hide;
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            fillTimes();
            clock.postDelayed(this, 15_000L);
        }
    };

    ChannelBanner(Activity activity, boolean television) {
        this.activity = activity;
        this.television = television;
        // A television is drawn to the 1920-wide boards; a phone to PL-P-1 in dp.
        this.unit = television ? ChannelOverlay.unitFor(activity) : activity.getResources().getDisplayMetrics().density;

        root = new FrameLayout(activity);
        root.setFocusable(false);

        // PX-TV-6 and PX-P-3: no box, a fade along the bottom, and what is on large.
        View scrim = new View(activity);
        scrim.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, SCRIM));
        // A phone plays these sideways, and may still be upright while this is built:
        // its height then is the shorter side.
        android.util.DisplayMetrics shape = activity.getResources().getDisplayMetrics();
        int tall = television ? shape.heightPixels : Math.min(shape.widthPixels, shape.heightPixels);
        root.addView(scrim, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.round(tall * (television ? 0.46f : 0.55f)), Gravity.BOTTOM));

        LinearLayout panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);

        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.HORIZONTAL);
        body.setGravity(Gravity.BOTTOM);
        panel.addView(body, stacked(0));

        plate = text(television ? 40 : 16, ChannelOverlay.LIVE, Typeface.BOLD);
        plate.setGravity(Gravity.CENTER);
        body.addView(plate, new LinearLayout.LayoutParams(px(television ? 180 : 72), px(television ? 112 : 46)));

        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams columnAt = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        columnAt.leftMargin = px(television ? 36 : 14);
        body.addView(column, columnAt);

        // The number and name small, as the channel is what is known already.
        LinearLayout heading = row(activity);
        column.addView(heading, stacked(0));
        number = text(television ? 34 : 12, FilmUi.SOFT, Typeface.BOLD);
        number.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
        heading.addView(number, wrap(0));
        name = text(television ? 34 : 12, FilmUi.SOFT, Typeface.BOLD);
        ellipsize(name);
        name.setMaxWidth(px(television ? 760 : 340));
        heading.addView(name, wrap(television ? 20 : 6));
        tags = text(television ? 20 : 11, FilmUi.QUIET, Typeface.BOLD);
        tags.setLetterSpacing(0.06f);
        heading.addView(tags, wrap(television ? 20 : 8));
        sleepLine = text(television ? 24 : 12, FilmUi.PRIMARY_BRIGHT, Typeface.BOLD);
        sleepLine.setVisibility(View.GONE);
        heading.addView(sleepLine, wrap(television ? 28 : 12));

        // PX-P-3: the two things a remote has keys for. Beside the title on a
        // phone turned sideways, as the board draws it; upright there is no
        // room there -- the title was cut to two letters -- so rows below.
        // A phone can turn while a channel plays, and the player does not
        // start again when it does, so they move then (placePhonePills).
        this.body = body;
        if (!television) {
            FilmUi phone = new FilmUi(activity, unit);
            pauseButton = phone.pill(FilmUi.Icon.PAUSE, Texts.t("film.pause"), 40, 8, 14, 20);
            liveButton = phone.pill(FilmUi.Icon.NEXT, Texts.t("live.backToLive"), 40, 8, 14, 20);
            pauseButton.setVisibility(View.GONE);
            liveButton.setVisibility(View.GONE);
            guideButton = phone.pill(FilmUi.Icon.GUIDE, Texts.t("banner.guide"), 40, 8, 14, 20);
            tracksButton = phone.pill(FilmUi.Icon.TRACKS, Texts.t("film.audioSubtitles"), 40, 8, 14, 20);
            guideButton.setVisibility(View.GONE);
            tracksButton.setVisibility(View.GONE);
            phoneActions = new LinearLayout(activity);
            phoneActions.setOrientation(LinearLayout.VERTICAL);
            pauseRow = row(activity);
            pauseRow.setBaselineAligned(false);
            otherRow = row(activity);
            otherRow.setBaselineAligned(false);
            phoneActions.addView(pauseRow);
            phoneActions.addView(otherRow, stacked(4));
            placePhonePills();
            root.addOnLayoutChangeListener((view, left, top, right, bottom, wasLeft, wasTop, wasRight, wasBottom) -> {
                if (right - left != wasRight - wasLeft) {
                    // Not in the middle of a layout pass: just after it.
                    view.post(this::placePhonePills);
                }
            });
        }

        // What is on, large: the thing a viewer looks for.
        title = text(television ? 56 : 22, FilmUi.WHITE, Typeface.BOLD);
        ellipsize(title);
        column.addView(title, stacked(television ? 10 : 2));

        // LIVE, then the programme between its start and its end.
        programme = new LinearLayout(activity);
        programme.setOrientation(LinearLayout.VERTICAL);
        panel.addView(programme, stacked(television ? 34 : 10));
        LinearLayout onNow = row(activity);
        onNow.setBaselineAligned(false);
        onNow.setGravity(Gravity.CENTER_VERTICAL);
        programme.addView(onNow, stacked(0));
        TextView live = text(television ? 22 : 11, FilmUi.WHITE, Typeface.BOLD);
        liveTag = live;
        live.setLetterSpacing(0.1f);
        live.setText("LIVE");
        GradientDrawable badge = new GradientDrawable();
        badge.setColor(ChannelOverlay.AIR);
        badge.setCornerRadius(px(6));
        live.setBackground(badge);
        live.setPadding(px(television ? 14 : 8), px(television ? 6 : 3), px(television ? 14 : 8), px(television ? 6 : 3));
        onNow.addView(live, wrap(0));
        time = text(television ? 26 : 12, FilmUi.SOFT, Typeface.NORMAL);
        time.setTypeface(Typeface.MONOSPACE);
        onNow.addView(time, wrap(television ? 28 : 10));
        progress = new Progress(activity);
        LinearLayout.LayoutParams progressAt = new LinearLayout.LayoutParams(0, px(television ? 8 : 4), 1f);
        progressAt.leftMargin = px(television ? 28 : 10);
        progressAt.rightMargin = px(television ? 28 : 10);
        onNow.addView(progress, progressAt);
        stop = text(television ? 26 : 12, FilmUi.SOFT, Typeface.NORMAL);
        stop.setTypeface(Typeface.MONOSPACE);
        onNow.addView(stop, wrap(0));

        description = text(television ? 26 : 13, FilmUi.SOFT, Typeface.NORMAL);
        description.setMaxLines(television ? 6 : 4);
        description.setEllipsize(TextUtils.TruncateAt.END);
        description.setLineSpacing(0f, 1.2f);
        description.setVisibility(View.GONE);
        programme.addView(description, stacked(television ? 22 : 8));

        nextRow = row(activity);
        panel.addView(nextRow, stacked(television ? 26 : 8));
        nextLabel = text(television ? 28 : 13, FilmUi.QUIET, Typeface.BOLD);
        nextLabel.setLetterSpacing(0.06f);
        nextRow.addView(nextLabel, wrap(0));
        nextTitle = text(television ? 28 : 13, FilmUi.WHITE, Typeface.NORMAL);
        ellipsize(nextTitle);
        nextRow.addView(nextTitle, flexible(television ? 18 : 8));

        noGuide = text(television ? 30 : 15, FilmUi.SOFT, Typeface.NORMAL);
        noGuide.setText(Texts.t("banner.noGuide"));
        panel.addView(noGuide, stacked(television ? 22 : 6));
        if (phoneActions != null) {
            panel.addView(phoneActions, stacked(6));
        }

        if (television) {
            FilmUi ui = new FilmUi(activity, unit);
            actions = ui.row(false);
            FilmUi.Pill pausePill = ui.pill(FilmUi.Icon.PAUSE, Texts.t("film.pause"), 76, 24, 28, 34);
            FilmUi.Pill livePill = ui.pill(FilmUi.Icon.NEXT, Texts.t("live.backToLive"), 76, 24, 28, 34);
            FilmUi.Pill tracks = ui.pill(FilmUi.Icon.TRACKS, Texts.t("film.audioSubtitles"), 76, 24, 28, 34);
            FilmUi.Pill guidePill = ui.pill(FilmUi.Icon.GUIDE, Texts.t("banner.guide"), 76, 24, 28, 34);
            FilmUi.Pill sleep = ui.pill(FilmUi.Icon.SLEEP, Texts.t("sleep.title"), 76, 24, 28, 34);
            actions.addView(pausePill);
            actions.addView(livePill, ui.beside(10));
            actions.addView(tracks, ui.beside(10));
            actions.addView(guidePill, ui.beside(10));
            actions.addView(sleep, ui.beside(10));
            actionButtons.add(pausePill);
            actionButtons.add(livePill);
            actionButtons.add(tracks);
            actionButtons.add(guidePill);
            actionButtons.add(sleep);
            actions.setVisibility(View.GONE);
            panel.addView(actions, stacked(28));
            // The focus ring is drawn outside a button: nothing on the way up may clip it.
            panel.setClipChildren(false);
            panel.setClipToPadding(false);
        } else {
            actions = null;
        }

        // As wide as the picture, the way the film's bar is (round 12).
        FrameLayout.LayoutParams panelAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        panelAt.leftMargin = px(television ? 96 : 20);
        panelAt.rightMargin = px(television ? 96 : 20);
        panelAt.bottomMargin = px(television ? 72 : 16);
        root.addView(panel, panelAt);
        root.setVisibility(View.GONE);

        activity.addContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** Changes what the banner is about, without showing it. */
    void describe(@Nullable Info channel) {
        info = channel;
        if (channel == null) {
            return;
        }

        plate.setText(channel.monogram);
        plate.setTextColor(channel.hasGuide ? ChannelOverlay.LIVE : ChannelOverlay.DIM);
        plate.setTextSize(TypedValue.COMPLEX_UNIT_PX, px(television ? (channel.hasGuide ? 40 : 36) : 16));
        if (channel.hasGuide) {
            GradientDrawable ground = new GradientDrawable();
            ground.setColor(ChannelOverlay.CARD_3);
            ground.setCornerRadius(px(6));
            plate.setBackground(ground);
        } else {
            plate.setBackground(new Hatched(px(television ? 14 : 6), px(6)));
        }

        number.setText(channel.number);
        number.setVisibility(channel.number.isEmpty() ? View.GONE : View.VISIBLE);
        name.setText(channel.name);
        ((LinearLayout.LayoutParams) name.getLayoutParams()).leftMargin = channel.number.isEmpty() ? 0 : px(television ? 20 : 10);
        tags.setText(channel.tags);
        tags.setVisibility(channel.tags.isEmpty() ? View.GONE : View.VISIBLE);

        // PL-TV-1b keeps the full height, so the banner does not jump size
        // passing through channels with and without listings.
        noGuide.setVisibility(channel.hasGuide ? View.GONE : View.VISIBLE);
        fillTimes();
    }

    /** For four seconds. */
    void show() {
        if (info == null) {
            return;
        }
        setDetails(false);
        fillTimes();
        // Turned while it was down: in the new shape's place from the first frame.
        placePhonePills();
        refreshPhoneButtons();
        PauseState pause = pauseState;
        liveTag.setVisibility(pause != null && pause.behind() ? View.GONE : View.VISIBLE);
        root.setVisibility(View.VISIBLE);
        if (onShown != null) {
            onShown.run();
        }
        clock.removeCallbacks(hideLater);
        clock.postDelayed(hideLater, SHOW_MS);
        clock.removeCallbacks(tick);
        clock.postDelayed(tick, 15_000L);
    }

    /**
     * The details of the programme on now, as a second OK asks for: the same
     * banner, grown by the guide's description, and up for longer because it
     * is being read.
     */
    void showDetails() {
        if (info == null) {
            return;
        }
        setDetails(true);
        fillTimes();
        placePhonePills();
        root.setVisibility(View.VISIBLE);
        clock.removeCallbacks(hideLater);
        clock.postDelayed(hideLater, DETAILS_MS);
        clock.removeCallbacks(tick);
        clock.postDelayed(tick, 15_000L);
    }

    /** Whether there is a programme on now to give details of. */
    boolean hasDetails() {
        Info channel = info;
        return channel != null && channel.hasGuide && channel.nowTitle != null && channel.nowStop > System.currentTimeMillis();
    }

    boolean isShowingDetails() {
        return details && isShowing();
    }

    private void setDetails(boolean on) {
        details = on;
        Info channel = info;
        String text = channel == null ? "" : channel.nowDescription;
        description.setText(text.isEmpty() ? Texts.t("banner.noDescription") : text);
        // A channel with no guide has details too on a television, for its
        // actions; there is no programme to describe.
        description.setVisibility(on && hasDetails() ? View.VISIBLE : View.GONE);
        if (actions != null) {
            actions.setVisibility(on ? View.VISIBLE : View.GONE);
            if (on) {
                PauseState pause = pauseState;
                boolean canPause = pause != null && pause.canPause();
                FilmUi.Pill pausePill = actionButtons.get(ACTION_PAUSE);
                pausePill.setVisibility(canPause ? View.VISIBLE : View.GONE);
                boolean paused = canPause && pause.paused();
                pausePill.setText(Texts.t(paused ? "film.play" : "film.pause"));
                pausePill.setIconKind(paused ? FilmUi.Icon.PLAY : FilmUi.Icon.PAUSE);
                actionButtons.get(ACTION_LIVE).setVisibility(canPause && pause.behind() ? View.VISIBLE : View.GONE);
                actionButtons.get(ACTION_TRACKS).setVisibility(tracksOffered == null || tracksOffered.getAsBoolean() ? View.VISIBLE : View.GONE);
                actionButtons.get(ACTION_GUIDE).setVisibility(guideOffered == null || guideOffered.getAsBoolean() ? View.VISIBLE : View.GONE);
                drawActions(firstAction());
            }
        }
    }

    // --- The actions (a television) ----------------------------------------------

    /** Whether the details carry actions: on a television. */
    boolean hasActions() {
        return actions != null;
    }

    /** What the details offer on a television, asked each time they open: tracks come to be known late. */
    void offerOnTelevision(java.util.function.BooleanSupplier tracks, java.util.function.BooleanSupplier guide, @Nullable PauseState pause) {
        tracksOffered = tracks;
        guideOffered = guide;
        pauseState = pause;
    }

    /** The first action shown: the sleep timer always is. */
    private int firstAction() {
        for (int i = 0; i < actionButtons.size(); i++) {
            if (actionButtons.get(i).getVisibility() == View.VISIBLE) {
                return i;
            }
        }
        return ACTION_SLEEP;
    }

    void moveAction(int direction) {
        int next = actionFocus + direction;
        while (next >= 0 && next < actionButtons.size() && actionButtons.get(next).getVisibility() != View.VISIBLE) {
            next += direction;
        }
        if (next >= 0 && next < actionButtons.size()) {
            drawActions(next);
        }
        keepUp();
    }

    int focusedAction() {
        return actionFocus;
    }

    /** When the programme on now ends, for the sleep timer's "End of this programme"; 0 when not known. */
    long programmeEnd() {
        Info channel = info;
        return hasDetails() && channel != null ? channel.nowStop : 0L;
    }

    /** A press in the details: they stay up for their full time again. */
    void keepUp() {
        clock.removeCallbacks(hideLater);
        clock.postDelayed(hideLater, DETAILS_MS);
    }

    private void drawActions(int focus) {
        actionFocus = focus;
        String sleep = SleepTimer.summary(System.currentTimeMillis());
        actionButtons.get(ACTION_SLEEP).setText(sleep == null ? Texts.t("sleep.title") : Texts.t("sleep.title") + " · " + sleep);
        for (int i = 0; i < actionButtons.size(); i++) {
            actionButtons.get(i).setFocusedLook(i == focus);
        }
    }

    void hide() {
        clock.removeCallbacks(hideLater);
        clock.removeCallbacks(tick);
        root.setVisibility(View.GONE);
        if (onHidden != null) {
            onHidden.run();
        }
    }

    boolean isShowing() {
        return root.getVisibility() == View.VISIBLE;
    }

    /** Told when the banner goes, so Back stops being taken for it. */
    @Nullable
    Runnable onHidden = null;

    /** Told when the banner comes up, for the subtitles to make room. */
    @Nullable
    Runnable onShown = null;

    // PX-P-3: what a finger needs that a remote has keys for, on a phone.
    /** Pause or Play, and Back to live (LivePause), first as on a television. */
    @Nullable
    private FilmUi.Pill pauseButton = null;
    @Nullable
    private FilmUi.Pill liveButton = null;
    @Nullable
    private FilmUi.Pill guideButton = null;
    @Nullable
    private FilmUi.Pill tracksButton = null;
    /** Whether each is on offer now: the guide once there is a list, tracks when the player can show them. */
    @Nullable
    private java.util.function.BooleanSupplier guideOffered = null;
    @Nullable
    private java.util.function.BooleanSupplier tracksOffered = null;

    /** Wires the phone's Guide and Audio & subtitles buttons; a television has keys for both. */
    void offerOnPhone(java.util.function.BooleanSupplier guideOffered, Runnable openGuide,
                      java.util.function.BooleanSupplier tracksOffered, Runnable openTracks) {
        this.guideOffered = guideOffered;
        this.tracksOffered = tracksOffered;
        if (guideButton != null) {
            guideButton.setOnClickListener(v -> openGuide.run());
        }
        if (tracksButton != null) {
            tracksButton.setOnClickListener(v -> openTracks.run());
        }
    }

    /** The row the phone's pills go in when it is sideways: beside the title. */
    private final LinearLayout body;
    /** Upright, the pills' own rows below the programme: Pause and Back to live, then Guide and tracks. */
    @Nullable
    private LinearLayout phoneActions = null;
    @Nullable
    private LinearLayout pauseRow = null;
    @Nullable
    private LinearLayout otherRow = null;
    /** Where the pills are now: null before they are placed. */
    @Nullable
    private Boolean pillsBeside = null;

    /**
     * Puts a phone's pills where its present shape has room: beside the
     * title when it is 600 dp wide or more, as a phone turned sideways is,
     * else on rows of their own -- four pills are wider than an upright
     * phone, and the last was cut.
     */
    private void placePhonePills() {
        if (phoneActions == null || pauseRow == null || otherRow == null) {
            return;
        }
        boolean beside = activity.getResources().getConfiguration().screenWidthDp >= 600;
        if (pillsBeside != null && pillsBeside == beside) {
            return;
        }
        pillsBeside = beside;
        FilmUi.Pill[] pills = { pauseButton, liveButton, guideButton, tracksButton };
        for (FilmUi.Pill pill : pills) {
            if (pill.getParent() instanceof ViewGroup) {
                ((ViewGroup) pill.getParent()).removeView(pill);
            }
        }
        if (beside) {
            body.addView(pauseButton, wrap(8));
            body.addView(liveButton, wrap(4));
            body.addView(guideButton, wrap(4));
            body.addView(tracksButton, wrap(4));
        } else {
            pauseRow.addView(pauseButton, wrap(0));
            pauseRow.addView(liveButton, wrap(4));
            otherRow.addView(guideButton, wrap(0));
            otherRow.addView(tracksButton, wrap(4));
        }
        phoneActions.setVisibility(beside ? View.GONE : View.VISIBLE);
    }

    /** Wires the phone's Pause or Play and Back to live, as a television's details offer them. */
    void offerPauseOnPhone(@Nullable PauseState pause, Runnable togglePause, Runnable backToLive) {
        pauseState = pause;
        if (pauseButton != null) {
            pauseButton.setOnClickListener(v -> {
                hide();
                togglePause.run();
            });
        }
        if (liveButton != null) {
            liveButton.setOnClickListener(v -> {
                hide();
                backToLive.run();
            });
        }
    }

    private void refreshPhoneButtons() {
        PauseState pause = pauseState;
        boolean canPause = pause != null && pause.canPause();
        if (pauseButton != null) {
            pauseButton.setVisibility(canPause ? View.VISIBLE : View.GONE);
            boolean paused = canPause && pause.paused();
            pauseButton.setText(Texts.t(paused ? "film.play" : "film.pause"));
            pauseButton.setIconKind(paused ? FilmUi.Icon.PLAY : FilmUi.Icon.PAUSE);
        }
        if (liveButton != null) {
            liveButton.setVisibility(canPause && pause.behind() ? View.VISIBLE : View.GONE);
        }
        if (guideButton != null) {
            guideButton.setVisibility(guideOffered != null && guideOffered.getAsBoolean() ? View.VISIBLE : View.GONE);
        }
        if (tracksButton != null) {
            tracksButton.setVisibility(tracksOffered != null && tracksOffered.getAsBoolean() ? View.VISIBLE : View.GONE);
        }
    }

    private void fillTimes() {
        Info channel = info;
        if (channel == null) {
            return;
        }
        long now = System.currentTimeMillis();

        boolean on = channel.hasGuide && channel.nowTitle != null && channel.nowStop > now;
        boolean next = channel.hasGuide && channel.nextTitle != null;

        String sleep = television ? SleepTimer.summary(now) : null;
        sleepLine.setVisibility(sleep == null ? View.GONE : View.VISIBLE);
        if (sleep != null) {
            sleepLine.setText(Texts.t("sleep.title") + " · " + sleep);
        }
        programme.setVisibility(on ? View.VISIBLE : View.GONE);
        nextRow.setVisibility(next ? View.VISIBLE : View.GONE);

        // What is on, large; with no guide the channel's own name takes its place.
        title.setText(on ? channel.nowTitle : channel.name);
        // Never twice: with no guide the name is the title, and the line above
        // keeps only the number and tags. A channel with no number showed its
        // name in both (a user's Top Gear, 31 October).
        name.setVisibility(on ? View.VISIBLE : View.GONE);
        if (on) {
            time.setText(clock(channel.nowStart));
            stop.setText(clock(channel.nowStop));
            long span = Math.max(1L, channel.nowStop - channel.nowStart);
            progress.fraction = Math.max(0f, Math.min(1f, (now - channel.nowStart) / (float) span));
            progress.invalidate();
        }
        if (next) {
            nextLabel.setText(Texts.t("banner.nextKicker", clock(channel.nextStart)));
            nextTitle.setText(channel.nextTitle);
        }
    }

    private static String clock(long ms) {
        return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(ms));
    }

    // --- Building ------------------------------------------------------------

    private TextView text(float size, int colour, int style) {
        TextView view = new TextView(activity);
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * unit);
        view.setTextColor(colour);
        view.setTypeface(Typeface.create("sans-serif", style));
        view.setIncludeFontPadding(false);
        return view;
    }

    private static void ellipsize(TextView view) {
        view.setSingleLine(true);
        view.setEllipsize(TextUtils.TruncateAt.END);
    }

    private static LinearLayout row(Activity activity) {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setBaselineAligned(true);
        return row;
    }

    private LinearLayout.LayoutParams stacked(int gap) {
        return sized(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, gap);
    }

    private LinearLayout.LayoutParams sized(int width, int height, int gap) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, height);
        params.topMargin = px(gap);
        return params;
    }

    private LinearLayout.LayoutParams wrap(int leftGap) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.leftMargin = px(leftGap);
        return params;
    }

    /** Takes what width is left, but no more than its text needs. */
    private LinearLayout.LayoutParams flexible(int leftGap) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        params.width = 0;
        params.leftMargin = px(leftGap);
        return params;
    }

    private int px(float designPx) {
        return Math.round(designPx * unit);
    }

    /** The programme's bar: a pale track over the picture, and the part already shown in --air, as LIVE is. */
    private static final class Progress extends View {
        float fraction = 0f;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        Progress(Activity activity) {
            super(activity);
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            float radius = getHeight() / 2f;
            paint.setColor(FilmUi.TRACK_ON_PICTURE);
            canvas.drawRoundRect(0, 0, getWidth(), getHeight(), radius, radius, paint);
            paint.setColor(ChannelOverlay.AIR);
            canvas.drawRoundRect(0, 0, getWidth() * fraction, getHeight(), radius, radius, paint);
        }
    }

    /** The diagonal stripes that stand for "no guide" wherever a plate appears. */
    private static final class Hatched extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final int stripe;
        private final int radius;
        private final Path clip = new Path();

        Hatched(int stripe, int radius) {
            this.stripe = Math.max(2, stripe);
            this.radius = radius;
        }

        @Override
        public void draw(@NonNull Canvas canvas) {
            Rect box = getBounds();
            clip.reset();
            clip.addRoundRect(box.left, box.top, box.right, box.bottom, radius, radius, Path.Direction.CW);
            canvas.save();
            canvas.clipPath(clip);
            paint.setColor(HATCH_DARK);
            canvas.drawRect(box, paint);
            paint.setColor(HATCH_LIGHT);
            paint.setStrokeWidth(stripe);
            int reach = box.width() + box.height();
            for (int x = -box.height(); x < reach; x += stripe * 2) {
                canvas.drawLine(box.left + x, box.bottom, box.left + x + box.height(), box.top, paint);
            }
            canvas.restore();
        }

        @Override
        public void setAlpha(int alpha) {}

        @Override
        public void setColorFilter(@Nullable ColorFilter colorFilter) {}

        @Override
        public int getOpacity() {
            return PixelFormat.OPAQUE;
        }
    }
}
