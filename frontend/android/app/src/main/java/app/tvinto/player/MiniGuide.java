package app.tvinto.player;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
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

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The mini guide over the video: design board PL-TV-4.
 *
 * A 640px rail of neighbouring channels with what is on each, leaving about
 * two thirds of the picture clear. Up and Down move the highlight only --
 * nothing streams until OK, which matters when a single connection is all
 * there is. The channel playing keeps a green spine and says so in words; the
 * highlight is the ring, drawn inset so the top and bottom rows never clip it.
 * Closes on Back, on OK after a switch, or after eight seconds untouched.
 */
final class MiniGuide {

    interface Listener {
        void chosen(ChannelDirectory.Channel channel);

        /** Shown or hidden, so Back can be taken or given back. */
        void changed();
    }

    private static final long UNTOUCHED_MS = 8000L;
    private static final int ROW_HEIGHT = 104;
    private static final int ROW_GAP = 10;

    /** oklch(0.233 0.052 261.174 / 0.92) */
    private static final int ROW = 0xEB0F1D36;
    /** oklch(0.31 0.062 261 / 0.96) */
    private static final int ROW_FOCUSED = 0xF51E304F;
    private static final int RING = 0xFFF0F5FF;
    /** oklch(0.545 0.19 271.5 / 0.55) */
    private static final int HALO = 0x8C4C60DD;

    private final Activity activity;
    private final float unit;
    private final Listener listener;
    private final Handler clock = new Handler(Looper.getMainLooper());
    private final Runnable closeLater = this::close;

    private final FrameLayout root;
    private final TextView title;
    private final TextView count;
    private final List<Row> rows = new ArrayList<>();

    @Nullable
    private ChannelDirectory directory = null;
    private int highlighted = 0;
    private int first = 0;
    private String playing = "";

    MiniGuide(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
        this.unit = ChannelOverlay.unitFor(activity);

        root = new FrameLayout(activity);
        root.setFocusable(false);

        View scrim = new View(activity);
        scrim.setBackground(new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, new int[] { 0xF703080F, 0xE603080F, 0x0003080F }));
        root.addView(scrim, new FrameLayout.LayoutParams(px(820), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START));

        LinearLayout rail = new LinearLayout(activity);
        rail.setOrientation(LinearLayout.VERTICAL);
        FrameLayout.LayoutParams railAt = new FrameLayout.LayoutParams(px(640), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START);
        railAt.leftMargin = px(96);
        railAt.topMargin = px(54);
        railAt.bottomMargin = px(54);
        root.addView(rail, railAt);

        LinearLayout heading = new LinearLayout(activity);
        heading.setOrientation(LinearLayout.HORIZONTAL);
        heading.setBaselineAligned(true);
        rail.addView(heading);
        title = text(26, ChannelOverlay.DIM, Typeface.BOLD);
        title.setLetterSpacing(0.08f);
        heading.addView(title);
        count = text(24, ChannelOverlay.DIM, Typeface.NORMAL);
        LinearLayout.LayoutParams countAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        countAt.leftMargin = px(16);
        heading.addView(count, countAt);

        LinearLayout list = new LinearLayout(activity);
        list.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams listAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        listAt.topMargin = px(16);
        rail.addView(list, listAt);

