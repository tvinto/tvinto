package app.tvinto.player;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Outline;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;

/**
 * What is drawn over the video while the channel changes: design boards
 * PL-TV-2 (switching), PL-TV-2b (the provider refused, retrying once) and the
 * strip that follows a second refusal. PL-P-1 draws the same panel at half the
 * size on a phone.
 *
 * Built in code rather than a layout file because every size is a design
 * pixel scaled to the screen -- the boards are 1920 wide -- and the panel has
 * three states that differ by a colour and a line or two.
 *
 * It takes no focus and handles no keys; the activity decides what a key does.
 */
final class ChannelOverlay {

    // Design tokens, converted from oklch.
    static final int FG = 0xFFE6EEFC;
    static final int MUTED = 0xFF8CABFF;
    static final int DIM = 0xFF71809F;
    static final int PRIMARY_BRIGHT = 0xFF7B95FF;
    static final int CARD_3 = 0xFF1E304F;
    static final int LIVE = 0xFF269F4C;
    static final int AIR = 0xFFF45249;
    /** oklch(0.168 0.036 260 / 0.96) */
    static final int PANEL = 0xF5060F1E;
    /** oklch(0.3 0.05 261) */
    static final int METER_TRACK = 0xFF1F2E47;

    /** What a switch panel says about the channel it is going to. */
    static final class Target {
        final String number;
        final String name;
        final String monogram;
        /** "HRT 1 · 101": where the switch came from. */
        final String from;
        /** "HRT 1": where Back goes. */
        final String back;

        Target(@Nullable String number, @Nullable String name, @Nullable String monogram, @Nullable String from, @Nullable String back) {
            this.number = number == null ? "" : number;
            this.name = name == null ? "" : name;
            this.monogram = monogram == null ? "" : monogram;
            this.from = from == null ? "" : from;
            this.back = back == null ? "" : back;
        }
    }

    private final Context context;
    /** Pixels per design pixel. */
    private final float unit;

    private final FrameLayout root;
    private final LinearLayout panel;
    private final View spine;
    private final TextView kicker;
    private final LinearLayout channel;
    private final TextView plate;
    private final TextView number;
    private final TextView name;
    private final TextView sub;
    private final LinearLayout meterBlock;
    private final Meter meter;
    private final TextView reason;
    private final TextView backLine;

    @Nullable
    private ValueAnimator advancing;

