package app.tvinto.player;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.SpannableString;
import android.text.Spanned;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * The controls for a film or an episode: design section 5b.
 *
 * PL-TV-5 (the controls panel), PL-TV-5b (seeking with the controls hidden),
 * PL-TV-5c (the audio and subtitles rail), PX-TV-9 to PX-TV-11 (opening,
 * resumed, waiting) and, on a phone, PL-P-2 and PX-P-5. They replace the video
 * library's stock controls, which showed no title, drew focus as a thin green
 * square against the screen's edge and offered Previous and Next buttons that
 * did nothing useful; and VLC, which had no controls at all, gets the same.
 *
 * Three overlays take the remote: the controls, the rail and (later) the
 * next-episode card. The seek strip, the opening and the waiting ring
 * never do -- every key goes through them to the player. Focus is drawn, not
 * Android's: the activity hands every key here first, as it does for
 * ChannelSession, and the views themselves are never focusable.
 *
 * Live channels do not come here; their player is unchanged.
 */
final class FilmControls {

    /** "film" or "episode". Anything else, or nothing, keeps the stock controls. */
    static final String EXTRA_KIND = "filmKind";
    /** An episode's show, drawn small above its title. */
    static final String EXTRA_HEADING = "filmHeading";
    /** "Dune: Part Two", or "S1 E3 · Long, Long Time". */
    static final String EXTRA_NAME = "filmName";
    /** "2024": what the app knows that the player does not. The runtime is added here. */
    static final String EXTRA_META = "filmMeta";
    static final String EXTRA_POSTER = "filmPoster";
    /** The opening panel's reason line, when the app has a better one. */
    static final String EXTRA_OPENING_LINE = "openingLine";
    /** What it is about, for the screen a long pause brings up (PX-TV-8). */
    static final String EXTRA_DESCRIPTION = "filmDescription";

    /**
     * How long a pause lasts, untouched, before the picture dims and says what
     * is paused (PX-TV-8). Netflix publishes no figure; one forum guess was
     * "around 10 seconds", and a user remembers it as longer than 15. Set
     * by them timing their own television.
     */
    static final long PAUSED_SCREEN_AFTER_MS = 30_000L;

    /** JSON: the episodes that follow this one ({ ahead, end }; EpisodesAhead in film-presentation.utils.ts). */
    static final String EXTRA_UP_NEXT = "upNext";

    /** JSON: an array of { kind, startMs, endMs }, the stretches to offer to skip (shared/tmdb/introdb.ts). */
    static final String EXTRA_SKIPS = "skips";

    /** "button", "auto" (skip by itself) or "off" (nothing, not even from chapters). */
    static final String EXTRA_SKIP_MODE = "skipIntros";

    /** PL-TV-6b: the card shows in the last 30 s, and counts down from 10. */
    private static final long CARD_BEFORE_END_MS = 30_000L;
    private static final long COUNTDOWN_MS = 10_000L;

    /** How far up the subtitles go while the controls, the strip or the card are up. */
    private static final float SUBTITLES_OVER_CONTROLS = 0.34f;
    /**
     * The provider goes on counting a closed stream for a moment, and allows
     * one: the next episode opened the instant the last one stopped was turned
     * away (The Last Bus, E2 to E3 part way through the credits, 24 September).
     * The same pause and single retry as changing channel
     * (CHANNEL_CHANGE_PAUSE_MS and refusedAfterChange in the web app).
     */
    private static String defaultOpeningLine() {
        return Texts.t("film.opening");
    }
    private static final long SWITCH_PAUSE_MS = 1500L;
    private static final long RETRY_AFTER_MS = 3000L;

    private static final long HIDE_AFTER_MS = 5000L;
    private static final long BUFFERING_AFTER_MS = 1000L;
    /** Held keys repeat faster than a seek should move; this paces them. */
    private static final long REPEAT_PACE_MS = 110L;

    /** As in ChannelSession: on Android 16 Back arrives by callback and as a key. */
    private static final boolean BACK_BY_CALLBACK = Build.VERSION.SDK_INT >= 36;

    private final Activity activity;
    private final FilmPlayback player;
    private final boolean television;
    private final boolean episode;
    private final FilmUi ui;
    /** The opening and resumed panels, which have no phone board, at a size a phone can hold. */
    private final FilmUi small;
    private final Handler clock = new Handler(Looper.getMainLooper());
    private final FilmSeek seek = new FilmSeek();

    // What is playing. Not final: the next episode replaces them (PL-TV-6b).
    private String heading;
    private String name;
    private String knownMeta;
    /** What it is about; empty when the app had nothing to say. */
    private String description;
    private long startAtMs;
    /** The web app's id for it, handed back when the next episode is asked for. */
    private String itemId;
    /** What follows it, for the next-episode card; null for a film. */
    @Nullable
    private UpNext upNext;
    /** What follows, with addresses, so the player can go on by itself. */
    private EpisodesAhead episodes = EpisodesAhead.none();

    // The views that name it, so the next episode can rename them.
    private final ImageView plate;
    private final TextView headingView;
    private final TextView titleView;
    private final TextView stripTitle;
    private final TextView openingShow;
    private final TextView openingTitle;
    private final TextView openingWhere;

    // PX-TV-7: the next episode's still and name in the corner, and one button that fills
    private final View card;
    private final TextView cardKicker;
    private final ImageView cardPoster;
    private final TextView cardTitle;
    private final FilmUi.Pill cardPrimary;
    private final FilmUi.Pill cardSecondary;
    private int cardFocus = 0;
    /** Cancelled or watched through: no second offer for this episode. */
    private boolean cardDone = false;
    /** How much of the countdown is left, in milliseconds; it stops while paused. */
    private long countdownLeft = COUNTDOWN_MS;
    /** Asked the web app for the next episode, and waiting for it. */
    private boolean awaitingNext = false;
    /** The next episode's address until its first frame, for the one retry. */
    @Nullable
    private String nextUrl = null;
    private int nextAttempt = 0;
    /** When this player last closed its stream (uptime ms), so the next opens after the pause. */
    private long stoppedAt = 0L;
    @Nullable
    private FilmUi.Button nextButton;
    /** The sleep timer's way in, on a television; its words say how long is left. */
    @Nullable
    private FilmUi.Button sleepButton = null;

    private final FrameLayout root;
    private final View scrim;

    // PX-TV-1, PX-TV-2, PX-P-1: the whole screen, fades top and bottom, no panel
    private final View controls;
    private final TextView metaLine;
    private final TextView pausedLabel;
    private final FilmUi.Bar bar;
    private final TextView elapsed;
    private final TextView remaining;
    @Nullable
    private final TextView ends;
    private final FilmUi.Pill playButton;
    /** The phone's play and pause, in the middle of the picture. */
    @Nullable
    private FilmUi.RoundIcon centrePlay = null;
    private final FilmUi.Pill tracksButton;
    private final FilmUi.Pill speedButton;
    @Nullable
    private FilmUi.Pill episodesButton = null;
    private final List<FilmUi.Button> buttons = new ArrayList<>();
    private int focused = 0;

    // PX-TV-4: the speeds, in place of the row of controls
    private static final float[] SPEEDS = { 0.5f, 0.75f, 1f, 1.25f, 1.5f };
    private final LinearLayout buttonRow;
    private final View speedChoice;
    private final List<FilmUi.Pill> speedPills = new ArrayList<>();
    private int speedFocus = 2;

    // PX-TV-3, PX-P-2: Episodes, over the picture
    private final List<Season> seasons;
    private final View episodesLayer;
    private final LinearLayout seasonChips;
    private final LinearLayout episodeList;
    private final ViewGroup episodeScroll;
    private final TextView episodesShow;
    private final List<FilmUi.Pill> seasonPills = new ArrayList<>();
    private final List<FilmUi.EpisodeCard> episodeCards = new ArrayList<>();
    private int seasonShown = 0;
    private int episodeFocus = 0;
    private boolean onSeasonChips = false;
    /** Where an episode chosen from Episodes starts, once it shows a picture; 0 for none. */
    private long seekOnStartMs = 0L;

    // PX-TV-5: Audio & subtitles in two columns, a television's
    private final List<FilmUi.ChoiceRow> choiceRows = new ArrayList<>();
    private final List<FilmPlayback.Track> choiceTracks = new ArrayList<>();
    /** Which column each choice is in: 0 audio, 1 subtitles, 2 the lines below. */
    private final List<Integer> choiceGroups = new ArrayList<>();
    @Nullable
    private LinearLayout audioChoices = null;
    @Nullable
    private LinearLayout subtitleChoices = null;
    @Nullable
    private LinearLayout lineChoices = null;
    private int choiceFocus = 0;

    // PL-TV-5b
    private final View strip;
    private final TextView stripTarget;
    private final TextView stripOffset;
    private final TextView stripStep;
    private final TextView stripHint;
    private final FilmUi.Bar stripBar;
    private final TextView stripFrom;

    // PX-TV-9 to PX-TV-11
    private final View opening;
    private final FilmUi.Ring openingRing;
    private final TextView openingLine;
    private final View buffering;
    private final FilmUi.Ring bufferingRing;
    /** Where a resumed film or episode puts focus first (PX-TV-10); a phone has none. */
    @Nullable
    private FilmUi.Pill startOverButton = null;

    // PL-TV-5c, and the phone's sheet
    private final View railLayer;
    private final LinearLayout railList;
    private final ScrollView railScroll;
    private final List<FilmUi.RailRow> railRows = new ArrayList<>();
    private final List<FilmPlayback.Track> railTracks = new ArrayList<>();
    private int railFocus = 0;

    // PL-P-2: the double-tap ripple and the time over a dragged thumb
    @Nullable
    private Ripple ripple;
    @Nullable
    private TextView dragLabel;
    private int tapSide = 0;

    private boolean started = false;
    private boolean paused = false;
    private boolean bufferingNow = false;
    private boolean seekShownInPanel = false;
    private long lastStepAt = 0L;
    @Nullable
    private Object backCallback = null;

    private final Runnable hideControlsLater = this::hideControls;
    private final Runnable commitSeekLater = this::commitSeek;
    private final Runnable hideStripLater = this::hideStrip;
    private final Runnable showBufferingLater = this::showBuffering;
    private final Runnable showWatchingLater = this::showWatching;

