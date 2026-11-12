package app.tvinto.player;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Outline;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.animation.DecelerateInterpolator;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The pieces section 5b is drawn with: its colours, text, the panel with a
 * kind spine, buttons whose focus ring sits outside them, the progress bar,
 * the moving meter and the rows of the track rail.
 *
 * Every size is a design pixel: on a television the boards are 1920 wide, and
 * on a phone PL-P-2 is drawn in dp. `unit` turns one into the other.
 */
final class FilmUi {

    // Design tokens, converted from oklch.
    static final int FG = 0xFFE6EEFC;
    static final int MUTED = 0xFF8CABFF;
    static final int DIM = 0xFF71809F;
    static final int PRIMARY = 0xFF4C60DD;
    static final int PRIMARY_BRIGHT = 0xFF7B95FF;
    static final int ON_PRIMARY = 0xFFFAFCFF;
    static final int CARD = 0xFF0F1D36;
    static final int CARD_2 = 0xFF162643;
    static final int CARD_3 = 0xFF1E304F;
    static final int BORDER_2 = 0xFF344C79;
    static final int FILM = 0xFF4D7FF1;
    static final int SERIES = 0xFFA975E0;
    static final int RING = 0xFFF0F5FF;
    /** oklch(0.545 0.19 271.5 / 0.5) */
    static final int HALO = 0x804C60DD;
    /** oklch(0.168 0.036 260 / 0.94) */
    static final int PANEL = 0xF0060F1E;
    /** oklch(0.168 0.036 260 / 0.96) */
    static final int PANEL_SOLID = 0xF5060F1E;
    /** --bg2, the phone's sheet. */
    static final int SHEET = 0xFF060F1E;
    /** oklch(0.32 0.04 261): the bar's track. */
    static final int TRACK = 0xFF273347;
    /** oklch(0.3 0.05 261): the meter's track. */
    static final int METER_TRACK = 0xFF1F2E47;
    /** oklch(0.7 0.16 271.5 / 0.45): the stretch a seek will cover. */
    static final int SPAN = 0x737B95FF;
    /** oklch(0.13 0.02 255): scrims, at the alphas each board gives. */
    static final int SCRIM = 0x0003080F;

    // Round 12 (PX-TV-1 to PX-P-3): words straight on the picture, over fades.
    /** oklch(0.98 0 0): titles, times, and the focused pill. */
    static final int WHITE = 0xFFF9F9F9;
    /** oklch(0.86 0.01 260): the show above an episode's name. */
    static final int SOFT = 0xFFD2D6DE;
    /** oklch(0.72 0.02 260): the quieter words. */
    static final int QUIET = 0xFFA6ADBA;
    /** oklch(0.16 0.03 260): words on the white pill. */
    static final int INK = 0xFF0C1322;
    /** White at 0.28: the bar's track over the picture. */
    static final int TRACK_ON_PICTURE = 0x47FFFFFF;
    /** White at 0.3: an outlined pill's edge. */
    static final int EDGE = 0x4DFFFFFF;
    /** oklch(0.08 0.01 260): the fades, at the alphas each board gives. */
    static final int FADE = 0x00020509;

    static int fade(float alpha) {
        return (Math.round(alpha * 255) << 24) | (FADE & 0xFFFFFF);
    }

    static int scrim(float alpha) {
        return (Math.round(alpha * 255) << 24) | (SCRIM & 0xFFFFFF);
    }

    private final Context context;
    final float unit;

    FilmUi(Context context, float unit) {
        this.context = context;
        this.unit = unit;
    }

    int px(float designPx) {
        return Math.round(designPx * unit);
    }