        // As many rows as fit between the heading and the footer.
        int screen = Math.min(activity.getResources().getDisplayMetrics().widthPixels, activity.getResources().getDisplayMetrics().heightPixels);
        float available = screen / unit - 108 - 42 - 16 - 16 - 36;
        int visible = Math.max(3, (int) ((available + ROW_GAP) / (ROW_HEIGHT + ROW_GAP)));
        for (int i = 0; i < visible; i++) {
            Row row = new Row(activity);
            LinearLayout.LayoutParams rowAt = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(ROW_HEIGHT));
            rowAt.topMargin = i == 0 ? 0 : px(ROW_GAP);
            list.addView(row, rowAt);
            rows.add(row);
        }

        listenForTouches(list);

        root.setVisibility(View.GONE);
        activity.addContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /**
     * A finger, on a phone, where the Guide button opens it (PX-P-3): a tap on
     * a channel plays it, as OK does; a drag along the list moves through the
     * channels; a tap beside the list closes it. Nothing streams until a tap
     * on a channel, as with the remote.
     */
    private void listenForTouches(View list) {
        android.view.GestureDetector gestures = new android.view.GestureDetector(activity, new android.view.GestureDetector.SimpleOnGestureListener() {
            private float carried = 0f;

            @Override
            public boolean onDown(@NonNull android.view.MotionEvent event) {
                carried = 0f;
                touched();
                return true;
            }

            @Override
            public boolean onScroll(@Nullable android.view.MotionEvent start, @NonNull android.view.MotionEvent now, float dx, float dy) {
                carried += dy;
                float step = px(ROW_HEIGHT + ROW_GAP);
                while (Math.abs(carried) >= step) {
                    scrollBy(carried > 0 ? 1 : -1);
                    carried -= Math.signum(carried) * step;
                }
                return true;
            }

            @Override
            public boolean onSingleTapUp(@NonNull android.view.MotionEvent event) {
                for (int i = 0; i < rows.size(); i++) {
                    Row row = rows.get(i);
                    if (row.getVisibility() == View.VISIBLE && event.getY() >= row.getTop() && event.getY() < row.getBottom()) {
                        highlighted = first + i;
                        choose();
                        return true;
                    }
                }
                // Below the last row: as beside the list, the guide closes.
                close();
                return true;
            }
        });
        list.setOnTouchListener((view, event) -> {
            gestures.onTouchEvent(event);
            if (event.getAction() == android.view.MotionEvent.ACTION_UP) {
                view.performClick();
            }
            return true;
        });
        // Beside the list: closes it, rather than reaching the player underneath.
        root.setOnClickListener(view -> close());
    }

    /** A drag: the window of channels moves, the highlight staying inside it. */
    private void scrollBy(int by) {
        if (directory == null) {
            return;
        }
        int size = directory.channels.size();
        first = Math.max(0, Math.min(Math.max(0, size - rows.size()), first + by));
        highlighted = Math.max(first, Math.min(first + rows.size() - 1, highlighted));
        draw();
    }

    void setDirectory(@Nullable ChannelDirectory directory) {
        this.directory = directory;
        if (isShowing()) {
            draw();
        }
    }

    boolean canOpen() {
        return directory != null && !directory.channels.isEmpty();
    }

    boolean isShowing() {
        return root.getVisibility() == View.VISIBLE;
    }

    /** Opens with the highlight on the channel playing. */
    void open(String playingItemId) {
        if (!canOpen()) {
            return;
        }
        playing = playingItemId;
        highlighted = Math.max(0, directory.indexOf(playingItemId));
        first = Math.max(0, highlighted - rows.size() / 2);
        draw();
        touched();
        root.setVisibility(View.VISIBLE);
        listener.changed();
    }

    /** Up (-1) or Down (+1): the highlight only. */
    void move(int by) {
        if (directory == null) {
            return;
        }
        int size = directory.channels.size();
        highlighted = ((highlighted + by) % size + size) % size;
        if (highlighted < first) {
            first = highlighted;
        } else if (highlighted >= first + rows.size()) {
            first = highlighted - rows.size() + 1;
        }
        draw();
        touched();
    }

    /** OK: the highlighted channel, then close. */
    void choose() {
        if (directory == null) {
            return;
        }
        ChannelDirectory.Channel channel = directory.channels.get(highlighted);
        close();
        if (!channel.itemId.equals(playing)) {
            listener.chosen(channel);
        }
    }

    void close() {
        clock.removeCallbacks(closeLater);
        boolean was = isShowing();
        root.setVisibility(View.GONE);
        if (was) {
            listener.changed();
        }
    }

    private void touched() {
        clock.removeCallbacks(closeLater);
        clock.postDelayed(closeLater, UNTOUCHED_MS);
    }

    private void draw() {
        if (directory == null) {
            return;
        }
        int size = directory.channels.size();
        first = Math.max(0, Math.min(first, size - rows.size()));
        title.setText(directory.title.toUpperCase(Locale.ROOT));
        count.setText(Texts.channels(size));
        long now = System.currentTimeMillis();
        for (int i = 0; i < rows.size(); i++) {
            int index = first + i;
            Row row = rows.get(i);
            if (index >= size) {
                row.setVisibility(View.INVISIBLE);
                continue;
            }
            row.setVisibility(View.VISIBLE);
            ChannelDirectory.Channel channel = directory.channels.get(index);
            row.show(channel, index == highlighted, channel.itemId.equals(playing), now);
        }
    }

    private TextView text(float size, int colour, int style) {
        TextView view = new TextView(activity);
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * unit);
        view.setTextColor(colour);
        view.setTypeface(Typeface.create("sans-serif", style));
        view.setIncludeFontPadding(false);
        return view;
    }

    private int px(float designPx) {
        return Math.round(designPx * unit);
    }

    /** One channel: number, name, and what is on -- or "Playing now". */
    private final class Row extends LinearLayout {
        private final TextView number;
        private final TextView name;
        private final TextView sub;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();
        private boolean focused = false;
        private boolean current = false;

        Row(Activity activity) {
            super(activity);
            setOrientation(HORIZONTAL);
            setGravity(Gravity.CENTER_VERTICAL);
            setPadding(px(22), 0, px(22), 0);
            setWillNotDraw(false);

            number = text(28, ChannelOverlay.MUTED, Typeface.BOLD);
            addView(number, new LayoutParams(px(76), ViewGroup.LayoutParams.WRAP_CONTENT));

            LinearLayout words = new LinearLayout(activity);
            words.setOrientation(VERTICAL);
            LayoutParams wordsAt = new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            wordsAt.leftMargin = px(20);
            addView(words, wordsAt);

            name = text(26, ChannelOverlay.FG, Typeface.BOLD);
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.END);
            words.addView(name);
            sub = text(24, ChannelOverlay.MUTED, Typeface.NORMAL);
            sub.setSingleLine(true);
            sub.setEllipsize(TextUtils.TruncateAt.END);
            LayoutParams subAt = new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            subAt.topMargin = px(4);
            words.addView(sub, subAt);
        }

        void show(ChannelDirectory.Channel channel, boolean focused, boolean current, long now) {
            this.focused = focused;
            this.current = current;
            number.setText(channel.number);
            number.setTextColor(focused || current ? ChannelOverlay.FG : ChannelOverlay.MUTED);
            name.setText(channel.tags.isEmpty() ? channel.name : channel.name + " " + channel.tags);
            if (current) {
                sub.setText(Texts.t("mini.playingNow"));
                sub.setTextColor(ChannelOverlay.LIVE);
            } else {
                sub.setText(channel.onNow(now));
                sub.setTextColor(channel.hasGuide ? ChannelOverlay.MUTED : ChannelOverlay.DIM);
            }
            invalidate();
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            float radius = px(6);
            box.set(0, 0, getWidth(), getHeight());
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(focused ? ROW_FOCUSED : ROW);
            canvas.drawRoundRect(box, radius, radius, paint);

            if (current) {
                // The green spine: playing now, which is not the same as focus.
                canvas.save();
                canvas.clipRect(0, 0, px(5), getHeight());
                paint.setColor(ChannelOverlay.LIVE);
                canvas.drawRoundRect(box, radius, radius, paint);
                canvas.restore();
            }

            if (focused) {
                // Inset, so the first and last rows of a scrolled list keep it whole.
                paint.setStyle(Paint.Style.STROKE);
                float halo = px(11);
                paint.setStrokeWidth(halo);
                paint.setColor(HALO);
                box.set(halo / 2, halo / 2, getWidth() - halo / 2, getHeight() - halo / 2);
                canvas.drawRoundRect(box, radius, radius, paint);
                float ring = px(4);
                paint.setStrokeWidth(ring);
                paint.setColor(RING);
                box.set(ring / 2, ring / 2, getWidth() - ring / 2, getHeight() - ring / 2);
                canvas.drawRoundRect(box, radius, radius, paint);
            }
        }
    }
}