    // PX-TV-8, PX-P-4: a pause that has lasted a while
    private final View watching;
    private final TextView watchingTitle;
    private final TextView watchingEpisode;
    private final TextView watchingMeta;
    private final TextView watchingAbout;
    private final Runnable startedWithoutPicture = this::onFirstFrame;
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            refreshTimes();
            clock.postDelayed(this, 500L);
        }
    };
    /** Whether an intro or a recap is on now, and the button to skip it. */
    private final Runnable skipWatch = new Runnable() {
        @Override
        public void run() {
            refreshSkip();
            clock.postDelayed(this, 500L);
        }
    };
    /** Watches for the last 30 s of an episode with something after it. */
    private final Runnable endWatch = new Runnable() {
        @Override
        public void run() {
            maybeShowCard();
            clock.postDelayed(this, 1000L);
        }
    };
    private final Runnable countdown = new Runnable() {
        @Override
        public void run() {
            if (!isShowing(card) || upNext == null || upNext.last) {
                return;
            }
            if (!paused) {
                countdownLeft -= 100L;
            }
            drawCountdown();
            if (countdownLeft <= 0) {
                requestNext();
                return;
            }
            clock.postDelayed(this, 100L);
        }
    };

    /** One episode ahead, as the web app handed it over. Its address carries credentials: never logged. */
    static final class Ahead {
        final String itemId;
        final String url;
        final String showName;
        final String title;
        final String cardHeading;
        final String cardTitle;
        final String label;
        @Nullable
        final String poster;
        final String description;
        final SkipTimes skips;

        Ahead(org.json.JSONObject data) {
            itemId = data.optString("itemId", "");
            url = data.optString("url", "");
            showName = data.optString("showName", "");
            title = data.optString("title", "");
            cardHeading = data.optString("cardHeading", "");
            cardTitle = data.optString("cardTitle", "");
            label = data.optString("label", "");
            String described = data.optString("description", "");
            description = "null".equals(described) ? "" : described;
            String image = data.optString("poster", "");
            poster = image.isEmpty() || "null".equals(image) ? null : image;
            skips = skipsFrom(data.optJSONArray("skips"));
        }
    }

    /** The skips the web app handed over, as JSON. Anything malformed is left out. */
    static SkipTimes skipsFrom(@Nullable org.json.JSONArray array) {
        List<SkipTimes.Skip> list = new ArrayList<>();
        for (int i = 0; array != null && i < array.length(); i++) {
            org.json.JSONObject one = array.optJSONObject(i);
            if (one == null) {
                continue;
            }
            String kind = one.optString("kind", "");
            long start = one.optLong("startMs", -1L);
            long end = one.optLong("endMs", -1L);
            if (!kind.isEmpty() && start >= 0 && end > start) {
                list.add(new SkipTimes.Skip(kind, start, end));
            }
        }
        return new SkipTimes(list);
    }

    static SkipTimes skipsFrom(@Nullable String json) {
        if (json == null || json.isEmpty()) {
            return SkipTimes.none();
        }
        try {
            return skipsFrom(new org.json.JSONArray(json));
        } catch (org.json.JSONException ignored) {
            return SkipTimes.none();
        }
    }

    /** The episodes that follow, and the season's end if the list reaches it. */
    static final class EpisodesAhead {
        final java.util.List<Ahead> ahead;
        /** "The Last of Us · end of season 1", or null when the list does not reach the end. */
        @Nullable
        final String end;

        EpisodesAhead(java.util.List<Ahead> ahead, @Nullable String end) {
            this.ahead = ahead;
            this.end = end;
        }

        static EpisodesAhead none() {
            return new EpisodesAhead(new java.util.ArrayList<>(), null);
        }

        static EpisodesAhead from(@Nullable String json) {
            if (json == null || json.isEmpty()) {
                return none();
            }
            try {
                return from(new org.json.JSONObject(json));
            } catch (org.json.JSONException ignored) {
                return none();
            }
        }

        static EpisodesAhead from(@Nullable org.json.JSONObject data) {
            if (data == null) {
                return none();
            }
            java.util.List<Ahead> list = new java.util.ArrayList<>();
            org.json.JSONArray array = data.optJSONArray("ahead");
            for (int i = 0; array != null && i < array.length(); i++) {
                org.json.JSONObject one = array.optJSONObject(i);
                if (one != null && !one.optString("url", "").isEmpty()) {
                    list.add(new Ahead(one));
                }
            }
            String end = data.optString("end", "");
            return new EpisodesAhead(list, end.isEmpty() || "null".equals(end) ? null : end);
        }

        /** The list after the first, for the episode the player goes on to. */
        EpisodesAhead rest() {
            return new EpisodesAhead(new java.util.ArrayList<>(ahead.subList(Math.min(1, ahead.size()), ahead.size())), end);
        }

        /** What the card says: the next episode, the season's end, or nothing known yet. */
        @Nullable
        UpNext card() {
            if (!ahead.isEmpty()) {
                Ahead next = ahead.get(0);
                return new UpNext(false, next.cardHeading, next.cardTitle, next.label, next.poster);
            }
            return end == null ? null : new UpNext(true, end, "", "", null);
        }
    }

    /** What the next-episode card says. */
    static final class UpNext {
        final boolean last;
        final String heading;
        final String title;
        final String label;
        @Nullable
        final String poster;

        UpNext(boolean last, String heading, String title, String label, @Nullable String poster) {
            this.last = last;
            this.heading = heading;
            this.title = title;
            this.label = label;
            this.poster = poster;
        }
    }

    /** One episode in Episodes (PX-TV-3): what the card says, and where OK starts it. */
    static final class Listed {
        final Ahead ahead;
        final String number;
        final String name;
        final String length;
        final float watched;
        final long startAtMs;

        Listed(org.json.JSONObject data) {
            ahead = new Ahead(data);
            number = data.optString("number", "");
            name = data.optString("name", "");
            length = data.optString("length", "");
            watched = (float) data.optDouble("watched", 0d);
            startAtMs = Math.max(0L, data.optLong("startAtSeconds", 0L)) * 1000L;
        }
    }

    /** A season of the show: its chip, what the card says after it, and its episodes. */
    static final class Season {
        final String label;
        final String end;
        final List<Listed> episodes = new ArrayList<>();

        Season(org.json.JSONObject data) {
            label = data.optString("label", "");
            end = data.optString("end", "");
            org.json.JSONArray array = data.optJSONArray("episodes");
            for (int i = 0; array != null && i < array.length(); i++) {
                org.json.JSONObject one = array.optJSONObject(i);
                if (one != null && !one.optString("url", "").isEmpty()) {
                    episodes.add(new Listed(one));
                }
            }
        }

        static List<Season> from(@Nullable org.json.JSONObject data) {
            List<Season> out = new ArrayList<>();
            org.json.JSONArray array = data == null ? null : data.optJSONArray("seasons");
            for (int i = 0; array != null && i < array.length(); i++) {
                org.json.JSONObject one = array.optJSONObject(i);
                if (one != null) {
                    Season season = new Season(one);
                    if (!season.episodes.isEmpty()) {
                        out.add(season);
                    }
                }
            }
            return out;
        }
    }

    /**
     * The show's seasons for the player about to open, handed over beside the
     * intent rather than in it: a long show runs to hundreds of episodes, and
     * an intent past Binder's limit fails to start at all.
     */
    @Nullable
    private static volatile org.json.JSONObject handedSeasons = null;

    static void handSeasons(@Nullable org.json.JSONObject seasons) {
        handedSeasons = seasons;
    }

    /** The open controls, for NativePlayerPlugin to hand more of the season to. */
    private static volatile java.lang.ref.WeakReference<FilmControls> open = new java.lang.ref.WeakReference<>(null);

    @Nullable
    static FilmControls running() {
        return open.get();
    }

    /** Controls for this player, or null when what is playing is not a film or an episode. */
    @Nullable
    static FilmControls start(Activity activity, FilmPlayback player) {
        String kind = activity.getIntent().getStringExtra(EXTRA_KIND);
        if (!"film".equals(kind) && !"episode".equals(kind)) {
            return null;
        }
        FilmControls controls = new FilmControls(activity, player, "episode".equals(kind));
        open = new java.lang.ref.WeakReference<>(controls);
        return controls;
    }

    private FilmControls(Activity activity, FilmPlayback player, boolean episode) {
        this.activity = activity;
        this.player = player;
        this.episode = episode;
        UiModeManager modes = (UiModeManager) activity.getSystemService(Context.UI_MODE_SERVICE);
        this.television = modes != null && modes.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        float density = activity.getResources().getDisplayMetrics().density;
        if (!television) {
            // PL-P-2 is drawn landscape, and a film held upright is a letterbox
            // a third of the screen tall with the controls below it.
            activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        }
        this.ui = new FilmUi(activity, television ? ChannelOverlay.unitFor(activity) : density);
        this.small = television ? ui : new FilmUi(activity, density * 0.45f);

        Intent intent = activity.getIntent();
        heading = orEmpty(intent.getStringExtra(EXTRA_HEADING));
        String given = orEmpty(intent.getStringExtra(EXTRA_NAME));
        name = given.isEmpty() ? orEmpty(intent.getStringExtra(PlayerActivity.EXTRA_TITLE)) : given;
        knownMeta = orEmpty(intent.getStringExtra(EXTRA_META));
        description = orEmpty(intent.getStringExtra(EXTRA_DESCRIPTION));
        startAtMs = intent.getLongExtra(PlayerActivity.EXTRA_START_AT, 0L) * 1000L;
        itemId = orEmpty(intent.getStringExtra(ChannelKeys.EXTRA_ITEM_ID));
        episodes = episode ? EpisodesAhead.from(intent.getStringExtra(EXTRA_UP_NEXT)) : EpisodesAhead.none();
        upNext = episodes.card();
        skipMode = orEmpty(intent.getStringExtra(EXTRA_SKIP_MODE));
        handedSkips = "off".equals(skipMode) ? SkipTimes.none() : skipsFrom(intent.getStringExtra(EXTRA_SKIPS));
        skips = handedSkips;
        org.json.JSONObject givenSeasons = handedSeasons;
        handedSeasons = null;
        seasons = episode ? Season.from(givenSeasons) : new ArrayList<>();
        PlaybackReports.item(itemId.isEmpty() ? null : itemId);
        applyKeptDelay();
        String poster = intent.getStringExtra(EXTRA_POSTER);
        int spine = episode ? FilmUi.SERIES : FilmUi.FILM;

        root = new FrameLayout(activity);
        root.setFocusable(false);
        root.setClipChildren(false);

        scrim = new View(activity);
        scrim.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
            new int[] { FilmUi.scrim(0.96f), FilmUi.scrim(0.82f), FilmUi.scrim(0f) }));
        scrim.setVisibility(View.GONE);
        root.addView(scrim, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ui.px(television ? 600 : 260), Gravity.BOTTOM));

        // --- PX-TV-1, PX-TV-2, PX-P-1 ---------------------------------------------------
        // The picture to every edge, and two fades that carry the words.
        FrameLayout layer = new FrameLayout(activity);
        layer.setClipChildren(false);
        // A phone plays these sideways, and may still be upright while this is built:
        // its height then is the shorter side.
        android.util.DisplayMetrics shape = activity.getResources().getDisplayMetrics();
        int tall = television ? shape.heightPixels : Math.min(shape.widthPixels, shape.heightPixels);
        View topFade = new View(activity);
        topFade.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] { FilmUi.fade(0.85f), FilmUi.fade(0f) }));
        layer.addView(topFade, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.round(tall * 0.32f), Gravity.TOP));
        View bottomFade = new View(activity);
        bottomFade.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
            new int[] { FilmUi.fade(0.94f), FilmUi.fade(0.6f), FilmUi.fade(0f) }));
        layer.addView(bottomFade, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.round(tall * (television ? 0.42f : 0.45f)), Gravity.BOTTOM));
        if (!television) {
            // PX-P-1 dims the whole picture a little, so the middle's controls read.
            View dim = new View(activity);
            dim.setBackgroundColor(FilmUi.fade(0.35f));
            layer.addView(dim, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        controls = layer;

        // The title, top left: the show and episode above an episode's own name.
        LinearLayout top = ui.row(false);
        if (!television) {
            FilmUi.RoundIcon leave = new FilmUi.RoundIcon(activity, FilmUi.Icon.BACK, false);
            leave.setOnClickListener(v -> player.close());
            top.addView(leave, new LinearLayout.LayoutParams(ui.px(40), ui.px(40)));
        }
        LinearLayout words = ui.column(0);
        top.addView(words, ui.stretch(television ? 0 : 8));
        headingView = ui.text(television ? 30 : 12, FilmUi.SOFT, Typeface.NORMAL);
        headingView.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        FilmUi.oneLine(headingView);
        headingView.setText(heading);
        TextView title = ui.text(television ? 56 : 17, FilmUi.WHITE, Typeface.BOLD);
        FilmUi.oneLine(title);
        title.setText(name);
        titleView = title;
        metaLine = ui.text(television ? 26 : 12, FilmUi.QUIET, Typeface.NORMAL);
        FilmUi.oneLine(metaLine);
        ui.stack(words, headingView, 0);
        headingView.setVisibility(episode && !heading.isEmpty() ? View.VISIBLE : View.GONE);
        ui.stack(words, title, television ? 10 : 1);
        if (television) {
            ui.stack(words, metaLine, 10);
        }
        // The plate is kept for the next episode's poster, and not drawn: the picture is the picture.
        plate = new ImageView(activity);
        FrameLayout.LayoutParams topAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
        topAt.leftMargin = ui.px(television ? 96 : 12);
        topAt.rightMargin = ui.px(television ? 360 : 20);
        topAt.topMargin = ui.px(television ? 72 : 12);
        layer.addView(top, topAt);

        pausedLabel = ui.label(television ? 24 : 12, FilmUi.SOFT, 0.14f);
        pausedLabel.setText(Texts.t("film.paused"));
        pausedLabel.setVisibility(View.GONE);
        FrameLayout.LayoutParams pausedAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        pausedAt.rightMargin = ui.px(television ? 96 : 20);
        pausedAt.topMargin = ui.px(television ? 84 : 22);
        if (television) {
            layer.addView(pausedLabel, pausedAt);
        }

        // A phone's middle: back 10 s, play or pause, forward 10 s, where a thumb is.
        if (!television) {
            LinearLayout middle = ui.row(false);
            middle.setGravity(Gravity.CENTER);
            FilmUi.RoundIcon back = new FilmUi.RoundIcon(activity, FilmUi.Icon.BACK_10, false);
            back.setOnClickListener(v -> jump(-10_000L));
            FilmUi.RoundIcon forward = new FilmUi.RoundIcon(activity, FilmUi.Icon.FORWARD_10, false);
            forward.setOnClickListener(v -> jump(10_000L));
            centrePlay = new FilmUi.RoundIcon(activity, FilmUi.Icon.PAUSE, true);
            centrePlay.setOnClickListener(v -> togglePlaying());
            middle.addView(back, new LinearLayout.LayoutParams(ui.px(56), ui.px(56)));
            LinearLayout.LayoutParams playAt = new LinearLayout.LayoutParams(ui.px(72), ui.px(72));
            playAt.leftMargin = ui.px(64);
            playAt.rightMargin = ui.px(64);
            middle.addView(centrePlay, playAt);
            middle.addView(forward, new LinearLayout.LayoutParams(ui.px(56), ui.px(56)));
            layer.addView(middle, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        }

        // Along the bottom: the bar as wide as the screen, then one row of controls.
        LinearLayout bottom = ui.column(0);
        bar = new FilmUi.Bar(activity, ui.unit);
        bar.thickness = television ? 8 : 4;
        bar.thumb = television ? 24 : 14;
        bar.showThumb = true;
        elapsed = ui.mono(television ? 28 : 13, FilmUi.WHITE, true);
        remaining = ui.mono(television ? 28 : 13, FilmUi.WHITE, true);
        LinearLayout line = ui.row(false);
        line.addView(bar, new LinearLayout.LayoutParams(0, ui.px(television ? 28 : 28), 1f));
        line.addView(remaining, ui.beside(television ? 28 : 12));
        if (television) {
            ends = ui.text(26, FilmUi.QUIET, Typeface.NORMAL);
            line.addView(ends, ui.beside(28));
        } else {
            ends = null;
        }
        ui.stack(bottom, line, 0);

        float height = television ? 76 : 40;
        float size = television ? 28 : 14;
        float pad = television ? 24 : 8;
        float iconSize = television ? 34 : 20;
        buttonRow = ui.row(false);
        playButton = ui.pill(FilmUi.Icon.PAUSE, "", height, pad, size, iconSize);
        playButton.setOnClickListener(v -> togglePlaying());
        tracksButton = ui.pill(FilmUi.Icon.TRACKS, Texts.t("film.audioSubtitles"), height, pad, size, iconSize);
        tracksButton.setOnClickListener(v -> openRail());
        speedButton = ui.pill(FilmUi.Icon.SPEED, Texts.t("film.speed"), height, pad, size, iconSize);
        speedButton.setOnClickListener(v -> openSpeed());
        FilmUi.Pill overButton = ui.pill(FilmUi.Icon.START_OVER, Texts.t("film.startOver"), height, pad, size, iconSize);
        overButton.setOnClickListener(v -> startOver());
        FilmUi.Pill next = null;
        if (episode) {
            // Absent, not disabled, when nothing follows in the season.
            next = ui.pill(FilmUi.Icon.NEXT, Texts.t("film.nextEpisode"), height, pad, size, iconSize);
            next.setOnClickListener(v -> requestNext());
            nextButton = next;
            if (!seasons.isEmpty()) {
                episodesButton = ui.pill(FilmUi.Icon.EPISODES, Texts.t("film.episodes"), height, pad, size, iconSize);
                episodesButton.setOnClickListener(v -> openEpisodes());
            }
        }
        List<FilmUi.Button> row = new ArrayList<>();
        if (television) {
            // PX-TV-1 and PX-TV-2, in their order. Play first, so OK, OK is still a safe pause and resume.
            row.add(playButton);
            if (episodesButton != null) {
                row.add(episodesButton);
            }
            if (next != null) {
                row.add(next);
            }
            row.add(tracksButton);
            row.add(speedButton);
            row.add(overButton);
            startOverButton = overButton;
            FilmUi.Pill sleep = ui.pill(FilmUi.Icon.SLEEP, Texts.t("sleep.title"), height, pad, size, iconSize);
            sleep.setOnClickListener(v -> openSleepTimer());
            sleepButton = sleep;
            row.add(sleep);
        } else {
            // PX-P-1: play and pause are in the middle; Start over is the bar dragged to its start.
            row.add(speedButton);
            if (episodesButton != null) {
                row.add(episodesButton);
            }
            row.add(tracksButton);
            if (next != null) {
                row.add(next);
            }
        }
        for (FilmUi.Button button : row) {
            buttons.add(button);
            if (television) {
                buttonRow.addView(button, ui.beside(buttonRow.getChildCount() == 0 ? 0 : 10));
            } else {
                // Spread across the width with even space around each, the
                // icon beside its word: a stretched button left the icon at
                // one edge of its share and the word in the middle.
                buttonRow.addView(ui.spring());
                buttonRow.addView(button, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            }
        }
        if (!television) {
            buttonRow.addView(ui.spring());
        }
        ui.stack(bottom, buttonRow, television ? 34 : 4);

        // PX-TV-4: the speeds take the row's place.
        LinearLayout speeds = ui.column(0);
        TextView speedTitle = ui.label(television ? 24 : 12, FilmUi.SOFT, 0.12f);
        speedTitle.setText(Texts.t("film.speedTitle"));
        ui.stack(speeds, speedTitle, 0);
        LinearLayout speedRow = ui.row(false);
        for (float speed : SPEEDS) {
            String said = speedWords(speed);
            FilmUi.Pill choice = ui.pill(-1, speed == 1f ? Texts.t("film.normal", said) : said, height, television ? 34 : 12, size, iconSize);
            choice.setOnClickListener(v -> chooseSpeed(speed));
            speedPills.add(choice);
            speedRow.addView(choice, ui.beside(speedRow.getChildCount() == 0 ? 0 : (television ? 12 : 4)));
        }
        ui.stack(speeds, speedRow, television ? 18 : 6);
        speeds.setVisibility(View.GONE);
        speedChoice = speeds;
        ui.stack(bottom, speeds, television ? 34 : 4);

        FrameLayout.LayoutParams bottomAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        bottomAt.leftMargin = ui.px(television ? 96 : 20);
        bottomAt.rightMargin = ui.px(television ? 96 : 20);
        bottomAt.bottomMargin = ui.px(television ? 72 : 8);
        layer.addView(bottom, bottomAt);

        root.addView(controls, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        controls.setVisibility(View.GONE);

        // --- PL-TV-5b ---------------------------------------------------------------
        // No panel: the seek is the bar along the foot of the picture, over the same fade (round 12).
        LinearLayout stripBody = ui.column(0);
        strip = stripBody;
        LinearLayout stripTop = ui.row(true);
        stripTarget = ui.mono(52, FilmUi.FG, true);
        stripOffset = ui.mono(30, FilmUi.PRIMARY_BRIGHT, true);
        stripStep = ui.text(24, FilmUi.MUTED, Typeface.NORMAL);
        stripHint = ui.text(22, FilmUi.DIM, Typeface.NORMAL);
        stripHint.setText(Texts.t("film.backCancels"));
        stripTop.addView(stripTarget);
        stripTop.addView(stripOffset, ui.beside(24));
        stripTop.addView(stripStep, ui.beside(24));
        stripTop.addView(ui.spring());
        stripTop.addView(stripHint);
        ui.stack(stripBody, stripTop, 0);
        stripBar = new FilmUi.Bar(activity, ui.unit);
        stripBar.thickness = 8;
        stripBar.thumb = 24;
        ui.stack(stripBody, sized(stripBar, ViewGroup.LayoutParams.MATCH_PARENT, 22), 20);
        LinearLayout stripBottom = ui.row(true);
        stripFrom = ui.text(22, FilmUi.DIM, Typeface.NORMAL);
        stripBottom.addView(stripFrom);
        stripBottom.addView(ui.spring());
        stripTitle = ui.text(22, FilmUi.DIM, Typeface.NORMAL);
        FilmUi.oneLine(stripTitle);
        stripTitle.setText(episode && !heading.isEmpty() ? heading + " · " + name : name);
        stripTitle.setMaxWidth(ui.px(700));
        stripBottom.addView(stripTitle);
        ui.stack(stripBody, stripBottom, 20);
        root.addView(strip, bottomWide());
        strip.setVisibility(View.GONE);

        // --- PX-TV-9: opening -----------------------------------------------------------
        // Black, the title where the controls put it, and a ring in the middle,
        // as Netflix opens a title. It was a panel with the poster, "OPENING"
        // and a meter (PL-TV-7).
        FrameLayout openingLayer = new FrameLayout(activity);
        openingLayer.setBackgroundColor(0xFF03060B);
        LinearLayout openingWords = ui.column(0);
        openingShow = ui.text(television ? 30 : 12, FilmUi.SOFT, Typeface.NORMAL);
        openingShow.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        FilmUi.oneLine(openingShow);
        ui.stack(openingWords, openingShow, 0);
        openingTitle = ui.text(television ? 56 : 17, FilmUi.WHITE, Typeface.BOLD);
        FilmUi.oneLine(openingTitle);
        ui.stack(openingWords, openingTitle, television ? 10 : 1);
        openingWhere = ui.text(television ? 26 : 12, FilmUi.QUIET, Typeface.NORMAL);
        FilmUi.oneLine(openingWhere);
        ui.stack(openingWords, openingWhere, television ? 10 : 2);
        // Only when it has something to say: a refusal being tried again, the backup player.
        openingLine = ui.text(television ? 26 : 12, FilmUi.QUIET, Typeface.NORMAL);
        openingLine.setMaxLines(2);
        ui.stack(openingWords, openingLine, television ? 10 : 2);
        FrameLayout.LayoutParams openingWordsAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
        openingWordsAt.leftMargin = ui.px(television ? 96 : 20);
        openingWordsAt.rightMargin = ui.px(television ? 360 : 20);
        openingWordsAt.topMargin = ui.px(television ? 72 : 12);
        openingLayer.addView(openingWords, openingWordsAt);
        openingRing = new FilmUi.Ring(activity, ui.unit);
        int openingSide = ui.px(television ? 96 : 48);
        openingLayer.addView(openingRing, new FrameLayout.LayoutParams(openingSide, openingSide, Gravity.CENTER));
        opening = openingLayer;
        root.addView(opening, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        String reason = intent.getStringExtra(EXTRA_OPENING_LINE);
        String where = startAtMs > 0 ? Texts.t("film.resumingAt", FilmSeek.clock(startAtMs)) : knownMeta;
        fillOpening(heading, name, where, reason == null || reason.isEmpty() ? defaultOpeningLine() : reason);

        // --- PX-TV-11: waiting for the provider -------------------------------------------
        // The picture dimmed a little and the ring, nothing else. It was a
        // panel saying "BUFFERING" and where it paused (PL-TV-7).
        FrameLayout bufferingLayer = new FrameLayout(activity);
        bufferingLayer.setBackgroundColor(FilmUi.fade(0.35f));
        bufferingRing = new FilmUi.Ring(activity, ui.unit);
        int bufferingSide = ui.px(television ? 96 : 48);
        bufferingLayer.addView(bufferingRing, new FrameLayout.LayoutParams(bufferingSide, bufferingSide, Gravity.CENTER));
        buffering = bufferingLayer;
        buffering.setVisibility(View.GONE);
        root.addView(buffering, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // --- PX-TV-7 -------------------------------------------------------------------
        // The next episode in the corner, over a fade from that corner, and one
        // button that fills as the countdown runs: full, it plays.
        FrameLayout cardLayer = new FrameLayout(activity);
        cardLayer.setClipChildren(false);
        View cornerFade = new View(activity);
        GradientDrawable corner = new GradientDrawable();
        corner.setGradientType(GradientDrawable.RADIAL_GRADIENT);
        corner.setColors(new int[] { FilmUi.fade(0.9f), FilmUi.fade(0f) });
        corner.setGradientCenter(1f, 1f);
        corner.setGradientRadius(ui.px(television ? 1100 : 420));
        cornerFade.setBackground(corner);
        cardLayer.addView(cornerFade, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        LinearLayout cardBody = ui.column(0);
        LinearLayout cardEpisode = ui.row(false);
        cardPoster = ui.poster(null, television ? 220 : 96, television ? 124 : 54);
        cardEpisode.addView(cardPoster);
        LinearLayout cardWords = ui.column(0);
        cardKicker = ui.label(television ? 22 : 11, FilmUi.SOFT, 0.08f);
        FilmUi.oneLine(cardKicker);
        cardTitle = ui.text(television ? 32 : 15, FilmUi.WHITE, Typeface.BOLD);
        cardTitle.setMaxLines(2);
        cardTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        ui.stack(cardWords, cardKicker, 0);
        ui.stack(cardWords, cardTitle, television ? 6 : 2);
        cardEpisode.addView(cardWords, ui.stretch(television ? 22 : 10));
        ui.stack(cardBody, cardEpisode, 0);
        LinearLayout cardRow = ui.row(false);
        float cardHeight = television ? 76 : 40;
        float cardSize = television ? 28 : 14;
        cardPrimary = ui.pill(FilmUi.Icon.PLAY, Texts.t("film.nextEpisode"), cardHeight, television ? 28 : 12, cardSize, television ? 28 : 16);
        cardSecondary = ui.pill(-1, Texts.t("film.watchCredits"), cardHeight, television ? 28 : 12, cardSize, 0);
        cardSecondary.edged = true;
        cardPrimary.edged = true;
        cardPrimary.setGravity(Gravity.CENTER);
        cardPrimary.setOnClickListener(v -> cardChoose(0));
        cardSecondary.setOnClickListener(v -> cardChoose(1));
        cardRow.addView(cardPrimary, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        cardRow.addView(cardSecondary, ui.beside(television ? 14 : 8));
        ui.stack(cardBody, cardRow, television ? 22 : 10);
        FrameLayout.LayoutParams cardAt = new FrameLayout.LayoutParams(
            Math.min(ui.px(television ? 620 : 330), activity.getResources().getDisplayMetrics().widthPixels - ui.px(48)),
            ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        cardAt.rightMargin = ui.px(television ? 96 : 20);
        cardAt.bottomMargin = ui.px(television ? 72 : 16);
        cardLayer.addView(cardBody, cardAt);
        card = cardLayer;
        root.addView(card, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        card.setVisibility(View.GONE);

        // Skip intro: one pill where the card would be. It never takes focus
        // from anything; OK presses it while nothing else is drawn.
        skipButton = ui.pill(-1, Texts.t("film.skipIntro"), television ? 64 : 36, television ? 32 : 14, television ? 26 : 13, 0);
        skipButton.edged = true;
        skipButton.setFocusedLook(television);
        skipButton.recolour();
        skipButton.setOnClickListener(v -> skipNow());
        FrameLayout.LayoutParams skipAt = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        skipAt.rightMargin = ui.px(television ? 96 : 20);
        skipAt.bottomMargin = ui.px(television ? 96 : 24);
        root.addView(skipButton, skipAt);
        skipButton.setVisibility(View.GONE);

        // --- PL-TV-5c, or the phone's sheet ----------------------------------------
        FrameLayout rail = new FrameLayout(activity);
        railList = new LinearLayout(activity);
        railList.setOrientation(television ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL);
        railScroll = new ScrollView(activity);
        railScroll.setVerticalScrollBarEnabled(false);
        railScroll.setFocusable(false);
        railScroll.addView(railList, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        if (television) {
            // PX-TV-5: two columns in the middle of a dimmed picture, and the
            // quieter settings in a line below them.
            rail.setBackgroundColor(FilmUi.fade(0.86f));
            LinearLayout columns = ui.row(false);
            columns.setGravity(Gravity.TOP | Gravity.CENTER_HORIZONTAL);
            audioChoices = ui.column(0);
            subtitleChoices = ui.column(0);
            columns.addView(audioChoices, new LinearLayout.LayoutParams(ui.px(480), ViewGroup.LayoutParams.WRAP_CONTENT));
            LinearLayout.LayoutParams subtitlesAt = new LinearLayout.LayoutParams(ui.px(480), ViewGroup.LayoutParams.WRAP_CONTENT);
            subtitlesAt.leftMargin = ui.px(140);
            columns.addView(subtitleChoices, subtitlesAt);
            railList.addView(columns, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            FrameLayout.LayoutParams columnsAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            columnsAt.topMargin = ui.px(110);
            columnsAt.bottomMargin = ui.px(260);
            rail.addView(railScroll, columnsAt);
            lineChoices = ui.column(0);
            lineChoices.setGravity(Gravity.CENTER_HORIZONTAL);
            FrameLayout.LayoutParams linesAt = new FrameLayout.LayoutParams(ui.px(640), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
            linesAt.bottomMargin = ui.px(72);
            rail.addView(lineChoices, linesAt);
        } else {
            rail.setBackgroundColor(0x8C03060D);
            rail.setClickable(true);
            rail.setOnClickListener(v -> closeRail());
            LinearLayout sheet = new LinearLayout(activity);
            sheet.setOrientation(LinearLayout.VERTICAL);
            sheet.setClickable(true);
            GradientDrawable ground = new GradientDrawable();
            ground.setColor(FilmUi.SHEET);
            float r = ui.px(12);
            ground.setCornerRadii(new float[] { r, r, r, r, 0, 0, 0, 0 });
            ground.setStroke(Math.max(1, ui.px(1)), FilmUi.BORDER_2);
            sheet.setBackground(ground);
            sheet.setPadding(ui.px(20), ui.px(10), ui.px(20), ui.px(16));
            View handle = new View(activity);
            GradientDrawable handleShape = new GradientDrawable();
            handleShape.setColor(FilmUi.BORDER_2);
            handleShape.setCornerRadius(ui.px(2));
            handle.setBackground(handleShape);
            LinearLayout.LayoutParams handleAt = new LinearLayout.LayoutParams(ui.px(44), ui.px(4));
            handleAt.gravity = Gravity.CENTER_HORIZONTAL;
            handleAt.bottomMargin = ui.px(10);
            sheet.addView(handle, handleAt);
            sheet.addView(railScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            int tallest = Math.round(activity.getResources().getDisplayMetrics().heightPixels * 0.72f);
            railScroll.addOnLayoutChangeListener((v, l, t, rr, b, ol, ot, orr, ob) -> {
                if (v.getHeight() > tallest) {
                    v.getLayoutParams().height = tallest;
                    v.requestLayout();
                }
            });
            FrameLayout.LayoutParams sheetAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
            sheetAt.leftMargin = ui.px(112);
            sheetAt.rightMargin = ui.px(112);
            rail.addView(sheet, sheetAt);
        }
        railLayer = rail;
        railLayer.setVisibility(View.GONE);
        root.addView(railLayer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // --- PX-TV-8, PX-P-4: paused a while ------------------------------------------
        // The picture dimmed, heaviest on the left where the words are, and
        // what is paused: the show, the episode, where it stopped, what it is about.
        FrameLayout watchingFrame = new FrameLayout(activity);
        watchingFrame.setBackgroundColor(FilmUi.fade(0.55f));
        View watchingFade = new View(activity);
        watchingFade.setBackground(new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
            new int[] { FilmUi.fade(0.92f), FilmUi.fade(0.7f), FilmUi.fade(0f) }));
        watchingFrame.addView(watchingFade, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        TextView watchingPaused = ui.label(television ? 24 : 12, FilmUi.SOFT, 0.14f);
        watchingPaused.setText(Texts.t("film.paused"));
        FrameLayout.LayoutParams watchingPausedAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        watchingPausedAt.rightMargin = ui.px(television ? 96 : 20);
        watchingPausedAt.topMargin = ui.px(television ? 84 : 16);
        watchingFrame.addView(watchingPaused, watchingPausedAt);
        LinearLayout watchingWords = ui.column(0);
        TextView watchingKicker = ui.label(television ? 24 : 11, FilmUi.SOFT, 0.14f);
        watchingKicker.setText(Texts.t("film.youreWatching"));
        ui.stack(watchingWords, watchingKicker, 0);
        watchingTitle = ui.text(television ? 64 : 26, FilmUi.WHITE, Typeface.BOLD);
        watchingTitle.setMaxLines(2);
        watchingTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        ui.stack(watchingWords, watchingTitle, television ? 14 : 4);
        watchingEpisode = ui.text(television ? 32 : 15, FilmUi.WHITE, Typeface.BOLD);
        FilmUi.oneLine(watchingEpisode);
        ui.stack(watchingWords, watchingEpisode, television ? 14 : 4);
        watchingMeta = ui.text(television ? 26 : 12, FilmUi.QUIET, Typeface.NORMAL);
        FilmUi.oneLine(watchingMeta);
        ui.stack(watchingWords, watchingMeta, television ? 14 : 4);
        watchingAbout = ui.text(television ? 28 : 13, FilmUi.SOFT, Typeface.NORMAL);
        watchingAbout.setMaxLines(television ? 5 : 3);
        watchingAbout.setEllipsize(android.text.TextUtils.TruncateAt.END);
        watchingAbout.setLineSpacing(0f, 1.25f);
        ui.stack(watchingWords, watchingAbout, television ? 24 : 8);
        FrameLayout.LayoutParams watchingWordsAt = new FrameLayout.LayoutParams(ui.px(television ? 920 : 420), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL | Gravity.START);
        watchingWordsAt.leftMargin = ui.px(television ? 96 : 24);
        watchingFrame.addView(watchingWords, watchingWordsAt);
        watching = watchingFrame;
        watching.setVisibility(View.GONE);
        root.addView(watching, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // --- PX-TV-3, PX-P-2: Episodes ------------------------------------------------
        // Over the picture, which goes on playing behind it.
        FrameLayout episodesFrame = new FrameLayout(activity);
        episodesFrame.setClipChildren(false);
        seasonChips = ui.row(false);
        episodesShow = ui.text(television ? 30 : 17, FilmUi.WHITE, Typeface.BOLD);
        FilmUi.oneLine(episodesShow);
        if (television) {
            episodesFrame.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                new int[] { FilmUi.fade(0.97f), FilmUi.fade(0.9f), FilmUi.fade(0.35f) }));
            FrameLayout.LayoutParams showAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START);
            showAt.leftMargin = ui.px(96);
            showAt.topMargin = ui.px(72);
            episodesFrame.addView(episodesShow, showAt);
            LinearLayout block = ui.column(0);
            ui.stack(block, seasonChips, 0);
            episodeList = ui.row(false);
            episodeList.setGravity(Gravity.TOP);
            episodeList.setPadding(ui.px(96), ui.px(10), ui.px(96), ui.px(10));
            android.widget.HorizontalScrollView sideways = new android.widget.HorizontalScrollView(activity);
            sideways.setHorizontalScrollBarEnabled(false);
            sideways.setFocusable(false);
            sideways.setClipChildren(false);
            sideways.setClipToPadding(false);
            sideways.addView(episodeList, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            episodeScroll = sideways;
            LinearLayout.LayoutParams acrossAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            acrossAt.topMargin = ui.px(24);
            acrossAt.leftMargin = -ui.px(96);
            acrossAt.rightMargin = -ui.px(96);
            block.addView(sideways, acrossAt);
            FrameLayout.LayoutParams blockAt = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
            blockAt.leftMargin = ui.px(96);
            blockAt.rightMargin = ui.px(96);
            blockAt.bottomMargin = ui.px(62);
            episodesFrame.addView(block, blockAt);
        } else {
            episodesFrame.setBackgroundColor(FilmUi.fade(0.55f));
            episodesFrame.setClickable(true);
            episodesFrame.setOnClickListener(v -> closeEpisodes());
            LinearLayout sheet = ui.column(0);
            sheet.setClickable(true);
            sheet.setBackgroundColor(0xF71A2233);
            sheet.setPadding(ui.px(18), ui.px(14), ui.px(18), ui.px(10));
            LinearLayout head = ui.row(false);
            episodesShow.setText(Texts.t("film.episodes"));
            head.addView(episodesShow, ui.stretch(0));
            head.addView(seasonChips);
            ui.stack(sheet, head, 0);
            episodeList = ui.column(0);
            ScrollView down = new ScrollView(activity);
            down.setVerticalScrollBarEnabled(false);
            down.addView(episodeList, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            episodeScroll = down;
            LinearLayout.LayoutParams downAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
            downAt.topMargin = ui.px(12);
            sheet.addView(down, downAt);
            // The longer side: the phone is turned sideways for this (above), and is
            // often still upright while it is built.
            android.util.DisplayMetrics metrics = activity.getResources().getDisplayMetrics();
            int wide = Math.max(metrics.widthPixels, metrics.heightPixels);
            episodesFrame.addView(sheet, new FrameLayout.LayoutParams(Math.min(ui.px(430), Math.round(wide * 0.6f)), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END));
        }
        episodesLayer = episodesFrame;
        episodesLayer.setVisibility(View.GONE);
        root.addView(episodesLayer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        if (!television) {
            ripple = new Ripple(activity, ui);
            ripple.setVisibility(View.GONE);
            root.addView(ripple, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            dragLabel = ui.mono(14, FilmUi.FG, true);
            GradientDrawable labelGround = new GradientDrawable();
            labelGround.setColor(FilmUi.PANEL_SOLID);
            labelGround.setCornerRadius(ui.px(6));
            dragLabel.setBackground(labelGround);
            dragLabel.setPadding(ui.px(10), ui.px(4), ui.px(10), ui.px(4));
            dragLabel.setVisibility(View.GONE);
            root.addView(dragLabel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            listenForTouches();
        }

        activity.addContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        openingRing.start();
        showTitle();
        refreshPlayButton();
        refreshNextButton();
        refreshTimes();
    }

    // --- The player tells the controls --------------------------------------------

    /** The first frame: the opening panel goes, and a part-watched film says where it resumed. */
    void onFirstFrame() {
        clock.removeCallbacks(startedWithoutPicture);
        if (started) {
            return;
        }
        started = true;
        nextUrl = null;
        awaitingNext = false;
        openingRing.stop();
        opening.setVisibility(View.GONE);
        // Again now that something plays: VLC takes a delay only then.
        applyKeptDelay();
        refreshTracks();
        // An episode chosen from Episodes starts where it was left (PX-TV-3).
        if (seekOnStartMs > 0) {
            player.seekTo(seekOnStartMs);
            seekOnStartMs = 0L;
        }
        if (startAtMs > 0) {
            // PX-TV-10: no "Resumed at" panel. The controls, for their usual
            // seconds, with the bar where it picked up and focus on Start
            // over -- OK at once starts over, anything else carries on.
            showControls(true);
            int index = startOverButton == null ? -1 : visibleButtons().indexOf(startOverButton);
            if (index >= 0) {
                setFocus(index);
            }
        }
        clock.removeCallbacks(endWatch);
        if (upNext != null) {
            clock.postDelayed(endWatch, 1000L);
        }
        clock.removeCallbacks(skipWatch);
        clock.postDelayed(skipWatch, 500L);
        updateBackHandling();
    }

    /** Playing, or not: a stream that plays without drawing a frame still counts as started. */
    void onPlaying(boolean playing) {
        clock.removeCallbacks(startedWithoutPicture);
        if (playing && !started) {
            clock.postDelayed(startedWithoutPicture, 1500L);
        }
    }

    /** Paused or resumed, by anyone: the viewer, or the system taking the audio away. */
    void onPaused(boolean nowPaused) {
        if (paused == nowPaused) {
            return;
        }
        paused = nowPaused;
        refreshPlayButton();
        pausedLabel.setVisibility(paused ? View.VISIBLE : View.GONE);
        if (!started) {
            return;
        }
        if (paused) {
            // Shows on pause, then hides as it does while playing (PX-TV-8):
            // it used to stay until a key was pressed. Not over the
            // next-episode card, whose countdown pausing has just stopped.
            if (!isShowing(railLayer) && !isShowing(card) && !isShowing(episodesLayer)) {
                showControls(false);
            }
            watchLongPause();
        } else {
            clock.removeCallbacks(showWatchingLater);
            show(watching, false);
            scheduleHide();
        }
    }

    // --- A long pause (PX-TV-8, PX-P-4) --------------------------------------------------

    /** Starts the wait again: any press or tap while paused is somebody still there. */
    private void watchLongPause() {
        clock.removeCallbacks(showWatchingLater);
        if (paused && started) {
            clock.postDelayed(showWatchingLater, PAUSED_SCREEN_AFTER_MS);
        }
    }

    /** What is paused, over the dimmed picture; only when nothing else is open. */
    private void showWatching() {
        if (!paused || !started || isShowing(card) || isShowing(railLayer) || isShowing(episodesLayer) || seek.isActive()) {
            return;
        }
        String small = heading;
        String episodeLine = "";
        if (episode) {
            episodeLine = name;
        }
        watchingTitle.setText(episode && !small.isEmpty() ? small : name);
        watchingEpisode.setText(episodeLine);
        watchingEpisode.setVisibility(episodeLine.isEmpty() || small.isEmpty() ? View.GONE : View.VISIBLE);
        List<String> parts = new ArrayList<>();
        if (!episode && !knownMeta.isEmpty()) {
            parts.add(knownMeta);
        }
        String runtime = FilmSeek.runtime(player.durationMs());
        if (!runtime.isEmpty()) {
            parts.add(runtime);
        }
        parts.add(Texts.t("film.pausedAt", FilmSeek.clock(player.positionMs())));
        watchingMeta.setText(join(parts));
        watchingAbout.setText(description);
        watchingAbout.setVisibility(description.isEmpty() ? View.GONE : View.VISIBLE);
        clock.removeCallbacks(hideControlsLater);
        show(controls, false);
        show(watching, true);
    }

    /** Back from it: the controls, focus on Play, and the wait starts again. */
    private void leaveWatching() {
        show(watching, false);
        showControls(true);
        watchLongPause();
    }

    /** Waiting for data. Drawn only after a second of it, so brief hiccups draw nothing. */
    void onBuffering(boolean waiting) {
        bufferingNow = waiting;
        clock.removeCallbacks(showBufferingLater);
        if (waiting && started) {
            clock.postDelayed(showBufferingLater, BUFFERING_AFTER_MS);
        } else {
            bufferingRing.stop();
            buffering.setVisibility(View.GONE);
        }
    }

    /** The tracks changed: the line under the title, and the rail if it is open. */
    void onTracksChanged() {
        refreshTracks();
        if (isShowing(railLayer)) {
            if (television) {
                fillChoices(false);
            } else {
                fillRail(false);
            }
        }
    }

    void destroy() {
        if (open.get() == this) {
            open = new java.lang.ref.WeakReference<>(null);
        }
        clock.removeCallbacksAndMessages(null);
        openingRing.stop();
        bufferingRing.stop();
        if (backCallback != null && BACK_BY_CALLBACK) {
            activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback((android.window.OnBackInvokedCallback) backCallback);
            backCallback = null;
        }
    }

    // --- Keys ---------------------------------------------------------------------

    /** Returns true or false when the controls handled the key, null when the player should. */
    @Nullable
    Boolean onKey(KeyEvent event) {
        int code = event.getKeyCode();
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        boolean press = down && event.getRepeatCount() == 0;
        boolean back = code == KeyEvent.KEYCODE_BACK;

        if (back && wantsBack()) {
            if (press && !BACK_BY_CALLBACK) {
                onBack();
            }
            return true;
        }
        if (back) {
            return null;
        }

        if (isPlayPause(code)) {
            if (press) {
                if (seek.isActive()) {
                    commitSeek();
                }
                if (code == KeyEvent.KEYCODE_MEDIA_PLAY) {
                    player.setPlaying(true);
                } else if (code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                    player.setPlaying(false);
                } else {
                    togglePlaying();
                }
            }
            return true;
        }

        // Opening: nothing to act on yet, and Back (above) leaves.
        if (!started) {
            return true;
        }

        if (paused && down) {
            watchLongPause();
        }
        if (isShowing(watching)) {
            if (press) {
                leaveWatching();
            }
            return true;
        }

        // PL-TV-6b takes the remote while it is up: Left and Right between its
        // two buttons, OK to act. Play/Pause (above) still pauses the credits.
        if (isShowing(card)) {
            if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
                if (down) {
                    setCardFocus(code == KeyEvent.KEYCODE_DPAD_LEFT ? 0 : 1);
                }
            } else if (isOk(code) && press) {
                cardChoose(cardFocus);
            }
            return true;
        }

        // PX-TV-3: Left and Right along the row (or between the seasons), Up
        // to the seasons, Down back to the episodes, OK to play one.
        if (isShowing(episodesLayer)) {
            if (down) {
                if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
                    moveInEpisodes(code == KeyEvent.KEYCODE_DPAD_LEFT ? -1 : 1);
                } else if (code == KeyEvent.KEYCODE_DPAD_UP && seasons.size() > 1) {
                    onSeasonChips = true;
                    drawEpisodes();
                } else if (code == KeyEvent.KEYCODE_DPAD_DOWN) {
                    onSeasonChips = false;
                    drawEpisodes();
                }
            }
            if (isOk(code) && press) {
                if (onSeasonChips) {
                    onSeasonChips = false;
                    drawEpisodes();
                } else {
                    chooseEpisode(episodeFocus);
                }
            }
            return true;
        }

        if (isShowing(railLayer)) {
            if (television) {
                onChoiceKey(code, event, down, press);
                return true;
            }
            if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) {
                if (down) {
                    moveRail(code == KeyEvent.KEYCODE_DPAD_UP ? -1 : 1);
                }
            } else if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
                // Earlier and later on the timing row, again and again while
                // held; inert on the tracks.
                if (down && onTimingRow()) {
                    nudgeSubtitles(code == KeyEvent.KEYCODE_DPAD_LEFT ? -1 : 1, event);
                }
            } else if (isOk(code) && press) {
                chooseInRail();
            }
            return true;
        }

        boolean seekKey = code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD || code == KeyEvent.KEYCODE_MEDIA_REWIND;
        boolean sideways = code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT;
        int direction = code == KeyEvent.KEYCODE_DPAD_RIGHT || code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD ? 1 : -1;

        if (isShowing(controls) && isShowing(speedChoice)) {
            // PX-TV-4: Left and Right along the speeds, OK to choose one.
            if (sideways && down) {
                speedFocus = Math.max(0, Math.min(SPEEDS.length - 1, speedFocus + direction));
                drawSpeeds();
            } else if (isOk(code) && press) {
                chooseSpeed(SPEEDS[speedFocus]);
            }
            scheduleHide();
            return true;
        }

        if (isShowing(controls)) {
            if (sideways) {
                if (down) {
                    moveFocus(direction);
                }
            } else if (seekKey) {
                if (down) {
                    step(direction, event, true);
                }
            } else if (isOk(code)) {
                if (press) {
                    if (seek.isActive()) {
                        commitSeek();
                    }
                    List<FilmUi.Button> shown = visibleButtons();
                    if (focused < shown.size()) {
                        shown.get(focused).performClick();
                    }
                }
            } else if (code == KeyEvent.KEYCODE_MENU) {
                if (press) {
                    openRail();
                }
            }
            // Up and Down from the buttons: there is nowhere to go.
            scheduleHide();
            return true;
        }

        if (seek.isActive()) {
            if (sideways || seekKey) {
                if (down) {
                    step(direction, event, false);
                }
                return true;
            }
            if (isOk(code)) {
                if (press) {
                    commitSeek();
                }
                return true;
            }
            if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN || code == KeyEvent.KEYCODE_MENU) {
                if (press) {
                    commitSeek();
                    showControls(true);
                }
                return true;
            }
            return true;
        }

        // Nothing drawn that takes keys.
        if (sideways || seekKey) {
            if (down) {
                step(direction, event, false);
            }
            return true;
        }
        if (isOk(code) && isShowing(skipButton)) {
            if (press) {
                skipNow();
            }
            return true;
        }
        if (isOk(code) || code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN || code == KeyEvent.KEYCODE_INFO) {
            if (press) {
                showControls(true);
            }
            return true;
        }
        if (code == KeyEvent.KEYCODE_MENU) {
            if (press) {
                openRail();
            }
            return true;
        }
        return null;
    }

    private static boolean isOk(int code) {
        return code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
    }

    private static boolean isPlayPause(int code) {
        return code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PLAY
            || code == KeyEvent.KEYCODE_MEDIA_PAUSE || code == KeyEvent.KEYCODE_SPACE;
    }

    // --- Back ---------------------------------------------------------------------

    /** Whether Back is for something drawn over the video rather than for leaving. */
    private boolean wantsBack() {
        return isShowing(card) || isShowing(watching) || isShowing(episodesLayer) || isShowing(railLayer) || seek.isActive() || isShowing(strip) || isShowing(controls);
    }

    private void onBack() {
        if (isShowing(watching)) {
            leaveWatching();
        } else if (isShowing(card)) {
            // Back is Cancel: the credits play out, with no second offer.
            dismissCard();
        } else if (isShowing(episodesLayer)) {
            closeEpisodes();
        } else if (isShowing(railLayer)) {
            closeRail();
        } else if (isShowing(controls) && isShowing(speedChoice)) {
            closeSpeed();
        } else if (seek.isActive()) {
            cancelSeek();
        } else if (isShowing(strip)) {
            // Landed a moment ago: Back puts the strip away rather than leaving
            // the film the viewer has just moved through.
            clock.removeCallbacks(hideStripLater);
            show(strip, false);
        } else if (isShowing(controls)) {
            hideControls();
        }
    }

    /** Takes Back while it is wanted, and gives it back when it is not. See ChannelSession. */
    private void updateBackHandling() {
        if (!BACK_BY_CALLBACK) {
            return;
        }
        boolean wanted = wantsBack();
        android.window.OnBackInvokedDispatcher dispatcher = activity.getOnBackInvokedDispatcher();
        if (wanted && backCallback == null) {
            android.window.OnBackInvokedCallback callback = this::onBack;
            dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_OVERLAY, callback);
            backCallback = callback;
        } else if (!wanted && backCallback != null) {
            dispatcher.unregisterOnBackInvokedCallback((android.window.OnBackInvokedCallback) backCallback);
            backCallback = null;
        }
    }

    // --- The controls panel ---------------------------------------------------------

    private void showControls(boolean resetFocus) {
        clock.removeCallbacks(hideStripLater);
        strip.setVisibility(View.GONE);
        if (resetFocus || !isShowing(controls)) {
            // Focus always starts on Play/Pause, so OK, OK is a reliable pause and resume.
            setFocus(0);
            speedChoice.setVisibility(View.GONE);
            buttonRow.setVisibility(View.VISIBLE);
        }
        refreshTracks();
        refreshTimes();
        refreshSleepButton();
        refreshSpeedButton();
        show(controls, true);
        scheduleHide();
    }

    /** A phone's back and forward 10 s, in the middle of the picture (PX-P-1). */
    private void jump(long byMs) {
        long duration = player.durationMs();
        long target = Math.max(0L, player.positionMs() + byMs);
        player.seekTo(duration > 0 ? Math.min(duration, target) : target);
        refreshTimes();
        scheduleHide();
    }

    // --- Speed (PX-TV-4) ----------------------------------------------------------------

    private void openSpeed() {
        float now = player.speed();
        speedFocus = 2;
        for (int i = 0; i < SPEEDS.length; i++) {
            if (Math.abs(SPEEDS[i] - now) < 0.01f) {
                speedFocus = i;
            }
        }
        buttonRow.setVisibility(View.GONE);
        speedChoice.setVisibility(View.VISIBLE);
        drawSpeeds();
        scheduleHide();
        updateBackHandling();
    }

    private void closeSpeed() {
        speedChoice.setVisibility(View.GONE);
        buttonRow.setVisibility(View.VISIBLE);
        int index = visibleButtons().indexOf(speedButton);
        if (index >= 0) {
            setFocus(index);
        }
        scheduleHide();
    }

    private void chooseSpeed(float speed) {
        player.setSpeed(speed);
        refreshSpeedButton();
        closeSpeed();
    }

    /** The one in use reads as chosen without focus: an outline; focus is the white pill. */
    private void drawSpeeds() {
        float now = player.speed();
        for (int i = 0; i < speedPills.size(); i++) {
            FilmUi.Pill pill = speedPills.get(i);
            pill.edged = Math.abs(SPEEDS[i] - now) < 0.01f;
            pill.setFocusedLook(television && i == speedFocus);
        }
    }

    /** "Speed", or "Speed 1.25×" while it is not normal. */
    private void refreshSpeedButton() {
        float now = player.speed();
        speedButton.setText(Math.abs(now - 1f) < 0.01f ? Texts.t("film.speed") : Texts.t("film.speedNow", speedWords(now)));
    }

    private static String speedWords(float speed) {
        String number = speed == Math.round(speed) ? String.valueOf(Math.round(speed)) : String.valueOf(speed);
        return number + "×";
    }

    /** The sleep timer's list (SleepTimerPanel), from the controls; back to its button after. */
    private void openSleepTimer() {
        SleepTimerPanel panel = SleepTimerPanel.of(activity);
        if (panel == null) {
            return;
        }
        if (seek.isActive()) {
            commitSeek();
        }
        clock.removeCallbacks(hideControlsLater);
        show(controls, false);
        panel.openList(0L, episode, () -> {
            showControls(false);
            int index = visibleButtons().indexOf(sleepButton);
            if (index >= 0) {
                setFocus(index);
            }
        });
    }

    private void refreshSleepButton() {
        if (sleepButton == null) {
            return;
        }
        String left = SleepTimer.summary(System.currentTimeMillis());
        sleepButton.setText(left == null ? Texts.t("sleep.title") : Texts.t("sleep.title") + " · " + left);
    }

    private void hideControls() {
        clock.removeCallbacks(hideControlsLater);
        if (seek.isActive() && seekShownInPanel) {
            commitSeek();
        }
        show(controls, false);
    }

    /** After five seconds untouched, paused or playing (PX-TV-8): paused, they used to stay. */
    private void scheduleHide() {
        clock.removeCallbacks(hideControlsLater);
        if (isShowing(controls)) {
            // A phone's controls cover more of a smaller picture: 4 s (PX-P-1).
            clock.postDelayed(hideControlsLater, television ? HIDE_AFTER_MS : 4000L);
        }
    }

    private void moveFocus(int direction) {
        setFocus(Math.max(0, Math.min(visibleButtons().size() - 1, focused + direction)));
    }

    /** Focus by position among the buttons shown; Next episode is absent after a season's last. */
    private void setFocus(int index) {
        focused = index;
        List<FilmUi.Button> shown = visibleButtons();
        for (FilmUi.Button button : buttons) {
            button.setFocusedLook(television && shown.indexOf(button) == index);
        }
    }

    /** `paused` is what was asked for, not what is happening: a film waiting for data is not paused. */
    private void togglePlaying() {
        player.setPlaying(paused);
    }

    private void refreshPlayButton() {
        int icon = paused ? FilmUi.Icon.PLAY : FilmUi.Icon.PAUSE;
        playButton.setIconKind(icon);
        playButton.setText(Texts.t(paused ? "film.play" : "film.pause"));
        if (centrePlay != null) {
            centrePlay.icon.kind = icon;
            centrePlay.invalidate();
        }
    }

    private void startOver() {
        player.seekTo(0L);
        if (paused) {
            player.setPlaying(true);
        }
        refreshTimes();
        scheduleHide();
    }

    // --- Skip intro -------------------------------------------------------------------

    /** The skips the web app handed over for what is playing, and the ones in use (the file's chapters win). */
    private SkipTimes handedSkips = SkipTimes.none();
    private SkipTimes skips = SkipTimes.none();
    /** The stretch skipped: not offered again. */
    @Nullable
    private SkipTimes.Skip skipDone;
    private FilmUi.Pill skipButton;
    private String skipMode = "button";

    /** The file's own chapters, once Media3 has read them. Named ones replace what the database said. */
    void onChapters(List<SkipTimes.Chapter> chapters) {
        if (chapters.isEmpty() || "off".equals(skipMode)) {
            return;
        }
        SkipTimes named = SkipTimes.fromChapters(chapters, player.durationMs());
        skips = named.isEmpty() ? handedSkips : named;
    }

    private void refreshSkip() {
        SkipTimes.Skip now = started && !seek.isActive() ? skips.at(player.positionMs()) : null;
        boolean offer = now != null && now != skipDone && !isShowing(card) && !isShowing(watching)
            && !isShowing(railLayer) && !isShowing(episodesLayer);
        if (offer && "auto".equals(skipMode)) {
            skipNow();
            return;
        }
        if (offer && !isShowing(skipButton)) {
            skipButton.setText(Texts.t(SkipTimes.RECAP.equals(now.kind) ? "film.skipRecap" : "film.skipIntro"));
        }
        show(skipButton, offer);
    }

    private void skipNow() {
        SkipTimes.Skip now = skips.at(player.positionMs());
        if (now == null) {
            show(skipButton, false);
            return;
        }
        skipDone = now;
        show(skipButton, false);
        player.seekTo(now.endMs);
    }

    // --- The next episode (PL-TV-6b) -------------------------------------------------

    /** The last 30 s of an episode with something after it: the card, once. */
    private void maybeShowCard() {
        if (upNext == null || cardDone || awaitingNext || !started || isShowing(card) || seek.isActive()) {
            return;
        }
        // The sleep timer is set for the end of this one: nothing follows it.
        if (SleepTimer.endsWithItem()) {
            return;
        }
        long duration = player.durationMs();
        long credits = skips.creditsStartMs();
        // When the credits start, if that is known; otherwise the last 30 s.
        boolean inCredits = credits > 0 && player.positionMs() >= credits && (duration <= 0 || credits < duration);
        if (!inCredits && (duration <= 0 || duration - player.positionMs() > CARD_BEFORE_END_MS)) {
            return;
        }
        showCard();
    }

    private void showCard() {
        UpNext next = upNext;
        if (next == null) {
            return;
        }
        // It is one of the three overlays that take the remote; the others go.
        clock.removeCallbacks(hideControlsLater);
        show(controls, false);
        show(railLayer, false);
        show(episodesLayer, false);
        show(strip, false);

        if (next.last) {
            // The season's end: nothing starts by itself, and the way on is the show's page.
            cardPoster.setVisibility(View.GONE);
            cardKicker.setText(next.heading.toUpperCase(Locale.getDefault()));
            cardTitle.setText(Texts.t("film.lastEpisode"));
            cardPrimary.filling = -1f;
            cardPrimary.setIconKind(FilmUi.Icon.BACK);
            cardPrimary.setText(Texts.t("film.backToShow"));
        } else {
            cardPoster.setVisibility(View.VISIBLE);
            cardKicker.setText(nextKicker(next));
            cardTitle.setText(nextName(next));
            ui.load(cardPoster, next.poster, television ? 220 : 96);
            cardPrimary.setIconKind(FilmUi.Icon.PLAY);
            cardPrimary.setText(Texts.t("film.nextEpisode"));
            countdownLeft = COUNTDOWN_MS;
            drawCountdown();
            clock.removeCallbacks(countdown);
            clock.postDelayed(countdown, 100L);
        }
        cardPrimary.recolour();
        setCardFocus(0);
        show(card, true);
    }

    /** "NEXT · S1 E4", from the card's heading ("Severance · S1") and the episode's label ("E4"). */
    private static String nextKicker(UpNext next) {
        int cut = next.heading.lastIndexOf(" · ");
        String season = cut >= 0 ? next.heading.substring(cut + 3) : "";
        String which = (season + " " + next.label).trim();
        return which.isEmpty() ? Texts.t("film.nextShort") : Texts.t("film.nextShort") + " · " + which;
    }

    /** "The You You Are", the card's title without the label the kicker already gives. */
    private static String nextName(UpNext next) {
        String prefix = next.label + " · ";
        return !next.label.isEmpty() && next.title.startsWith(prefix) ? next.title.substring(prefix.length()) : next.title;
    }

    /** No number of seconds: the button fills, and full, it plays. */
    private void drawCountdown() {
        cardPrimary.filling = 1f - Math.max(0f, countdownLeft / (float) COUNTDOWN_MS);
        cardPrimary.recolour();
    }

    private void setCardFocus(int index) {
        cardFocus = index;
        cardPrimary.setFocusedLook(television && index == 0);
        cardSecondary.setFocusedLook(television && index == 1);
    }

    /** Play now or Back to the show (0); Cancel or Watch the credits (1). */
    private void cardChoose(int index) {
        UpNext next = upNext;
        if (next == null) {
            return;
        }
        if (index == 0) {
            if (next.last) {
                closePlayer();
            } else {
                requestNext();
            }
        } else {
            dismissCard();
        }
    }

    /** Lets the credits play out, with no second offer. */
    private void dismissCard() {
        cardDone = true;
        clock.removeCallbacks(countdown);
        show(card, false);
    }

    /**
     * Goes on to the next episode, from the list the web app handed over in
     * advance. The stream stops now and the next opens after the pause, so the
     * provider's one connection is free by then. The web app is told
     * afterwards, to record where this one got to; nothing waits for it.
     */
    private void requestNext() {
        UpNext next = upNext;
        if (next == null || next.last || awaitingNext || episodes.ahead.isEmpty()) {
            return;
        }
        Ahead coming = episodes.ahead.get(0);
        awaitingNext = true;
        cardDone = true;
        clock.removeCallbacks(countdown);
        clock.removeCallbacks(endWatch);
        clock.removeCallbacks(hideControlsLater);
        if (seek.isActive()) {
            seek.cancel();
        }
        show(card, false);
        show(controls, false);
        show(railLayer, false);
        show(strip, false);

        com.getcapacitor.JSObject data = new com.getcapacitor.JSObject();
        data.put("itemId", itemId);
        data.put("positionSeconds", player.positionMs() / 1000L);
        data.put("durationSeconds", player.durationMs() / 1000L);
        data.put("to", coming.itemId);
        player.stop();
        stoppedAt = android.os.SystemClock.uptimeMillis();
        NativePlayerPlugin.emit("episodeChanged", data);

        openNext(coming, episodes.rest(), 0L);
    }

    /** The next episode, in this player behind the opening (PX-TV-9). */
    private void openNext(Ahead coming, EpisodesAhead rest, long startAt) {
        itemId = coming.itemId;
        heading = coming.showName;
        name = coming.title;
        knownMeta = "";
        description = coming.description;
        startAtMs = startAt;
        seekOnStartMs = startAt;
        episodes = rest;
        upNext = rest.card();
        cardDone = false;
        started = false;
        handedSkips = "off".equals(skipMode) ? SkipTimes.none() : coming.skips;
        skips = handedSkips;
        skipDone = null;
        show(skipButton, false);
        applyKeptDelay();
        PlaybackReports.item(itemId.isEmpty() ? null : itemId);
        // A speed is for the one it was chosen for (PX-TV-4).
        player.setSpeed(1f);

        showTitle();
        stripTitle.setText(heading.isEmpty() ? name : heading + " \u00B7 " + name);
        refreshNextButton();
        showOpening(heading, name, coming.poster, "");

        String url = coming.url;
        nextUrl = url;
        nextAttempt = 1;
        long wait = Math.max(0L, stoppedAt + SWITCH_PAUSE_MS - android.os.SystemClock.uptimeMillis());
        clock.postDelayed(() -> player.open(url), wait);
    }

    /**
     * More of the season, from the web app, once it has caught up with an
     * episode the player went on to. Arriving late costs nothing: it is only
     * needed by the end of this episode.
     */
    void setEpisodesAhead(String forItem, @Nullable org.json.JSONObject data) {
        if (!forItem.equals(itemId)) {
            return;
        }
        episodes = EpisodesAhead.from(data);
        upNext = episodes.card();
        refreshNextButton();
        if (upNext != null && started && !cardDone) {
            clock.removeCallbacks(endWatch);
            clock.postDelayed(endWatch, 1000L);
        }
    }

    /**
     * A failure before the next episode's first frame. Returns true when it is
     * being tried once more -- the provider refusing a stream opened straight
     * after another usually lets the second attempt through -- and false when
     * the player should end with it as it always has.
     */
    boolean onOpenFailed(String errorCode) {
        String url = nextUrl;
        if (url == null || started || nextAttempt != 1 || !refusal(errorCode)) {
            return false;
        }
        nextAttempt = 2;
        setOpeningLine(Texts.t("film.turnedAway"));
        player.stop();
        stoppedAt = android.os.SystemClock.uptimeMillis();
        clock.postDelayed(() -> player.open(url), RETRY_AFTER_MS);
        return true;
    }

    private static boolean refusal(String errorCode) {
        return errorCode != null && (errorCode.contains("BAD_HTTP_STATUS") || errorCode.contains("NETWORK")
            || errorCode.startsWith("VLC could not play"));
    }

    /** Leaves the player: Back to the show. */
    private void closePlayer() {
        player.close();
    }

    /**
     * The end of the stream. Returns true when that is not the end of the
     * player: an episode with the next one queued and not cancelled goes on
     * to it rather than closing.
     */
    boolean onEnded() {
        if (awaitingNext) {
            return true;
        }
        if (upNext != null && !upNext.last && !cardDone) {
            requestNext();
            return true;
        }
        return false;
    }

    private void showOpening(String show, String title, @Nullable String poster, String where) {
        fillOpening(show, title, where, defaultOpeningLine());
        opening.setVisibility(View.VISIBLE);
        openingRing.start();
        bufferingRing.stop();
        buffering.setVisibility(View.GONE);
    }

    /**
     * The opening's words: an episode's show and number small above its own
     * name, as the controls set them; where it resumes; and a reason only when
     * there is one beyond the usual opening.
     */
    private void fillOpening(String show, String title, String where, String line) {
        String[] parts = titleParts(show, title);
        openingShow.setText(parts[0]);
        openingShow.setVisibility(parts[0].isEmpty() ? View.GONE : View.VISIBLE);
        openingTitle.setText(parts[1]);
        openingWhere.setText(where);
        openingWhere.setVisibility(where.isEmpty() ? View.GONE : View.VISIBLE);
        setOpeningLine(line);
    }

    private void setOpeningLine(String line) {
        boolean said = !line.isEmpty() && !line.equals(defaultOpeningLine());
        openingLine.setText(said ? line : "");
        openingLine.setVisibility(said ? View.VISIBLE : View.GONE);
    }

    private void refreshNextButton() {
        if (nextButton == null) {
            return;
        }
        boolean offered = upNext != null && !upNext.last;
        nextButton.setVisibility(offered ? View.VISIBLE : View.GONE);
        // A button that went away must not keep focus.
        List<FilmUi.Button> shown = visibleButtons();
        if (focused >= shown.size()) {
            setFocus(0);
        }
    }

    private List<FilmUi.Button> visibleButtons() {
        List<FilmUi.Button> shown = new ArrayList<>();
        for (FilmUi.Button button : buttons) {
            if (button.getVisibility() == View.VISIBLE) {
                shown.add(button);
            }
        }
        return shown;
    }

    private void hideStrip() {
        show(strip, false);
    }

    // --- Seeking --------------------------------------------------------------------

    /** One press of Left, Right, Fast-forward or Rewind: moves the target, and the picture later. */
    private void step(int direction, KeyEvent event, boolean inPanel) {
        long now = event.getEventTime();
        if (event.getRepeatCount() > 0 && now - lastStepAt < REPEAT_PACE_MS) {
            return;
        }
        lastStepAt = now;
        long held = event.getRepeatCount() > 0 ? now - event.getDownTime() : 0L;
        seek.press(direction, held, player.positionMs(), player.durationMs());
        seekShownInPanel = inPanel;
        clock.removeCallbacks(commitSeekLater);
        clock.postDelayed(commitSeekLater, FilmSeek.COMMIT_AFTER_MS);
        if (inPanel) {
            scheduleHide();
        } else {
                clock.removeCallbacks(hideStripLater);
            show(strip, true);
        }
        refreshTimes();
        updateBackHandling();
    }

    private void commitSeek() {
        clock.removeCallbacks(commitSeekLater);
        if (!seek.isActive()) {
            return;
        }
        long target = seek.commit();
        player.seekTo(target);
        refreshTimes();
        if (isShowing(strip)) {
            clock.postDelayed(hideStripLater, FilmSeek.HIDE_AFTER_MS);
        }
        if (ripple != null) {
            ripple.setVisibility(View.GONE);
        }
        tapSide = 0;
        updateBackHandling();
    }

    /** Back: the target snaps back, and the picture never moved. */
    private void cancelSeek() {
        clock.removeCallbacks(commitSeekLater);
        seek.cancel();
        show(strip, false);
        if (ripple != null) {
            ripple.setVisibility(View.GONE);
        }
        tapSide = 0;
        refreshTimes();
        updateBackHandling();
    }

    // --- Times ------------------------------------------------------------------------

    private void refreshTimes() {
        long duration = player.durationMs();
        long position = seek.isActive() ? seek.target() : player.positionMs();
        float fraction = duration > 0 ? position / (float) duration : 0f;
        float from = seek.isActive() && duration > 0 ? seek.from() / (float) duration : -1f;

        if (isShowing(controls)) {
            bar.played = fraction;
            bar.from = seekShownInPanel || !television ? from : -1f;
            bar.invalidate();
            elapsed.setText(FilmSeek.clock(position));
            remaining.setText(duration > 0 ? FilmSeek.remaining(duration - position) : "");
            if (ends != null) {
                String when = duration > 0 ? clockAt(System.currentTimeMillis() + (duration - position) * 1000L / Math.max(1L, Math.round(player.speed() * 1000f))) : "";
                ends.setText(when.isEmpty() ? "" : withMono(Texts.t("film.ends"), when, FilmUi.WHITE));
            }
            metaLine.setText(meta());
        }
        if (isShowing(strip)) {
            stripTarget.setText(FilmSeek.clock(position));
            boolean moving = seek.isActive();
            stripOffset.setText(moving ? FilmSeek.offset(seek.target() - seek.from()) : "");
            stripStep.setText(moving ? FilmSeek.stepLabel(seek.step()) : "");
            stripHint.setVisibility(moving ? View.VISIBLE : View.INVISIBLE);
            stripBar.played = fraction;
            stripBar.from = from;
            stripBar.invalidate();
            stripFrom.setText(moving ? withMono(Texts.t("film.from"), FilmSeek.clock(seek.from()), FilmUi.MUTED) : "");
        }
    }

    /** "2024 · 2 h 46 min · Audio English 5.1 · Subtitles Hrvatski", under the title (PX-TV-1). */
    private String meta() {
        List<String> parts = new ArrayList<>();
        if (!knownMeta.isEmpty()) {
            parts.add(knownMeta);
        }
        String runtime = FilmSeek.runtime(player.durationMs());
        if (!runtime.isEmpty()) {
            parts.add(runtime);
        }
        String tracks = tracksText(true);
        if (!tracks.isEmpty()) {
            parts.add(tracks);
        }
        return join(parts);
    }

    private void refreshTracks() {
        metaLine.setText(meta());
    }

    /**
     * The title, top left: an episode's show and number small above it, its
     * own name large (PX-TV-2), where the app names it "S1 E3 · In Perpetuity".
     */
    private void showTitle() {
        String[] parts = titleParts(heading, name);
        headingView.setText(parts[0]);
        headingView.setVisibility(episode && !parts[0].isEmpty() ? View.VISIBLE : View.GONE);
        titleView.setText(parts[1]);
    }

    /** { small, large }: "Severance · S1 E3" and "In Perpetuity" from the show and "S1 E3 · In Perpetuity". */
    private String[] titleParts(String show, String title) {
        int cut = title.indexOf(" · ");
        if (episode && cut > 0 && title.substring(0, cut).matches("(S\\d+ )?E\\d+")) {
            String number = title.substring(0, cut);
            return new String[] { show.isEmpty() ? number : show + " · " + number, title.substring(cut + 3) };
        }
        return new String[] { episode ? show : "", title };
    }

    /** "Audio English 5.1 · Subtitles Hrvatski". */
    private String tracksText(boolean sayAudio) {
        List<String> parts = new ArrayList<>();
        for (FilmPlayback.Track track : player.audioTracks()) {
            if (track.inUse) {
                parts.add(sayAudio ? Texts.t("film.audio", track.label) : track.label);
                break;
            }
        }
        List<FilmPlayback.Track> subtitles = player.subtitleTracks();
        if (subtitles.size() > 1) {
            String chosen = Texts.t("track.off");
            for (FilmPlayback.Track track : subtitles) {
                if (track.inUse && !track.isOff()) {
                    chosen = track.label;
                }
            }
            parts.add(Texts.t("film.subtitles", chosen));
        }
        return join(parts);
    }

    private void showBuffering() {
        if (!bufferingNow || !started) {
            return;
        }
        buffering.setVisibility(View.VISIBLE);
        bufferingRing.start();
    }

    // --- The rail ---------------------------------------------------------------------

    private void openRail() {
        clock.removeCallbacks(hideControlsLater);
        if (seek.isActive()) {
            commitSeek();
        }
        // Only ever one panel: the controls go behind it.
        show(controls, false);
        if (television) {
            fillChoices(true);
        } else {
            fillRail(true);
        }
        show(railLayer, true);
    }

    private void closeRail() {
        show(railLayer, false);
        // Back to the button that opened it.
        showControls(false);
        int index = visibleButtons().indexOf(tracksButton);
        setFocus(Math.max(0, index));
    }

    // --- Audio & subtitles on a television (PX-TV-5) ----------------------------------

    private static final int AUDIO_COLUMN = 0;
    private static final int SUBTITLE_COLUMN = 1;
    private static final int LINES = 2;

    /**
     * Audio left, subtitles right, the picture's shape and subtitle timing on
     * lines below. `placeFocus` puts focus on the subtitles in use -- what is
     * most often changed -- or the audio in use when there are none.
     */
    private void fillChoices(boolean placeFocus) {
        LinearLayout audioColumn = audioChoices;
        LinearLayout subtitleColumn = subtitleChoices;
        LinearLayout lines = lineChoices;
        if (audioColumn == null || subtitleColumn == null || lines == null) {
            return;
        }
        audioColumn.removeAllViews();
        subtitleColumn.removeAllViews();
        lines.removeAllViews();
        choiceRows.clear();
        choiceTracks.clear();
        choiceGroups.clear();

        // One audio track, or none, is nothing to choose between: no column.
        List<FilmPlayback.Track> audio = player.audioTracks().size() < 2 ? new java.util.ArrayList<>() : player.audioTracks();
        List<FilmPlayback.Track> subtitles = player.subtitleTracks();
        audioColumn.setVisibility(audio.isEmpty() ? View.GONE : View.VISIBLE);
        ((LinearLayout.LayoutParams) subtitleColumn.getLayoutParams()).leftMargin = audio.isEmpty() ? 0 : ui.px(140);
        if (!audio.isEmpty()) {
            choiceTitle(audioColumn, Texts.t("film.audioTitle"));
            for (FilmPlayback.Track track : audio) {
                addChoice(audioColumn, AUDIO_COLUMN, track);
            }
        }
        choiceTitle(subtitleColumn, Texts.t("film.subtitlesTitle"));
        if (subtitles.isEmpty()) {
            TextView none = ui.text(26, FilmUi.QUIET, Typeface.NORMAL);
            none.setText(Texts.t(episode ? "film.noSubtitlesEpisode" : "film.noSubtitlesFilm"));
            none.setPadding(ui.px(22), 0, 0, 0);
            subtitleColumn.addView(none);
        }
        for (FilmPlayback.Track track : subtitles) {
            addChoice(subtitleColumn, SUBTITLE_COLUMN, track);
        }

        // The shape of the picture, for a file that carries the wrong one (PictureMode).
        String shape = player.pictureMode();
        addChoice(lines, LINES, new FilmPlayback.Track(FilmPlayback.Track.PICTURE, PictureMode.label(shape), false, shape));
        if (subtitlesShowing(subtitles)) {
            addChoice(lines, LINES, new FilmPlayback.Track(FilmPlayback.Track.TIMING, "", false, null));
        }

        if (placeFocus) {
            choiceFocus = firstInUse(subtitles.isEmpty() ? AUDIO_COLUMN : SUBTITLE_COLUMN);
            if (choiceFocus < 0) {
                choiceFocus = firstInUse(AUDIO_COLUMN);
            }
        }
        choiceFocus = Math.max(0, Math.min(choiceRows.size() - 1, choiceFocus));
        drawChoices();
    }

    private void choiceTitle(LinearLayout column, String words) {
        TextView title = ui.text(34, FilmUi.WHITE, Typeface.BOLD);
        title.setText(words);
        title.setPadding(ui.px(22), 0, 0, 0);
        LinearLayout.LayoutParams at = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        at.bottomMargin = ui.px(18);
        column.addView(title, at);
    }

    private void addChoice(LinearLayout column, int group, FilmPlayback.Track track) {
        FilmUi.ChoiceRow row = new FilmUi.ChoiceRow(ui);
        choiceRows.add(row);
        choiceTracks.add(track);
        choiceGroups.add(group);
        if (group == LINES) {
            row.centre();
        }
        LinearLayout.LayoutParams at = new LinearLayout.LayoutParams(group == LINES ? ui.px(640) : ViewGroup.LayoutParams.MATCH_PARENT, ui.px(70));
        at.bottomMargin = ui.px(6);
        column.addView(row, at);
    }

    /** The first choice in use in a column, or the column's first; -1 when the column is empty. */
    private int firstInUse(int group) {
        int first = -1;
        for (int i = 0; i < choiceTracks.size(); i++) {
            if (choiceGroups.get(i) != group) {
                continue;
            }
            if (first < 0) {
                first = i;
            }
            if (choiceTracks.get(i).inUse) {
                return i;
            }
        }
        return first;
    }

    private void drawChoices() {
        for (int i = 0; i < choiceRows.size(); i++) {
            FilmPlayback.Track track = choiceTracks.get(i);
            boolean focusedHere = i == choiceFocus;
            CharSequence label;
            if (track.kind == FilmPlayback.Track.PICTURE) {
                label = lineLabel(Texts.t("film.pictureLine"), PictureMode.label(player.pictureMode()), focusedHere);
            } else if (track.kind == FilmPlayback.Track.TIMING) {
                label = lineLabel(Texts.t("film.timingLine"), SubtitleDelay.amount(player.subtitleDelayMs()) + " s", focusedHere);
            } else {
                label = track.label;
            }
            choiceRows.get(i).set(label, track.inUse, focusedHere);
        }
        if (choiceFocus < choiceRows.size() && choiceGroups.get(choiceFocus) != LINES) {
            View row = choiceRows.get(choiceFocus);
            railScroll.post(() -> {
                int top = row.getTop() - ui.px(60);
                int bottom = row.getBottom() + ui.px(60);
                int scrolled = railScroll.getScrollY();
                int height = railScroll.getHeight();
                if (top < scrolled) {
                    railScroll.smoothScrollTo(0, Math.max(0, top));
                } else if (bottom > scrolled + height) {
                    railScroll.smoothScrollTo(0, bottom - height);
                }
            });
        }
    }

    /** "Picture   Fit", the value bold, between ‹ › while it has focus: what Left and Right change. */
    private static CharSequence lineLabel(String what, String value, boolean focusedHere) {
        String shown = focusedHere ? "‹ " + value + " ›" : value;
        SpannableString text = new SpannableString(what + "   " + shown);
        text.setSpan(new android.text.style.StyleSpan(Typeface.BOLD), what.length() + 3, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return text;
    }

    private void onChoiceKey(int code, KeyEvent event, boolean down, boolean press) {
        if (choiceRows.isEmpty()) {
            return;
        }
        int group = choiceGroups.get(choiceFocus);
        boolean sideways = code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT;
        int direction = code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_UP ? -1 : 1;
        if (sideways && down) {
            if (group == LINES) {
                changeLine(choiceTracks.get(choiceFocus), direction, event);
            } else {
                // To the other column, at the same height as far as it goes.
                int other = group == AUDIO_COLUMN ? SUBTITLE_COLUMN : AUDIO_COLUMN;
                int place = indexInGroup(choiceFocus);
                int target = nthInGroup(other, place);
                if (target >= 0) {
                    choiceFocus = target;
                    drawChoices();
                }
            }
        } else if ((code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) && down) {
            int next = choiceFocus + direction;
            if (group != LINES && direction > 0 && (next >= choiceRows.size() || choiceGroups.get(next) != group)) {
                // Down from a column's last: the lines below.
                next = nthInGroup(LINES, 0);
            } else if (group == LINES && direction < 0 && (next < 0 || choiceGroups.get(next) != LINES)) {
                // Up from the lines: the subtitles' last, or the audio's.
                int last = lastInGroup(SUBTITLE_COLUMN);
                next = last >= 0 ? last : lastInGroup(AUDIO_COLUMN);
            } else if (next >= 0 && next < choiceRows.size() && choiceGroups.get(next) != group) {
                next = -1;
            }
            if (next >= 0 && next < choiceRows.size()) {
                choiceFocus = next;
                drawChoices();
            }
        } else if (isOk(code) && press && group != LINES) {
            chooseChoice(choiceTracks.get(choiceFocus));
        }
    }

    private int indexInGroup(int index) {
        int place = 0;
        for (int i = 0; i < index; i++) {
            if (choiceGroups.get(i).equals(choiceGroups.get(index))) {
                place++;
            }
        }
        return place;
    }

    /** The nth choice in a group, or its last when it has fewer; -1 when it has none. */
    private int nthInGroup(int group, int place) {
        int found = -1;
        int seen = 0;
        for (int i = 0; i < choiceGroups.size(); i++) {
            if (choiceGroups.get(i) == group) {
                found = i;
                if (seen++ == place) {
                    return i;
                }
            }
        }
        return found;
    }

    private int lastInGroup(int group) {
        return nthInGroup(group, Integer.MAX_VALUE);
    }

    /** Left and Right on a line: the next shape, or subtitles earlier or later. */
    private void changeLine(FilmPlayback.Track line, int direction, KeyEvent event) {
        if (line.kind == FilmPlayback.Track.TIMING) {
            nudgeSubtitles(direction, event);
            return;
        }
        if (event.getRepeatCount() > 0) {
            return;
        }
        List<String> all = java.util.Arrays.asList(PictureMode.ALL);
        int at = Math.max(0, all.indexOf(player.pictureMode()));
        int next = (at + direction + all.size()) % all.size();
        player.setPictureMode(all.get(next));
        drawChoices();
    }

    /** OK applies and keeps the columns open, so audio and subtitles are both set in one visit. */
    private void chooseChoice(FilmPlayback.Track chosen) {
        // Another subtitle track starts on time: a delay belongs to the track it was set for.
        if (chosen.kind == FilmPlayback.Track.SUBTITLES && !chosen.inUse) {
            setSubtitleDelay(0L);
        }
        player.choose(chosen);
        // Media3 answers through onTracksChanged; VLC changes at once and says nothing.
        clock.postDelayed(() -> {
            if (isShowing(railLayer)) {
                fillChoices(false);
            }
            refreshTracks();
        }, 250L);
    }

    // --- Episodes (PX-TV-3, PX-P-2) ------------------------------------------------------

    /** The season the playing episode is in, or the first. */
    private int seasonOfPlaying() {
        for (int s = 0; s < seasons.size(); s++) {
            for (Listed one : seasons.get(s).episodes) {
                if (one.ahead.itemId.equals(itemId)) {
                    return s;
                }
            }
        }
        return 0;
    }

    private int playingIndex(Season season) {
        for (int i = 0; i < season.episodes.size(); i++) {
            if (season.episodes.get(i).ahead.itemId.equals(itemId)) {
                return i;
            }
        }
        return -1;
    }

    /** Opens on the season playing, focus on the episode after the one playing -- the one most often wanted. */
    private void openEpisodes() {
        if (seasons.isEmpty()) {
            return;
        }
        clock.removeCallbacks(hideControlsLater);
        if (seek.isActive()) {
            commitSeek();
        }
        show(controls, false);
        seasonShown = seasonOfPlaying();
        onSeasonChips = false;
        fillEpisodes();
        int playing = playingIndex(seasons.get(seasonShown));
        episodeFocus = Math.min(seasons.get(seasonShown).episodes.size() - 1, Math.max(0, playing + 1));
        if (television) {
            episodesShow.setText(heading);
        }
        drawEpisodes();
        show(episodesLayer, true);
    }

    private void closeEpisodes() {
        show(episodesLayer, false);
        showControls(false);
        int index = episodesButton == null ? -1 : visibleButtons().indexOf(episodesButton);
        setFocus(Math.max(0, index));
    }

    private void fillEpisodes() {
        seasonChips.removeAllViews();
        seasonPills.clear();
        if (seasons.size() > 1) {
            for (int s = 0; s < seasons.size(); s++) {
                int which = s;
                FilmUi.Pill chip = ui.pill(-1, seasons.get(s).label, television ? 60 : 30, television ? 26 : 11, television ? 26 : 13, 0);
                chip.edged = true;
                chip.setOnClickListener(v -> showSeason(which));
                seasonPills.add(chip);
                seasonChips.addView(chip, ui.beside(seasonChips.getChildCount() == 0 ? 0 : (television ? 14 : 6)));
            }
        }
        episodeList.removeAllViews();
        episodeCards.clear();
        Season season = seasons.get(seasonShown);
        for (int i = 0; i < season.episodes.size(); i++) {
            int index = i;
            Listed one = season.episodes.get(i);
            FilmUi.EpisodeCard card = new FilmUi.EpisodeCard(ui, television);
            ui.load(card.still, one.ahead.poster, television ? 400 : 120);
            card.setOnClickListener(v -> chooseEpisode(index));
            episodeCards.add(card);
            if (television) {
                episodeList.addView(card, ui.beside(i == 0 ? 0 : 36));
            } else {
                ui.stack(episodeList, card, 12);
            }
        }
    }

    private void showSeason(int which) {
        if (which < 0 || which >= seasons.size()) {
            return;
        }
        seasonShown = which;
        fillEpisodes();
        int playing = playingIndex(seasons.get(seasonShown));
        episodeFocus = Math.max(0, playing);
        drawEpisodes();
        episodeScroll.scrollTo(0, 0);
    }

    private void moveInEpisodes(int direction) {
        if (onSeasonChips) {
            // The seasons are tabs: moving along them shows each.
            showSeason(Math.max(0, Math.min(seasons.size() - 1, seasonShown + direction)));
            onSeasonChips = true;
            drawEpisodes();
            return;
        }
        int count = seasons.get(seasonShown).episodes.size();
        episodeFocus = Math.max(0, Math.min(count - 1, episodeFocus + direction));
        drawEpisodes();
    }

    private void drawEpisodes() {
        for (int s = 0; s < seasonPills.size(); s++) {
            FilmUi.Pill chip = seasonPills.get(s);
            // The season shown is the white one; on the chips it is also where focus is.
            chip.setFocusedLook(s == seasonShown);
        }
        Season season = seasons.get(seasonShown);
        long duration = player.durationMs();
        for (int i = 0; i < episodeCards.size(); i++) {
            Listed one = season.episodes.get(i);
            boolean playing = one.ahead.itemId.equals(itemId);
            // The one playing shows how far it has got now, not when Episodes was handed over.
            float watched = playing && duration > 0 ? player.positionMs() / (float) duration : one.watched;
            episodeCards.get(i).set(one.number, one.name, one.length, watched, playing);
            episodeCards.get(i).setFocusedLook(television && !onSeasonChips && i == episodeFocus);
        }
        if (television && episodeFocus < episodeCards.size()) {
            View card = episodeCards.get(episodeFocus);
            episodeScroll.post(() -> {
                int left = card.getLeft() - ui.px(96);
                ((android.widget.HorizontalScrollView) episodeScroll).smoothScrollTo(Math.max(0, left), 0);
            });
        }
    }

    /**
     * An episode from the list: the one playing goes on playing; any other
     * opens in this player, where it was left, the way the next one does --
     * the web app is told afterwards, and nothing waits on it.
     */
    private void chooseEpisode(int index) {
        Season season = seasons.get(seasonShown);
        if (index < 0 || index >= season.episodes.size() || awaitingNext) {
            return;
        }
        Listed chosen = season.episodes.get(index);
        if (chosen.ahead.itemId.equals(itemId)) {
            closeEpisodes();
            return;
        }
        List<Ahead> after = new ArrayList<>();
        for (int i = index + 1; i < season.episodes.size(); i++) {
            after.add(season.episodes.get(i).ahead);
        }
        EpisodesAhead rest = new EpisodesAhead(after, season.end.isEmpty() ? null : season.end);

        awaitingNext = true;
        clock.removeCallbacks(countdown);
        clock.removeCallbacks(endWatch);
        clock.removeCallbacks(hideControlsLater);
        if (seek.isActive()) {
            seek.cancel();
        }
        show(episodesLayer, false);
        show(card, false);
        show(controls, false);

        com.getcapacitor.JSObject data = new com.getcapacitor.JSObject();
        data.put("itemId", itemId);
        data.put("positionSeconds", player.positionMs() / 1000L);
        data.put("durationSeconds", player.durationMs() / 1000L);
        data.put("to", chosen.ahead.itemId);
        player.stop();
        stoppedAt = android.os.SystemClock.uptimeMillis();
        NativePlayerPlugin.emit("episodeChanged", data);

        openNext(chosen.ahead, rest, chosen.startAtMs);
    }

    /** Lists the tracks; `placeFocus` puts focus on the audio in use, as when it first opens. */
    private void fillRail(boolean placeFocus) {
        railList.removeAllViews();
        railRows.clear();
        railTracks.clear();

        List<FilmPlayback.Track> audio = player.audioTracks();
        List<FilmPlayback.Track> subtitles = player.subtitleTracks();
        LinearLayout audioColumn = television ? railList : ui.column(6);
        LinearLayout subtitleColumn = television ? railList : ui.column(6);
        if (!television) {
            // Side by side on a phone, because landscape height is the scarce
            // dimension; subtitles alone take the whole width.
            if (!audio.isEmpty()) {
                railList.addView(audioColumn, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            }
            LinearLayout.LayoutParams right = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            right.leftMargin = audio.isEmpty() ? 0 : ui.px(16);
            railList.addView(subtitleColumn, right);
        }

        // A stream that declares no audio track at all has nothing to choose
        // between, so the group is left out rather than drawn empty.
        if (!audio.isEmpty()) {
            addGroup(audioColumn, Texts.t("film.audioGroup"), audio, "");
        }
        addGroup(subtitleColumn, Texts.t("film.subtitlesGroup"), subtitles.isEmpty() ? null : subtitles, Texts.t(episode ? "film.noSubtitlesEpisode" : "film.noSubtitlesFilm"));
        if (subtitlesShowing(subtitles)) {
            addTimingRow(subtitleColumn);
        }

        // The shape of the picture, for a file that carries the wrong one (PictureMode).
        List<FilmPlayback.Track> shapes = new ArrayList<>();
        String shape = player.pictureMode();
        for (String mode : PictureMode.ALL) {
            shapes.add(new FilmPlayback.Track(FilmPlayback.Track.PICTURE, PictureMode.label(mode), mode.equals(shape), mode));
        }
        addGroup(subtitleColumn, Texts.t("film.pictureGroup"), shapes, "");

        if (placeFocus) {
            railFocus = 0;
            for (int i = 0; i < railTracks.size(); i++) {
                if (railTracks.get(i).inUse) {
                    railFocus = i;
                    break;
                }
            }
        }
        railFocus = Math.max(0, Math.min(railTracks.size() - 1, railFocus));
        drawRail();
    }

    private void addGroup(LinearLayout column, String title, @Nullable List<FilmPlayback.Track> tracks, String none) {
        TextView label = television ? ui.label(24, FilmUi.MUTED, 0.06f) : ui.label(12, FilmUi.MUTED, 0.1f);
        label.setText(title);
        LinearLayout.LayoutParams labelAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        labelAt.topMargin = column.getChildCount() == 0 ? 0 : ui.px(television ? 26 : 6);
        labelAt.bottomMargin = ui.px(television ? 14 : 6);
        column.addView(label, labelAt);
        if (tracks == null) {
            TextView empty = ui.text(television ? 24 : 13, FilmUi.DIM, Typeface.NORMAL);
            empty.setText(none);
            column.addView(empty);
            return;
        }
        for (FilmPlayback.Track track : tracks) {
            FilmUi.RailRow row = new FilmUi.RailRow(ui, television);
            int index = railTracks.size();
            railRows.add(row);
            railTracks.add(track);
            row.setOnClickListener(v -> {
                railFocus = index;
                chooseInRail();
            });
            LinearLayout.LayoutParams rowAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ui.px(television ? 84 : 44));
            rowAt.bottomMargin = ui.px(television ? 14 : 6);
            column.addView(row, rowAt);
        }
    }

    private void drawRail() {
        for (int i = 0; i < railRows.size(); i++) {
            FilmPlayback.Track track = railTracks.get(i);
            String label = track.kind == FilmPlayback.Track.TIMING ? SubtitleDelay.label(player.subtitleDelayMs()) : track.label;
            railRows.get(i).set(label, track.inUse, television && i == railFocus);
        }
        if (television && railFocus < railRows.size()) {
            View row = railRows.get(railFocus);
            railScroll.post(() -> {
                int top = row.getTop() - ui.px(60);
                int bottom = row.getBottom() + ui.px(60);
                int scrolled = railScroll.getScrollY();
                int height = railScroll.getHeight();
                if (top < scrolled) {
                    railScroll.smoothScrollTo(0, Math.max(0, top));
                } else if (bottom > scrolled + height) {
                    railScroll.smoothScrollTo(0, bottom - height);
                }
            });
        }
    }

    private void moveRail(int direction) {
        if (railTracks.isEmpty()) {
            return;
        }
        railFocus = Math.max(0, Math.min(railTracks.size() - 1, railFocus + direction));
        drawRail();
    }

    /** OK applies and keeps the rail open, so audio and subtitles are both set in one visit. */
    private void chooseInRail() {
        if (railFocus >= railTracks.size()) {
            return;
        }
        FilmPlayback.Track chosen = railTracks.get(railFocus);
        if (chosen.kind == FilmPlayback.Track.TIMING) {
            return;
        }
        if (chosen.kind == FilmPlayback.Track.PICTURE) {
            player.setPictureMode((String) chosen.handle);
            fillRail(false);
            return;
        }
        // Another subtitle track starts on time: a delay belongs to the track
        // it was set for.
        if (chosen.kind == FilmPlayback.Track.SUBTITLES && !chosen.inUse) {
            setSubtitleDelay(0L);
        }
        player.choose(chosen);
        // Media3 answers through onTracksChanged; VLC changes at once and says nothing.
        clock.postDelayed(() -> {
            if (isShowing(railLayer)) {
                fillRail(false);
            }
            refreshTracks();
        }, 250L);
    }

    // --- Subtitle timing -------------------------------

    /** When the last step was taken, so a held key steps at the seek strip's pace. */
    private long lastNudgeAt = 0L;

    private static boolean subtitlesShowing(List<FilmPlayback.Track> subtitles) {
        for (FilmPlayback.Track track : subtitles) {
            if (track.inUse && !track.isOff()) {
                return true;
            }
        }
        return false;
    }

    private boolean onTimingRow() {
        return railFocus < railTracks.size() && railTracks.get(railFocus).kind == FilmPlayback.Track.TIMING;
    }

    /**
     * "Timing +0.5 s" between "‹ Earlier" and "Later ›": the words a finger
     * taps, and on a television what Left and Right do -- the row says it,
     * nothing explains it.
     */
    private void addTimingRow(LinearLayout column) {
        FilmUi.RailRow row = new FilmUi.RailRow(ui, television);
        int index = railTracks.size();
        railRows.add(row);
        railTracks.add(new FilmPlayback.Track(FilmPlayback.Track.TIMING, "", false, null));
        row.setOnClickListener(v -> {
            railFocus = index;
            drawRail();
        });
        TextView earlier = timingStep("‹ " + Texts.t("film.earlier"), -1, index);
        TextView later = timingStep(Texts.t("film.later") + " ›", 1, index);
        // Earlier on the left, the way Left moves it.
        row.addView(earlier, 0, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT));
        row.name.setGravity(Gravity.CENTER);
        row.addView(later, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT));
        LinearLayout.LayoutParams rowAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ui.px(television ? 84 : 44));
        rowAt.bottomMargin = ui.px(television ? 14 : 6);
        column.addView(row, rowAt);
    }

    private TextView timingStep(String words, int direction, int index) {
        TextView step = ui.text(television ? 24 : 13, FilmUi.PRIMARY_BRIGHT, Typeface.BOLD);
        step.setText(words);
        step.setGravity(Gravity.CENTER_VERTICAL);
        int pad = ui.px(television ? 8 : 10);
        step.setPadding(pad, 0, pad, 0);
        step.setOnClickListener(v -> {
            railFocus = index;
            nudgeSubtitles(direction, null);
        });
        return step;
    }

    /** One step earlier or later; a held key at most every REPEAT_PACE_MS. */
    private void nudgeSubtitles(int direction, @Nullable KeyEvent event) {
        if (event != null) {
            long now = event.getEventTime();
            if (event.getRepeatCount() > 0 && now - lastNudgeAt < REPEAT_PACE_MS) {
                return;
            }
            lastNudgeAt = now;
        }
        setSubtitleDelay(player.subtitleDelayMs() + direction * SubtitleDelay.STEP_MS);
        if (television) {
            drawChoices();
        } else {
            drawRail();
        }
    }

    private void setSubtitleDelay(long ms) {
        long kept = SubtitleDelay.clamp(ms);
        player.setSubtitleDelay(kept);
        SubtitleDelay.store(activity, itemId, kept);
    }

    /** The delay kept for what is playing now, or none. */
    private void applyKeptDelay() {
        player.setSubtitleDelay(SubtitleDelay.load(activity, itemId));
    }

    // --- Touch (PL-P-2) -----------------------------------------------------------------

    private void listenForTouches() {
        GestureDetector gestures = new GestureDetector(activity, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(@NonNull MotionEvent event) {
                return true;
            }

            @Override
            public boolean onSingleTapConfirmed(@NonNull MotionEvent event) {
                if (!started || tapSide != 0 || isShowing(card)) {
                    return true;
                }
                if (isShowing(watching)) {
                    leaveWatching();
                    return true;
                }
                watchLongPause();
                if (isShowing(controls)) {
                    hideControls();
                } else {
                    showControls(false);
                }
                return true;
            }

            @Override
            public boolean onDoubleTap(@NonNull MotionEvent event) {
                int side = sideOf(event);
                if (!started || side == 0) {
                    return false;
                }
                tapSeek(side);
                return true;
            }

            @Override
            public boolean onSingleTapUp(@NonNull MotionEvent event) {
                // Further taps while a double-tap seek is adding up add to it.
                if (tapSide != 0 && sideOf(event) == tapSide) {
                    tapSeek(tapSide);
                }
                return false;
            }
        });
        root.setOnTouchListener((view, event) -> {
            gestures.onTouchEvent(event);
            if (event.getAction() == MotionEvent.ACTION_UP) {
                view.performClick();
            }
            return true;
        });

        bar.setOnTouchListener((view, event) -> {
            long duration = player.durationMs();
            if (duration <= 0 || dragLabel == null) {
                return false;
            }
            float inset = bar.thumb * ui.unit / 2;
            float fraction = (event.getX() - inset) / Math.max(1f, view.getWidth() - inset * 2);
            long target = Math.round(Math.max(0f, Math.min(1f, fraction)) * duration);
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    clock.removeCallbacks(hideControlsLater);
                    clock.removeCallbacks(commitSeekLater);
                    seek.dragTo(target, player.positionMs());
                    bar.thumb = 24;
                    dragLabel.setVisibility(View.VISIBLE);
                    // fall through to place it
                case MotionEvent.ACTION_MOVE:
                    seek.dragTo(target, seek.from());
                    placeDragLabel(view, Math.max(0f, Math.min(1f, fraction)));
                    refreshTimes();
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    bar.thumb = 14;
                    dragLabel.setVisibility(View.GONE);
                    // The jump happens on release.
                    commitSeek();
                    scheduleHide();
                    return true;
                default:
                    return true;
            }
        });
    }

    private int sideOf(MotionEvent event) {
        float width = root.getWidth();
        if (event.getX() < width / 3f) {
            return -1;
        }
        if (event.getX() > width * 2f / 3f) {
            return 1;
        }
        return 0;
    }

    /** A double-tap on the left or right third: 10 s, adding up while the taps keep coming. */
    private void tapSeek(int side) {
        if (tapSide != side && seek.isActive()) {
            commitSeek();
        }
        tapSide = side;
        // The ripple is the whole display of a tap seek; the panel would sit under it.
        clock.removeCallbacks(hideControlsLater);
        show(controls, false);
        seek.press(side, 0L, player.positionMs(), player.durationMs());
        clock.removeCallbacks(commitSeekLater);
        clock.postDelayed(commitSeekLater, FilmSeek.COMMIT_AFTER_MS);
        if (ripple != null) {
            ripple.show(side, FilmSeek.tapOffset(seek.target() - seek.from()));
        }
        refreshTimes();
        updateBackHandling();
    }

    private void placeDragLabel(View barView, float fraction) {
        if (dragLabel == null) {
            return;
        }
        int[] barAt = new int[2];
        int[] rootAt = new int[2];
        barView.getLocationInWindow(barAt);
        root.getLocationInWindow(rootAt);
        float inset = bar.thumb * ui.unit / 2;
        float x = barAt[0] - rootAt[0] + inset + (barView.getWidth() - inset * 2) * fraction;
        dragLabel.setText(FilmSeek.clock(seek.target()));
        dragLabel.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
        dragLabel.setTranslationX(x - dragLabel.getMeasuredWidth() / 2f);
        dragLabel.setTranslationY(barAt[1] - rootAt[1] - dragLabel.getMeasuredHeight() - ui.px(18));
    }

    /**
     * PL-P-2: a dark half-disc on the tapped side, holding the running total on
     * a panel -- never bare on video.
     */
    private static final class Ripple extends FrameLayout {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final FilmUi ui;
        private final TextView arrows;
        private final TextView total;
        private final LinearLayout panel;
        private int side = 1;

        Ripple(Context context, FilmUi ui) {
            super(context);
            this.ui = ui;
            setWillNotDraw(false);
            paint.setColor(FilmUi.scrim(0.55f));
            panel = new LinearLayout(context);
            panel.setOrientation(LinearLayout.VERTICAL);
            panel.setGravity(Gravity.CENTER_HORIZONTAL);
            panel.setBackgroundColor(FilmUi.PANEL);
            FilmUi.rounded(panel, ui.px(6));
            panel.setPadding(ui.px(18), ui.px(12), ui.px(18), ui.px(12));
            arrows = ui.text(14, FilmUi.MUTED, Typeface.NORMAL);
            total = ui.text(22, FilmUi.FG, Typeface.BOLD);
            panel.addView(arrows);
            LinearLayout.LayoutParams totalAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            totalAt.topMargin = ui.px(2);
            panel.addView(total, totalAt);
            addView(panel, new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL | Gravity.END));
        }

        void show(int side, String text) {
            this.side = side;
            arrows.setText(side > 0 ? "►►" : "◄◄");
            total.setText(text);
            LayoutParams at = (LayoutParams) panel.getLayoutParams();
            at.gravity = Gravity.CENTER_VERTICAL | (side > 0 ? Gravity.END : Gravity.START);
            at.leftMargin = side > 0 ? 0 : ui.px(48);
            at.rightMargin = side > 0 ? ui.px(48) : 0;
            panel.setLayoutParams(at);
            setVisibility(View.VISIBLE);
            invalidate();
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            float radius = ui.px(210);
            float cx = side > 0 ? getWidth() + ui.px(120) - radius : radius - ui.px(120);
            canvas.drawCircle(cx, getHeight() / 2f, radius, paint);
        }
    }

    // --- Small things -----------------------------------------------------------------

    private void show(View view, boolean visible) {
        view.setVisibility(visible ? View.VISIBLE : View.GONE);
        // The controls, the card and Episodes bring fades of their own; the seek
        // strip has this one.
        boolean anything = !isShowing(controls) && !isShowing(card) && isShowing(strip);
        scrim.setVisibility(anything ? View.VISIBLE : View.GONE);
        if (anything) {
            float height = isShowing(strip) ? 400 : 320;
            ViewGroup.LayoutParams at = scrim.getLayoutParams();
            int wanted = television ? ui.px(height) : small.px(height);
            if (at.height != wanted) {
                at.height = wanted;
                scrim.setLayoutParams(at);
            }
        }
        clock.removeCallbacks(tick);
        if (isShowing(controls) || isShowing(strip)) {
            clock.postDelayed(tick, 500L);
        }
        player.liftSubtitles(isShowing(controls) || isShowing(strip) || isShowing(card) ? SUBTITLES_OVER_CONTROLS : 0f);
        updateBackHandling();
    }

    private static boolean isShowing(View view) {
        return view.getVisibility() == View.VISIBLE;
    }

    /** Along the foot of the picture, as wide as the controls' bar (round 12). */
    private FrameLayout.LayoutParams bottomWide() {
        FrameLayout.LayoutParams at = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        at.leftMargin = ui.px(television ? 96 : 20);
        at.rightMargin = ui.px(television ? 96 : 20);
        at.bottomMargin = ui.px(television ? 72 : 16);
        return at;
    }

    private View sized(View view, int width, float heightDesignPx) {
        view.setLayoutParams(new LinearLayout.LayoutParams(width, ui.px(heightDesignPx)));
        view.setMinimumHeight(ui.px(heightDesignPx));
        FrameLayout holder = new FrameLayout(activity);
        holder.addView(view, new FrameLayout.LayoutParams(width, ui.px(heightDesignPx)));
        return holder;
    }

    /** Words, then a time in the monospace face. */
    private static CharSequence withMono(String words, String time) {
        SpannableString text = new SpannableString(words + time);
        text.setSpan(new android.text.style.TypefaceSpan("monospace"), words.length(), text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return text;
    }

    private static CharSequence withMono(String words, String time, int timeColour) {
        SpannableString text = (SpannableString) withMono(words, time);
        text.setSpan(new android.text.style.ForegroundColorSpan(timeColour), words.length(), text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return text;
    }

    private static String clockAt(long ms) {
        return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(ms));
    }

    private static String join(List<String> parts) {
        StringBuilder out = new StringBuilder();
        for (String part : parts) {
            if (part == null || part.isEmpty()) {
                continue;
            }
            if (out.length() > 0) {
                out.append(" · ");
            }
            out.append(part);
        }
        return out.toString();
    }

    private static String orEmpty(@Nullable String value) {
        return value == null ? "" : value;
    }
}