    TextView text(float size, int colour, int style) {
        TextView view = new TextView(context);
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * unit);
        view.setTextColor(colour);
        view.setTypeface(Typeface.create("sans-serif", style));
        view.setIncludeFontPadding(false);
        return view;
    }

    /** Times and numbers: the boards set them in JetBrains Mono, and a monospace keeps them from jittering. */
    TextView mono(float size, int colour, boolean bold) {
        TextView view = text(size, colour, Typeface.NORMAL);
        view.setTypeface(Typeface.create(Typeface.MONOSPACE, bold ? Typeface.BOLD : Typeface.NORMAL));
        return view;
    }

    TextView label(float size, int colour, float spacing) {
        TextView view = text(size, colour, Typeface.BOLD);
        view.setLetterSpacing(spacing);
        return view;
    }

    static void oneLine(TextView view) {
        view.setSingleLine(true);
        view.setEllipsize(TextUtils.TruncateAt.END);
    }

    static void rounded(View view, float radiusPx) {
        view.setClipToOutline(true);
        view.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View v, Outline outline) {
                outline.setRoundRect(0, 0, v.getWidth(), v.getHeight(), radiusPx);
            }
        });
    }

    /**
     * A panel with a coloured spine down its left edge. Returns the column
     * inside, which is what gets filled; the panel is its parent.
     */
    LinearLayout panel(int spine, float spineWidth, int background, float radius, float padV, float padH) {
        LinearLayout panel = new LinearLayout(context);
        panel.setOrientation(LinearLayout.HORIZONTAL);
        panel.setBackgroundColor(background);
        rounded(panel, px(radius));

        View edge = new View(context);
        edge.setBackgroundColor(spine);
        panel.addView(edge, new LinearLayout.LayoutParams(px(spineWidth), ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout body = new LinearLayout(context);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(px(padH), px(padV), px(padH), px(padV));
        // The buttons' rings are drawn outside them.
        body.setClipChildren(false);
        body.setClipToPadding(false);
        panel.addView(body, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return body;
    }

    LinearLayout row(boolean baseline) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setBaselineAligned(baseline);
        row.setGravity(baseline ? Gravity.NO_GRAVITY : Gravity.CENTER_VERTICAL);
        row.setClipChildren(false);
        row.setClipToPadding(false);
        return row;
    }

    LinearLayout column(float gap) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setClipChildren(false);
        column.setClipToPadding(false);
        column.setTag(gap);
        return column;
    }

    /** Adds to a column with its gap above everything but the first. */
    void stack(LinearLayout column, View child, float gap) {
        LinearLayout.LayoutParams at = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        at.topMargin = column.getChildCount() == 0 ? 0 : px(gap);
        column.addView(child, at);
    }

    LinearLayout.LayoutParams beside(float leftGap) {
        LinearLayout.LayoutParams at = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        at.leftMargin = px(leftGap);
        return at;
    }

    LinearLayout.LayoutParams stretch(float leftGap) {
        LinearLayout.LayoutParams at = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        at.leftMargin = px(leftGap);
        return at;
    }

    /** Pushes what follows to the far end of a row. */
    View spring() {
        View spring = new View(context);
        spring.setLayoutParams(new LinearLayout.LayoutParams(0, 1, 1f));
        return spring;
    }

    // --- Buttons ---------------------------------------------------------------

    /**
     * A button of the controls row. Focus is a ring outside it -- 4px of --ring
     * and 11px of primary halo -- so a focused button never changes size, and
     * its parents must not clip their children.
     */
    static class Button extends TextView {
        private final float unit;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();
        private boolean primary;
        private boolean focused = false;
        /** An outlined key legend (PL-TV-6) rather than a button. */
        private boolean outlined = false;

        Button(Context context, float unit, boolean primary) {
            super(context);
            this.unit = unit;
            this.primary = primary;
            setGravity(Gravity.CENTER);
            setIncludeFontPadding(false);
            setFocusable(false);
            setWillNotDraw(false);
        }

        void setPrimary(boolean primary) {
            this.primary = primary;
            setTextColor(primary ? ON_PRIMARY : FG);
            invalidate();
        }

        void setOutlined(boolean outlined) {
            this.outlined = outlined;
            invalidate();
        }

        void setFocusedLook(boolean focused) {
            if (this.focused != focused) {
                this.focused = focused;
                invalidate();
            }
        }

        boolean isFocusedLook() {
            return focused;
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            // A single-line label scrolls itself sideways inside the view, and
            // the canvas arrives scrolled with it: the ground is drawn where the
            // button is, or a pill's white went off its edge and only the dark
            // words were left.
            canvas.save();
            canvas.translate(getScrollX(), getScrollY());
            drawGround(canvas);
            canvas.restore();
            super.onDraw(canvas);
        }

        /** What is under the words: a pill draws its own. */
        void drawGround(@NonNull Canvas canvas) {
            float radius = 6 * unit;
            if (focused) {
                // Outside the box: the halo first, then the ring over it.
                float halo = 11 * unit;
                float ring = 4 * unit;
                paint.setStyle(Paint.Style.FILL);
                paint.setColor(HALO);
                box.set(-halo, -halo, getWidth() + halo, getHeight() + halo);
                canvas.drawRoundRect(box, radius + halo, radius + halo, paint);
                paint.setColor(RING);
                box.set(-ring, -ring, getWidth() + ring, getHeight() + ring);
                canvas.drawRoundRect(box, radius + ring, radius + ring, paint);
            }
            box.set(0, 0, getWidth(), getHeight());
            if (outlined) {
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(Math.max(1f, unit));
                paint.setColor(BORDER_2);
                box.inset(paint.getStrokeWidth() / 2, paint.getStrokeWidth() / 2);
                canvas.drawRoundRect(box, radius, radius, paint);
                paint.setStyle(Paint.Style.FILL);
            } else {
                paint.setStyle(Paint.Style.FILL);
                paint.setColor(primary ? PRIMARY : CARD_2);
                canvas.drawRoundRect(box, radius, radius, paint);
            }
        }
    }

    /**
     * A control of round 12's row (PX-TV-1): an icon and a word straight on
     * the picture, and focus a white pill behind them, as Netflix draws it.
     *
     * Two other looks for the next-episode card (PX-TV-7): `edged`, an outline
     * at rest; and `filling`, a pale pill that fills white from the left as
     * the countdown runs -- full, it plays.
     */
    static final class Pill extends Button {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();
        @Nullable
        private Icon icon;
        boolean edged = false;
        /** How far the countdown has run, 0 to 1; negative for an ordinary pill. */
        float filling = -1f;
        private final float pillUnit;

        Pill(Context context, float unit) {
            super(context, unit, false);
            this.pillUnit = unit;
        }

        void setIcon(int kind, float size) {
            icon = new Icon(kind, WHITE);
            int side = Math.round(size * pillUnit);
            icon.setBounds(0, 0, side, side);
            setCompoundDrawablesRelative(icon, null, null, null);
            recolour();
        }

        void setIconKind(int kind) {
            if (icon != null && icon.kind != kind) {
                icon.kind = kind;
                icon.invalidateSelf();
            }
        }

        @Override
        void setFocusedLook(boolean focused) {
            super.setFocusedLook(focused);
            recolour();
        }

        void recolour() {
            int colour = isFocusedLook() || filling >= 0 ? INK : WHITE;
            setTextColor(colour);
            if (icon != null) {
                icon.setColour(colour);
            }
            invalidate();
        }

        @Override
        void drawGround(@NonNull Canvas canvas) {
            float radius = getHeight() / 2f;
            box.set(0, 0, getWidth(), getHeight());
            paint.setStyle(Paint.Style.FILL);
            if (filling >= 0) {
                paint.setColor(0xBFFFFFFF);
                canvas.drawRoundRect(box, radius, radius, paint);
                canvas.save();
                canvas.clipRect(0, 0, getWidth() * Math.max(0f, Math.min(1f, filling)), getHeight());
                paint.setColor(WHITE);
                canvas.drawRoundRect(box, radius, radius, paint);
                canvas.restore();
                if (isFocusedLook()) {
                    // A ring outside it, so the fill stays readable.
                    float gap = 4 * pillUnit;
                    float ring = 4 * pillUnit;
                    paint.setStyle(Paint.Style.STROKE);
                    paint.setStrokeWidth(ring);
                    paint.setColor(WHITE);
                    box.set(-gap - ring / 2, -gap - ring / 2, getWidth() + gap + ring / 2, getHeight() + gap + ring / 2);
                    canvas.drawRoundRect(box, radius + gap, radius + gap, paint);
                }
                return;
            }
            if (isFocusedLook()) {
                paint.setColor(WHITE);
                canvas.drawRoundRect(box, radius, radius, paint);
            } else if (edged) {
                float stroke = Math.max(1f, 2 * pillUnit);
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(stroke);
                paint.setColor(EDGE);
                box.inset(stroke / 2, stroke / 2);
                canvas.drawRoundRect(box, radius, radius, paint);
            }
        }
    }

    /** A round control on a phone's picture (PX-P-1): back 10 s, play or pause, forward 10 s. */
    static final class RoundIcon extends View {
        final Icon icon;
        private final boolean grounded;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        RoundIcon(Context context, int kind, boolean grounded) {
            super(context);
            this.icon = new Icon(kind, WHITE);
            this.grounded = grounded;
            setClickable(true);
            setFocusable(false);
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            if (grounded) {
                paint.setColor(0x24FFFFFF);
                canvas.drawCircle(getWidth() / 2f, getHeight() / 2f, Math.min(getWidth(), getHeight()) / 2f, paint);
            }
            int side = Math.round(Math.min(getWidth(), getHeight()) * (grounded ? 0.5f : 0.62f));
            int left = (getWidth() - side) / 2;
            int top = (getHeight() - side) / 2;
            icon.setBounds(left, top, left + side, top + side);
            icon.draw(canvas);
        }
    }

    Pill pill(int iconKind, String words, float height, float padH, float size, float iconSize) {
        Pill pill = new Pill(context, unit);
        pill.setText(words);
        pill.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * unit);
        pill.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        pill.setSingleLine(true);
        pill.setPadding(px(padH), 0, px(padH), 0);
        pill.setMinHeight(px(height));
        pill.setHeight(px(height));
        if (iconKind >= 0) {
            pill.setCompoundDrawablePadding(px(size / 2));
            pill.setIcon(iconKind, iconSize);
        } else {
            pill.recolour();
        }
        return pill;
    }

    // --- Icons -----------------------------------------------------------------

    /**
     * The row's icons, drawn rather than taken from a font: a television's
     * fonts have no pause or subtitles glyph worth the name. Each is laid out
     * on a 24-unit square, as the boards' SVGs are.
     */
    static final class Icon extends android.graphics.drawable.Drawable {
        static final int PLAY = 0;
        static final int PAUSE = 1;
        static final int BACK_10 = 2;
        static final int FORWARD_10 = 3;
        static final int EPISODES = 4;
        static final int NEXT = 5;
        static final int TRACKS = 6;
        static final int START_OVER = 7;
        static final int SPEED = 8;
        static final int SLEEP = 9;
        static final int BACK = 10;
        static final int CHECK = 11;
        static final int GUIDE = 12;

        int kind;
        private int colour;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final android.graphics.Path path = new android.graphics.Path();
        private final RectF oval = new RectF();

        Icon(int kind, int colour) {
            this.kind = kind;
            this.colour = colour;
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
        }

        void setColour(int colour) {
            this.colour = colour;
            invalidateSelf();
        }

        @Override
        public void draw(@NonNull Canvas canvas) {
            android.graphics.Rect bounds = getBounds();
            float s = bounds.width() / 24f;
            canvas.save();
            canvas.translate(bounds.left, bounds.top);
            canvas.scale(s, s);
            paint.setColor(colour);
            paint.setStrokeWidth(2.2f);
            path.reset();
            switch (kind) {
                case PLAY:
                    fill();
                    path.moveTo(7, 4.5f);
                    path.lineTo(7, 19.5f);
                    path.lineTo(19.5f, 12);
                    path.close();
                    canvas.drawPath(path, paint);
                    break;
                case PAUSE:
                    fill();
                    canvas.drawRoundRect(6, 4.5f, 10, 19.5f, 1, 1, paint);
                    canvas.drawRoundRect(14, 4.5f, 18, 19.5f, 1, 1, paint);
                    break;
                case BACK_10:
                case START_OVER:
                    circleBack(canvas, false);
                    if (kind == BACK_10) {
                        ten(canvas);
                    }
                    break;
                case FORWARD_10:
                    circleBack(canvas, true);
                    ten(canvas);
                    break;
                case EPISODES:
                    stroke();
                    canvas.drawRoundRect(3, 5, 16, 15, 1.5f, 1.5f, paint);
                    path.moveTo(7, 19);
                    path.lineTo(20, 19);
                    path.lineTo(20, 9);
                    canvas.drawPath(path, paint);
                    break;
                case NEXT:
                    fill();
                    path.moveTo(5, 4.5f);
                    path.lineTo(5, 19.5f);
                    path.lineTo(16, 12);
                    path.close();
                    canvas.drawPath(path, paint);
                    stroke();
                    canvas.drawLine(19, 5, 19, 19, paint);
                    break;
                case TRACKS:
                    stroke();
                    canvas.drawRoundRect(2.5f, 5, 21.5f, 19, 2, 2, paint);
                    canvas.drawLine(7, 13, 11, 13, paint);
                    canvas.drawLine(13, 13, 17, 13, paint);
                    canvas.drawLine(7, 16, 14, 16, paint);
                    break;
                case SPEED:
                    stroke();
                    oval.set(3, 4.03f, 21, 22.03f);
                    canvas.drawArc(oval, 146.5f, 247f, false, paint);
                    canvas.drawLine(12, 13, 16, 8, paint);
                    break;
                case SLEEP:
                    stroke();
                    android.graphics.Path disc = new android.graphics.Path();
                    disc.addCircle(11, 13, 8.2f, android.graphics.Path.Direction.CW);
                    android.graphics.Path bite = new android.graphics.Path();
                    bite.addCircle(16.5f, 7.5f, 6.5f, android.graphics.Path.Direction.CW);
                    disc.op(bite, android.graphics.Path.Op.DIFFERENCE);
                    canvas.drawPath(disc, paint);
                    break;
                case BACK:
                    stroke();
                    path.moveTo(15, 5);
                    path.lineTo(8, 12);
                    path.lineTo(15, 19);
                    canvas.drawPath(path, paint);
                    break;
                case GUIDE:
                    stroke();
                    canvas.drawRoundRect(3, 4, 21, 20, 2, 2, paint);
                    canvas.drawLine(3, 9, 21, 9, paint);
                    canvas.drawLine(9, 9, 9, 20, paint);
                    break;
                case CHECK:
                default:
                    stroke();
                    path.moveTo(5, 12.5f);
                    path.lineTo(9.5f, 17);
                    path.lineTo(19, 7.5f);
                    canvas.drawPath(path, paint);
                    break;
            }
            canvas.restore();
        }

        /** Most of a circle with its arrowhead at the top left; mirrored, at the top right. */
        private void circleBack(Canvas canvas, boolean mirrored) {
            stroke();
            canvas.save();
            if (mirrored) {
                canvas.scale(-1, 1, 12, 12);
            }
            oval.set(3, 3, 21, 21);
            canvas.drawArc(oval, 180f, -311.8f, false, paint);
            path.reset();
            path.moveTo(3, 3);
            path.lineTo(3, 8);
            path.lineTo(8, 8);
            canvas.drawPath(path, paint);
            canvas.restore();
        }

        private void ten(Canvas canvas) {
            fill();
            paint.setTextSize(7.5f);
            paint.setTextAlign(Paint.Align.CENTER);
            paint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
            canvas.drawText("10", 12, 15.3f, paint);
        }

        private void fill() {
            paint.setStyle(Paint.Style.FILL);
        }

        private void stroke() {
            paint.setStyle(Paint.Style.STROKE);
        }

        @Override
        public void setAlpha(int alpha) {
            paint.setAlpha(alpha);
        }

        @Override
        public void setColorFilter(@Nullable android.graphics.ColorFilter filter) {
            paint.setColorFilter(filter);
        }

        @Override
        public int getOpacity() {
            return android.graphics.PixelFormat.TRANSLUCENT;
        }
    }

    Button button(String words, boolean primary, float height, float padH, float size) {
        Button button = new Button(context, unit, primary);
        button.setText(words);
        button.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * unit);
        button.setTypeface(Typeface.create("sans-serif", primary ? Typeface.BOLD : Typeface.NORMAL));
        button.setTextColor(primary ? ON_PRIMARY : FG);
        button.setPadding(px(padH), 0, px(padH), 0);
        button.setMinHeight(px(height));
        button.setHeight(px(height));
        return button;
    }

    // --- The bar ---------------------------------------------------------------

    /**
     * The progress bar: a track, the part played in --pri2 and a thumb. While a
     * seek is under way it also shows where it began -- a grey tick -- and the
     * stretch between, pale (PL-TV-5b).
     */
    static final class Bar extends View {
        float played = 0f;
        /** Where a seek began, or a negative number when none is under way. */
        float from = -1f;
        float thumb = 18f;
        float thickness = 6f;
        boolean showThumb = true;
        private final float unit;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();

        Bar(Context context, float unit) {
            super(context);
            this.unit = unit;
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            float height = thickness * unit;
            float radius = height / 2;
            float mid = getHeight() / 2f;
            float inset = showThumb ? thumb * unit / 2 : 0;
            float left = inset;
            float width = Math.max(1f, getWidth() - inset * 2);
            float top = mid - height / 2;

            paint.setColor(TRACK_ON_PICTURE);
            box.set(left, top, left + width, top + height);
            canvas.drawRoundRect(box, radius, radius, paint);

            float at = left + width * clamp(played);
            if (from >= 0) {
                float start = left + width * clamp(from);
                paint.setColor(PRIMARY_BRIGHT);
                box.set(left, top, Math.min(start, at), top + height);
                canvas.drawRoundRect(box, radius, radius, paint);
                paint.setColor(SPAN);
                box.set(Math.min(start, at), top, Math.max(start, at), top + height);
                canvas.drawRect(box, paint);
                paint.setColor(DIM);
                float tick = 2 * unit;
                float tall = 22 * unit * (thickness / 6f);
                box.set(start - tick / 2, mid - tall / 2, start + tick / 2, mid + tall / 2);
                canvas.drawRect(box, paint);
            } else {
                paint.setColor(PRIMARY_BRIGHT);
                box.set(left, top, at, top + height);
                canvas.drawRoundRect(box, radius, radius, paint);
            }
            if (showThumb) {
                paint.setColor(WHITE);
                canvas.drawCircle(at, mid, thumb * unit / 2, paint);
            }
        }

        private static float clamp(float value) {
            return Math.max(0f, Math.min(1f, value));
        }
    }

    /**
     * The wait, as Netflix draws it (PX-TV-9, PX-TV-11): a faint circle and a
     * quarter of it in --pri2, turning. It replaced the meter for these two
     * waits, at a user's asking for "Netflix style" (30 October).
     */
    static final class Ring extends View {
        private final float unit;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();
        @Nullable
        private ValueAnimator turning;
        private float angle = 0f;

        Ring(Context context, float unit) {
            super(context);
            this.unit = unit;
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
        }

        void start() {
            if (turning != null) {
                return;
            }
            turning = ValueAnimator.ofFloat(0f, 360f);
            turning.setDuration(1000L);
            turning.setRepeatCount(ValueAnimator.INFINITE);
            turning.setInterpolator(new android.view.animation.LinearInterpolator());
            turning.addUpdateListener(animation -> {
                angle = (float) animation.getAnimatedValue();
                invalidate();
            });
            turning.start();
        }

        void stop() {
            if (turning != null) {
                turning.cancel();
                turning = null;
            }
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            float stroke = Math.max(2f, getWidth() / 12f);
            box.set(stroke / 2, stroke / 2, getWidth() - stroke / 2, getHeight() - stroke / 2);
            paint.setStrokeWidth(stroke);
            paint.setColor(0x2EFFFFFF);
            canvas.drawArc(box, 0f, 360f, false, paint);
            paint.setColor(PRIMARY_BRIGHT);
            canvas.drawArc(box, angle - 90f, 90f, false, paint);
        }
    }

    // --- Rail rows -------------------------------------------------------------

    /**
     * One track in the rail (PL-TV-5c). The one in use has a --pri2 spine and
     * says so in words; focus is an inset ring, so selected and focused never
     * look alike, and the top and bottom rows of a scrolled list never clip it.
     */
    static final class RailRow extends LinearLayout {
        final TextView name;
        final TextView note;
        private final float unit;
        private final boolean television;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();
        private boolean inUse = false;
        private boolean focused = false;

        RailRow(FilmUi ui, boolean television) {
            super(ui.context);
            this.unit = ui.unit;
            this.television = television;
            setOrientation(HORIZONTAL);
            setGravity(Gravity.CENTER_VERTICAL);
            setWillNotDraw(false);
            float pad = television ? 24 : 12;
            setPadding(ui.px(pad), 0, ui.px(pad), 0);
            name = ui.text(television ? 28 : 14, FG, Typeface.NORMAL);
            oneLine(name);
            addView(name, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            note = ui.text(television ? 24 : 13, PRIMARY_BRIGHT, Typeface.NORMAL);
            addView(note, ui.beside(television ? 16 : 8));
        }

        void set(String label, boolean inUse, boolean focused) {
            set(label, inUse, focused, Texts.t("track.inUse"));
        }

        /** With its own word for the row in use: the sleep timer's says how long is left. */
        void set(String label, boolean inUse, boolean focused, String inUseNote) {
            this.inUse = inUse;
            this.focused = focused;
            name.setText(label);
            name.setTypeface(Typeface.create("sans-serif", inUse || focused ? Typeface.BOLD : Typeface.NORMAL));
            if (inUse) {
                note.setText(inUseNote);
                note.setTextColor(PRIMARY_BRIGHT);
                note.setTextSize(TypedValue.COMPLEX_UNIT_PX, (television ? 24 : 13) * unit);
            } else {
                note.setText("");
            }
            // The spine sits inside the row, so the words move over for it.
            float pad = television ? 24 : 12;
            float spine = inUse ? (television ? 5 : 4) : 0;
            setPadding(Math.round((pad + spine) * unit), 0, Math.round(pad * unit), 0);
            invalidate();
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            float radius = 6 * unit;
            box.set(0, 0, getWidth(), getHeight());
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(focused ? CARD_3 : inUse ? CARD_2 : CARD);
            canvas.drawRoundRect(box, radius, radius, paint);
            if (inUse) {
                canvas.save();
                canvas.clipRect(0, 0, (television ? 5 : 4) * unit, getHeight());
                paint.setColor(PRIMARY_BRIGHT);
                canvas.drawRoundRect(box, radius, radius, paint);
                canvas.restore();
            }
            if (focused) {
                paint.setStyle(Paint.Style.STROKE);
                float halo = 11 * unit;
                float ring = 4 * unit;
                paint.setStrokeWidth(halo);
                paint.setColor(0x8C4C60DD);
                box.set(halo / 2, halo / 2, getWidth() - halo / 2, getHeight() - halo / 2);
                canvas.drawRoundRect(box, radius, radius, paint);
                paint.setStrokeWidth(ring);
                paint.setColor(RING);
                box.set(ring / 2, ring / 2, getWidth() - ring / 2, getHeight() - ring / 2);
                canvas.drawRoundRect(box, radius, radius, paint);
                paint.setStyle(Paint.Style.FILL);
            }
        }
    }

    // --- Round 12's lists -------------------------------------------------------

    /**
     * One choice in Audio & subtitles on a television (PX-TV-5): a tick on the
     * one in use, and focus a white plate. Selected and focused never look
     * alike -- the tick says one, the plate the other.
     */
    static final class ChoiceRow extends LinearLayout {
        final TextView name;
        private final Icon tick = new Icon(Icon.CHECK, WHITE);
        private final View tickView;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();
        private final float unit;
        private boolean focused = false;

        ChoiceRow(FilmUi ui) {
            super(ui.context);
            this.unit = ui.unit;
            setOrientation(HORIZONTAL);
            setGravity(Gravity.CENTER_VERTICAL);
            setWillNotDraw(false);
            setPadding(ui.px(22), 0, ui.px(22), 0);
            tickView = new View(ui.context) {
                @Override
                protected void onDraw(@NonNull Canvas canvas) {
                    tick.setBounds(0, (getHeight() - getWidth()) / 2, getWidth(), (getHeight() + getWidth()) / 2);
                    tick.draw(canvas);
                }
            };
            addView(tickView, new LayoutParams(ui.px(28), ui.px(28)));
            name = ui.text(28, QUIET, Typeface.NORMAL);
            oneLine(name);
            LayoutParams nameAt = new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            nameAt.leftMargin = ui.px(16);
            addView(name, nameAt);
        }

        /** A line below the columns: its words in the middle, as the board centres them. */
        void centre() {
            setGravity(Gravity.CENTER);
            LayoutParams at = (LayoutParams) name.getLayoutParams();
            at.width = ViewGroup.LayoutParams.WRAP_CONTENT;
            at.weight = 0f;
            name.setLayoutParams(at);
            tickView.setVisibility(View.GONE);
            centred = true;
        }

        private boolean centred = false;

        void set(CharSequence label, boolean inUse, boolean focused) {
            this.focused = focused;
            name.setText(label);
            int colour = focused ? INK : inUse ? WHITE : QUIET;
            name.setTextColor(colour);
            name.setTypeface(Typeface.create("sans-serif", inUse || focused ? Typeface.BOLD : Typeface.NORMAL));
            tick.setColour(colour);
            if (!centred) {
                tickView.setVisibility(inUse ? View.VISIBLE : View.INVISIBLE);
            }
            tickView.invalidate();
            invalidate();
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            if (focused) {
                box.set(0, 0, getWidth(), getHeight());
                paint.setColor(WHITE);
                canvas.drawRoundRect(box, 8 * unit, 8 * unit, paint);
            }
            super.onDraw(canvas);
        }
    }

    /**
     * An episode in Episodes (PX-TV-3, PX-P-2): its still, how much has been
     * watched along the still's foot, and "Watching" on the one playing. A
     * television lays them in a row, a phone in a list; `wide` says which.
     */
    static final class EpisodeCard extends LinearLayout {
        final ImageView still;
        private final FrameLayoutWithRing plate;
        private final View watchedTrack;
        private final View watchedPart;
        private final TextView badge;
        private final TextView title;
        private final TextView sub;

        EpisodeCard(FilmUi ui, boolean wide) {
            super(ui.context);
            setOrientation(wide ? VERTICAL : HORIZONTAL);
            setGravity(wide ? Gravity.NO_GRAVITY : Gravity.CENTER_VERTICAL);
            setClipChildren(false);
            setClipToPadding(false);
            float width = wide ? 400 : 120;
            float height = wide ? 225 : 68;
            plate = new FrameLayoutWithRing(ui.context, ui.unit);
            plate.setBackgroundColor(CARD_3);
            rounded(plate, ui.px(wide ? 8 : 6));
            still = new ImageView(ui.context);
            still.setScaleType(ImageView.ScaleType.CENTER_CROP);
            plate.addView(still, new android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            watchedTrack = new View(ui.context);
            watchedTrack.setBackgroundColor(0x4DFFFFFF);
            plate.addView(watchedTrack, new android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ui.px(wide ? 6 : 3), Gravity.BOTTOM));
            watchedPart = new View(ui.context);
            watchedPart.setBackgroundColor(PRIMARY_BRIGHT);
            plate.addView(watchedPart, new android.widget.FrameLayout.LayoutParams(0, ui.px(wide ? 6 : 3), Gravity.BOTTOM | Gravity.START));
            badge = ui.text(20, ON_PRIMARY, Typeface.BOLD);
            badge.setBackgroundColor(PRIMARY);
            rounded(badge, ui.px(6));
            badge.setPadding(ui.px(12), ui.px(6), ui.px(12), ui.px(6));
            badge.setText(Texts.t("film.watching"));
            android.widget.FrameLayout.LayoutParams badgeAt = new android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START);
            badgeAt.leftMargin = ui.px(16);
            badgeAt.topMargin = ui.px(16);
            plate.addView(badge, badgeAt);
            badge.setVisibility(View.GONE);
            addView(plate, new LayoutParams(ui.px(width), ui.px(height)));

            LinearLayout words = new LinearLayout(ui.context);
            words.setOrientation(wide ? HORIZONTAL : VERTICAL);
            words.setBaselineAligned(wide);
            title = ui.text(wide ? 26 : 14, WHITE, Typeface.BOLD);
            oneLine(title);
            sub = ui.text(wide ? 22 : 12, QUIET, Typeface.NORMAL);
            if (wide) {
                words.addView(title, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                LayoutParams subAt = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                subAt.leftMargin = ui.px(14);
                words.addView(sub, subAt);
                LayoutParams wordsAt = new LayoutParams(ui.px(width), ViewGroup.LayoutParams.WRAP_CONTENT);
                wordsAt.topMargin = ui.px(14);
                addView(words, wordsAt);
            } else {
                words.addView(title);
                LayoutParams subAt = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                subAt.topMargin = ui.px(3);
                words.addView(sub, subAt);
                LayoutParams wordsAt = new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                wordsAt.leftMargin = ui.px(12);
                addView(words, wordsAt);
            }
        }

        /** "3  In Perpetuity", "57 min", how much is watched, and whether it is the one playing. */
        void set(String number, String name, String length, float watched, boolean playing) {
            title.setText(number.isEmpty() ? name : number + (getOrientation() == VERTICAL ? "  " : ". ") + name);
            String words = length;
            if (playing && getOrientation() == HORIZONTAL) {
                words = length.isEmpty() ? Texts.t("film.watching") : Texts.t("film.watching") + " · " + length;
            }
            sub.setText(words);
            sub.setTextColor(playing && getOrientation() == HORIZONTAL ? PRIMARY_BRIGHT : QUIET);
            badge.setVisibility(playing && getOrientation() == VERTICAL ? View.VISIBLE : View.GONE);
            boolean some = watched > 0f;
            watchedTrack.setVisibility(some ? View.VISIBLE : View.GONE);
            watchedPart.setVisibility(some ? View.VISIBLE : View.GONE);
            ViewGroup.LayoutParams part = watchedPart.getLayoutParams();
            part.width = Math.round(plate.getLayoutParams().width * Math.max(0f, Math.min(1f, watched)));
            watchedPart.setLayoutParams(part);
        }

        void setFocusedLook(boolean focused) {
            plate.ring = focused;
            plate.invalidate();
        }
    }

    /** The still's plate, which draws focus as a white ring inside its edge. */
    static final class FrameLayoutWithRing extends android.widget.FrameLayout {
        boolean ring = false;
        private final float unit;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();

        FrameLayoutWithRing(Context context, float unit) {
            super(context);
            this.unit = unit;
            setWillNotDraw(false);
        }

        @Override
        protected void dispatchDraw(@NonNull Canvas canvas) {
            super.dispatchDraw(canvas);
            if (ring) {
                float stroke = 5 * unit;
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(stroke);
                paint.setColor(WHITE);
                box.set(stroke / 2, stroke / 2, getWidth() - stroke / 2, getHeight() - stroke / 2);
                canvas.drawRoundRect(box, 8 * unit, 8 * unit, paint);
            }
        }
    }

    // --- Posters ---------------------------------------------------------------

    /**
     * A poster, fetched off the main thread and scaled down on the way in. The
     * plate keeps its colour when there is none, or when it will not load: a
     * missing poster is not worth saying anything about over a film.
     */
    ImageView poster(@Nullable String url, float width, float height) {
        ImageView view = new ImageView(context);
        view.setScaleType(ImageView.ScaleType.CENTER_CROP);
        view.setBackgroundColor(CARD_3);
        rounded(view, px(4));
        view.setLayoutParams(new LinearLayout.LayoutParams(px(width), px(height)));
        load(view, url, width);
        return view;
    }

    /** Puts another poster in a plate: the next episode's. The plate empties first, so the last one never lingers. */
    void load(ImageView view, @Nullable String url, float width) {
        view.setImageDrawable(null);
        view.setTag(url);
        if (url == null || !url.startsWith("http")) {
            return;
        }
        int wanted = px(width);
        Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            Bitmap bitmap = fetch(url, wanted);
            if (bitmap != null) {
                main.post(() -> {
                    // Only if it is still the poster wanted there.
                    if (url.equals(view.getTag())) {
                        view.setImageBitmap(bitmap);
                    }
                });
            }
        }, "film-poster").start();
    }

    @Nullable
    private static Bitmap fetch(String address, int width) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(address).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(8000);
            connection.setInstanceFollowRedirects(true);
            byte[] bytes;
            try (InputStream in = connection.getInputStream()) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] chunk = new byte[16 * 1024];
                int read;
                // A poster, not a film: stop at 4 MB whatever the server sends.
                while ((read = in.read(chunk)) != -1 && out.size() < 4 * 1024 * 1024) {
                    out.write(chunk, 0, read);
                }
                bytes = out.toByteArray();
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = 1;
            while (bounds.outWidth / (options.inSampleSize * 2) >= width) {
                options.inSampleSize *= 2;
            }
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        } catch (Exception | OutOfMemoryError ignored) {
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }
}
