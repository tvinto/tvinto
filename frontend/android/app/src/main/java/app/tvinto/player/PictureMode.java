package app.tvinto.player;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * The shape the picture is drawn in: the film's own, filling the screen, or a
 * shape chosen. The rail's Picture group (FilmControls), in both players.
 *
 * Asked for because a file can carry the wrong shape: X-Men: First Class 4K
 * played squeezed on a user's TV, which the desktop's mpv could put right
 * and the television could not (21 October).
 *
 * Remembered per file, since the fault is the file's: a choice for one film
 * would squeeze every other. Kept under a hash of the address, never the
 * address, which carries the provider's password.
 */
final class PictureMode {

    static final String ORIGINAL = "original";
    static final String FILL = "fill";
    static final String STRETCH = "stretch";
    static final String WIDE = "16:9";
    static final String CINEMA = "2.35:1";
    static final String SQUARE = "4:3";

    static final String[] ALL = { ORIGINAL, FILL, STRETCH, WIDE, CINEMA, SQUARE };

    private static final String PREFERENCES = "picture_modes";

    private PictureMode() {}

    static String label(String mode) {
        switch (mode) {
            case FILL:
                return Texts.t("picture.fill");
            case STRETCH:
                return Texts.t("picture.stretch");
            case ORIGINAL:
                return Texts.t("picture.original");
            default:
                return mode;
        }
    }

    /** The width over height a mode forces, or 0 for one that keeps the film's own. */
    static float ratio(String mode) {
        switch (mode) {
            case WIDE:
                return 16f / 9f;
            case CINEMA:
                return 2.35f;
            case SQUARE:
                return 4f / 3f;
            default:
                return 0f;
        }
    }

    static String remembered(Context context, String url) {
        if (url == null) {
            return ORIGINAL;
        }
        String mode = preferences(context).getString(key(url), ORIGINAL);
        for (String known : ALL) {
            if (known.equals(mode)) {
                return mode;
            }
        }
        return ORIGINAL;
    }

    static void remember(Context context, String url, String mode) {
        if (url == null) {
            return;
        }
        SharedPreferences.Editor editor = preferences(context).edit();
        if (ORIGINAL.equals(mode)) {
            editor.remove(key(url));
        } else {
            editor.putString(key(url), mode);
        }
        editor.apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static String key(String url) {
        return Integer.toHexString(url.hashCode()) + "-" + url.length();
    }
}
