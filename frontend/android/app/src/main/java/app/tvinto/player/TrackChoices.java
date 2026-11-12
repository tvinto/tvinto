package app.tvinto.player;

import android.app.Activity;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
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
 * Audio & subtitles for a live channel: on a television audio on the left,
 * subtitles on the right, as the film's panel draws them (PX-TV-5); on a phone
 * the film's sheet from below, tapped. Opened from the channel banner's pill.
 *
 * It replaced Media3's own controls, where the subtitles were a button inside
 * a bar inside "Player controls" -- three presses, in a look shared with
 * nothing else in the app (31 October). What is chosen here the
 * player reports when it closes, and the app opens the channel with it next
 * time, as it does for a film. A phone had Media3's stock list in an Android
 * alert until 1 November, and VLC nothing at all.
 */
final class TrackChoices {

    private static final int AUDIO = 0;
    private static final int SUBTITLES = 1;
    /** Long enough for the player to have taken a choice before the rows are drawn again. */
    private static final long REDRAW_MS = 350L;
    private static final int COLUMN_GAP_TV = 140;
    private static final int COLUMN_GAP_PHONE = 16;

    private final FilmUi ui;
    private final boolean television;
    private final FrameLayout root;
    private final LinearLayout audioColumn;
    private final LinearLayout subtitleColumn;
    private final Runnable changed;
    private final Handler clock = new Handler(Looper.getMainLooper());

    private final List<View> rows = new ArrayList<>();
    private final List<FilmPlayback.Track> tracks = new ArrayList<>();
    private final List<Integer> groups = new ArrayList<>();
    private int focus = 0;

    @Nullable
    private FilmPlayback playback = null;

    TrackChoices(Activity activity, boolean television, Runnable changed) {
        this.television = television;
        this.changed = changed;
        ui = new FilmUi(activity, ChannelOverlay.unitFor(activity));

        root = new FrameLayout(activity);
        root.setFocusable(false);
        audioColumn = ui.column(television ? 0 : 6);
        subtitleColumn = ui.column(television ? 0 : 6);
        if (television) {
            buildPanel();
        } else {
            buildSheet(activity);
        }
        root.setVisibility(View.GONE);

        activity.addContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void buildPanel() {
        // The picture stays, dimmed, as behind the film's panel.
        root.setBackgroundColor(FilmUi.fade(0.82f));

        LinearLayout panel = ui.column(0);
        TextView title = ui.text(44, FilmUi.WHITE, Typeface.BOLD);
        title.setText(Texts.t("film.audioSubtitles"));
        title.setPadding(ui.px(22), 0, 0, 0);
        ui.stack(panel, title, 0);

        LinearLayout columns = ui.row(false);
        columns.setGravity(Gravity.TOP);
        columns.addView(audioColumn, new LinearLayout.LayoutParams(ui.px(640), ViewGroup.LayoutParams.WRAP_CONTENT));
        LinearLayout.LayoutParams right = new LinearLayout.LayoutParams(ui.px(640), ViewGroup.LayoutParams.WRAP_CONTENT);
        right.leftMargin = ui.px(COLUMN_GAP_TV);
        columns.addView(subtitleColumn, right);
        ui.stack(panel, columns, 48);

        FrameLayout.LayoutParams at = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START);
        at.leftMargin = ui.px(96);
        at.topMargin = ui.px(120);
        root.addView(panel, at);
    }