    ChannelOverlay(Activity activity) {
        context = activity;
        unit = unitFor(activity);

        root = new FrameLayout(activity);
        root.setFocusable(false);
        root.setClickable(false);

        panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.HORIZONTAL);
        panel.setBackgroundColor(PANEL);
        panel.setClipToOutline(true);
        panel.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), px(8));
            }
        });

        spine = new View(activity);
        spine.setBackgroundColor(AIR);
        panel.addView(spine, new LinearLayout.LayoutParams(px(6), ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(px(56), px(48), px(56), px(48));
        panel.addView(body, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        kicker = text(26, DIM, Typeface.BOLD);
        kicker.setLetterSpacing(0.08f);
        body.addView(kicker, stacked(0));

        channel = new LinearLayout(activity);
        channel.setOrientation(LinearLayout.HORIZONTAL);
        channel.setGravity(Gravity.CENTER_VERTICAL);
        body.addView(channel, stacked(28));

        plate = text(30, LIVE, Typeface.BOLD);
        plate.setGravity(Gravity.CENTER);
        GradientDrawable plateGround = new GradientDrawable();
        plateGround.setColor(CARD_3);
        plateGround.setCornerRadius(px(6));
        plate.setBackground(plateGround);
        channel.addView(plate, new LinearLayout.LayoutParams(px(140), px(94)));

        LinearLayout words = new LinearLayout(activity);
        words.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams wordsAt = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        wordsAt.leftMargin = px(28);
        channel.addView(words, wordsAt);

        LinearLayout title = new LinearLayout(activity);
        title.setOrientation(LinearLayout.HORIZONTAL);
        title.setBaselineAligned(true);
        words.addView(title, stacked(0));

        number = text(44, FG, Typeface.BOLD);
        title.addView(number, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        name = text(44, FG, Typeface.BOLD);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams nameAt = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        nameAt.leftMargin = px(18);
        title.addView(name, nameAt);

        sub = text(26, MUTED, Typeface.NORMAL);
        words.addView(sub, stacked(6));

        meterBlock = new LinearLayout(activity);
        meterBlock.setOrientation(LinearLayout.VERTICAL);
        body.addView(meterBlock, stacked(28));

        meter = new Meter(activity);
        meterBlock.addView(meter, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(8)));
        reason = text(26, MUTED, Typeface.NORMAL);
        meterBlock.addView(reason, stacked(12));

        backLine = text(24, DIM, Typeface.NORMAL);
        body.addView(backLine, stacked(28));

        // Never wider than the screen less its safe margins: a phone held
        // upright is narrower than the panel.
        int screenWidth = activity.getResources().getDisplayMetrics().widthPixels;
        int width = Math.min(px(1000), screenWidth - 2 * px(96));
        FrameLayout.LayoutParams centred = new FrameLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        root.addView(panel, centred);
        root.setVisibility(View.GONE);

        activity.addContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** PL-TV-2, or PL-TV-2b for the second attempt. The meter starts again either way. */
    void showSwitching(Target target, int attempt) {
        boolean retry = attempt > 1;

        spine.setVisibility(retry ? View.VISIBLE : View.GONE);
        kicker.setVisibility(View.VISIBLE);
        kicker.setText(Texts.t(retry ? "overlay.tryingAgain" : "overlay.changingTo"));
        kicker.setTextColor(retry ? AIR : DIM);
        describe(target);
        sub.setText(retry ? Texts.t("overlay.attempt") : target.from.isEmpty() ? "" : Texts.t("overlay.from", target.from));
        sub.setVisibility(sub.getText().length() == 0 ? View.GONE : View.VISIBLE);

        meterBlock.setVisibility(View.VISIBLE);
        meter.colour = retry ? AIR : PRIMARY_BRIGHT;
        reason.setText(
            retry
                ? Texts.t("overlay.turnedAway")
                : Texts.t("overlay.closingFirst")
        );
        showBackLine(retry ? target.back : "");
        advance();

        root.setVisibility(View.VISIBLE);
    }

    /** After the second refusal: a still strip, and where Back goes. No third attempt. */
    void showGaveUp(Target target, @Nullable String backTo) {
        stopAdvancing();
        spine.setVisibility(View.VISIBLE);
        kicker.setVisibility(View.GONE);
        describe(target);
        sub.setText(Texts.t("overlay.couldNotStart"));
        sub.setVisibility(View.VISIBLE);
        meterBlock.setVisibility(View.GONE);
        showBackLine(backTo == null ? "" : backTo);
        root.setVisibility(View.VISIBLE);
    }

    /** The instant the first frame arrives. */
    void hide() {
        stopAdvancing();
        root.setVisibility(View.GONE);
    }

    boolean isShowing() {
        return root.getVisibility() == View.VISIBLE;
    }

    private void describe(Target target) {
        LinearLayout.LayoutParams channelAt = (LinearLayout.LayoutParams) channel.getLayoutParams();
        channelAt.topMargin = kicker.getVisibility() == View.VISIBLE ? px(28) : 0;
        channel.setLayoutParams(channelAt);

        plate.setText(target.monogram);
        number.setText(target.number);
        number.setVisibility(target.number.isEmpty() ? View.GONE : View.VISIBLE);
        name.setText(target.name);
        LinearLayout.LayoutParams nameAt = (LinearLayout.LayoutParams) name.getLayoutParams();
        nameAt.leftMargin = target.number.isEmpty() ? 0 : px(18);
        name.setLayoutParams(nameAt);
    }

    private void showBackLine(String where) {
        backLine.setText(where.isEmpty() ? "" : Texts.t("overlay.backReturns", where));
        backLine.setVisibility(where.isEmpty() ? View.GONE : View.VISIBLE);
    }

    /**
     * Determinate-looking and always moving -- never a spinner, which reads as a
     * hang. It eases towards the end over about as long as a switch takes and
     * never quite arrives; the first frame hides it.
     */
    private void advance() {
        stopAdvancing();
        meter.fraction = 0f;
        advancing = ValueAnimator.ofFloat(0f, 0.95f);
        advancing.setDuration(6000L);
        advancing.setInterpolator(new DecelerateInterpolator(1.6f));
        advancing.addUpdateListener(animation -> {
            meter.fraction = (float) animation.getAnimatedValue();
            meter.invalidate();
        });
        advancing.start();
    }

    private void stopAdvancing() {
        if (advancing != null) {
            advancing.cancel();
            advancing = null;
        }
    }

    private TextView text(float designPx, int colour, int style) {
        TextView view = new TextView(context);
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, designPx * unit);
        view.setTextColor(colour);
        view.setTypeface(Typeface.create("sans-serif", style));
        view.setIncludeFontPadding(false);
        return view;
    }

    private LinearLayout.LayoutParams stacked(int gapDesignPx) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = px(gapDesignPx);
        return params;
    }

    private int px(float designPx) {
        return Math.round(designPx * unit);
    }

    /**
     * Pixels per design pixel. A television is drawn to the 1920-wide TV boards
     * whatever its real resolution; a phone to PL-P-1, which is the same panel
     * at half the size in dp.
     */
    static float unitFor(Activity activity) {
        UiModeManager modes = (UiModeManager) activity.getSystemService(Context.UI_MODE_SERVICE);
        boolean television = modes != null && modes.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        android.util.DisplayMetrics metrics = activity.getResources().getDisplayMetrics();
        if (television) {
            return Math.max(metrics.widthPixels, metrics.heightPixels) / 1920f;
        }
        return metrics.density * 0.5f;
    }

    /** The 8px bar: a track and a fill. */
    private final class Meter extends View {
        float fraction = 0f;
        int colour = PRIMARY_BRIGHT;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();

        Meter(Context context) {
            super(context);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float radius = getHeight() / 2f;
            box.set(0, 0, getWidth(), getHeight());
            paint.setColor(METER_TRACK);
            canvas.drawRoundRect(box, radius, radius, paint);

            canvas.save();
            canvas.clipRect(0, 0, getWidth() * fraction, getHeight());
            paint.setColor(colour);
            canvas.drawRoundRect(box, radius, radius, paint);
            canvas.restore();
        }
    }
}