    /** The film's phone sheet (FilmControls): the columns side by side, since landscape height is what is scarce. */
    private void buildSheet(Activity activity) {
        root.setBackgroundColor(0x8C03060D);
        root.setClickable(true);
        root.setOnClickListener(v -> close());

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

        LinearLayout columns = ui.row(false);
        columns.setGravity(Gravity.TOP);
        columns.addView(audioColumn, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams right = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        right.leftMargin = ui.px(COLUMN_GAP_PHONE);
        columns.addView(subtitleColumn, right);
        ScrollView scroll = new ScrollView(activity);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setFocusable(false);
        scroll.addView(columns, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        sheet.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        int tallest = Math.round(activity.getResources().getDisplayMetrics().heightPixels * 0.72f);
        scroll.addOnLayoutChangeListener((v, l, t, rr, b, ol, ot, orr, ob) -> {
            if (v.getHeight() > tallest) {
                v.getLayoutParams().height = tallest;
                v.requestLayout();
            }
        });

        FrameLayout.LayoutParams at = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        at.leftMargin = ui.px(112);
        at.rightMargin = ui.px(112);
        root.addView(sheet, at);
    }

    boolean isShowing() {
        return root.getVisibility() == View.VISIBLE;
    }

    /** Opens on the subtitles in use -- what is most often changed -- or the audio when there are none. */
    void open(FilmPlayback with) {
        playback = with;
        fill(true);
        root.setVisibility(View.VISIBLE);
        changed.run();
    }

    void close() {
        clock.removeCallbacksAndMessages(null);
        if (isShowing()) {
            root.setVisibility(View.GONE);
            changed.run();
        }
    }

    /** Up and Down in a column, Left and Right between them, OK chooses. Back is the session's. */
    void onKey(int code, boolean down, boolean press) {
        if (rows.isEmpty()) {
            return;
        }
        int group = groups.get(focus);
        if ((code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) && down) {
            int other = group == AUDIO ? SUBTITLES : AUDIO;
            int target = nthIn(other, indexIn(focus));
            if (target >= 0) {
                focus = target;
                draw();
            }
        } else if ((code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) && down) {
            int next = focus + (code == KeyEvent.KEYCODE_DPAD_UP ? -1 : 1);
            if (next >= 0 && next < rows.size() && groups.get(next) == group) {
                focus = next;
                draw();
            }
        } else if (isOk(code) && press) {
            choose(focus);
        }
    }

    private void choose(int index) {
        FilmPlayback with = playback;
        if (with == null || index >= tracks.size()) {
            return;
        }
        focus = index;
        with.choose(tracks.get(index));
        clock.removeCallbacksAndMessages(null);
        clock.postDelayed(() -> fill(false), REDRAW_MS);
    }

    private void fill(boolean placeFocus) {
        FilmPlayback with = playback;
        if (with == null) {
            return;
        }
        int keep = focus;
        audioColumn.removeAllViews();
        subtitleColumn.removeAllViews();
        rows.clear();
        tracks.clear();
        groups.clear();

        // One audio track is not a choice: no column for it.
        List<FilmPlayback.Track> audio = with.audioTracks().size() < 2 ? new ArrayList<>() : with.audioTracks();
        List<FilmPlayback.Track> subtitles = with.subtitleTracks();
        audioColumn.setVisibility(audio.isEmpty() ? View.GONE : View.VISIBLE);
        ((LinearLayout.LayoutParams) subtitleColumn.getLayoutParams()).leftMargin = audio.isEmpty() ? 0 : ui.px(television ? COLUMN_GAP_TV : COLUMN_GAP_PHONE);
        if (!audio.isEmpty()) {
            heading(audioColumn, Texts.t(television ? "film.audioTitle" : "film.audioGroup"));
            for (FilmPlayback.Track track : audio) {
                add(audioColumn, AUDIO, track);
            }
        }
        heading(subtitleColumn, Texts.t(television ? "film.subtitlesTitle" : "film.subtitlesGroup"));
        if (subtitles.isEmpty()) {
            TextView none = television ? ui.text(26, FilmUi.QUIET, Typeface.NORMAL) : ui.text(13, FilmUi.DIM, Typeface.NORMAL);
            none.setText(Texts.t("live.noSubtitles"));
            none.setPadding(television ? ui.px(22) : 0, 0, 0, 0);
            subtitleColumn.addView(none);
        }
        for (FilmPlayback.Track track : subtitles) {
            add(subtitleColumn, SUBTITLES, track);
        }

        if (placeFocus) {
            focus = firstInUse(subtitles.isEmpty() ? AUDIO : SUBTITLES);
            if (focus < 0) {
                focus = firstInUse(AUDIO);
            }
        } else {
            focus = keep;
        }
        focus = Math.max(0, Math.min(rows.size() - 1, focus));
        draw();
    }

    private void heading(LinearLayout column, String words) {
        if (!television) {
            TextView label = ui.label(12, FilmUi.MUTED, 0.1f);
            label.setText(words);
            LinearLayout.LayoutParams at = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            at.bottomMargin = ui.px(6);
            column.addView(label, at);
            return;
        }
        TextView title = ui.text(34, FilmUi.WHITE, Typeface.BOLD);
        title.setText(words);
        title.setPadding(ui.px(22), 0, 0, 0);
        LinearLayout.LayoutParams at = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        at.bottomMargin = ui.px(18);
        column.addView(title, at);
    }

    private void add(LinearLayout column, int group, FilmPlayback.Track track) {
        int index = rows.size();
        View row;
        if (television) {
            row = new FilmUi.ChoiceRow(ui);
        } else {
            row = new FilmUi.RailRow(ui, false);
            row.setOnClickListener(v -> choose(index));
        }
        rows.add(row);
        tracks.add(track);
        groups.add(group);
        LinearLayout.LayoutParams at = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ui.px(television ? 70 : 44));
        at.bottomMargin = ui.px(6);
        column.addView(row, at);
    }

    private void draw() {
        for (int i = 0; i < rows.size(); i++) {
            View row = rows.get(i);
            FilmPlayback.Track track = tracks.get(i);
            if (row instanceof FilmUi.ChoiceRow) {
                ((FilmUi.ChoiceRow) row).set(track.label, track.inUse, i == focus);
            } else {
                ((FilmUi.RailRow) row).set(track.label, track.inUse, false);
            }
        }
    }

    private int firstInUse(int group) {
        int first = -1;
        for (int i = 0; i < tracks.size(); i++) {
            if (groups.get(i) != group) {
                continue;
            }
            if (first < 0) {
                first = i;
            }
            if (tracks.get(i).inUse) {
                return i;
            }
        }
        return first;
    }

    private int indexIn(int index) {
        int place = 0;
        for (int i = 0; i < index; i++) {
            if (groups.get(i).equals(groups.get(index))) {
                place++;
            }
        }
        return place;
    }

    /** The nth row of a group, or its last when it is shorter; -1 when it has none. */
    private int nthIn(int group, int n) {
        int last = -1;
        int seen = 0;
        for (int i = 0; i < groups.size(); i++) {
            if (groups.get(i) != group) {
                continue;
            }
            if (seen == n) {
                return i;
            }
            last = i;
            seen++;
        }
        return last;
    }

    private static boolean isOk(int code) {
        return code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
    }
}
