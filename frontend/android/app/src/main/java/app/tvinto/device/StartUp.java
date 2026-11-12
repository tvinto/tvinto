package app.tvinto.device;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import app.tvinto.MainActivity;

/**
 * Opening the app when the television is turned on, as TiviMate offers
 * (25 October).
 *
 * Kept on the device, not on the account: whether it may happen is this
 * device's own permission. Android 10 and later let an app open itself from
 * the background only with "Display over other apps" granted by the person
 * (developer.android.com, "Restrictions on starting activities from the
 * background"), so without it nothing opens and nothing fails loudly.
 *
 * Two moments count as turning on: the device starting (StartUpReceiver), and
 * the screen coming back on from standby, which is how most televisions are
 * turned on and which Android announces only to an app already running
 * (StartUpPlugin). The app opens on `tvinto://start`, and the web app decides
 * what that shows: For You, or the last channel (DeepLinksService).
 */
public final class StartUp {

    private static final String FILE = "start-up";
    private static final String ENABLED = "openWhenTurnedOn";

    private StartUp() {}

    static boolean enabled(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(ENABLED, false);
    }

    static void setEnabled(Context context, boolean on) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean(ENABLED, on).apply();
    }

    /** "Display over other apps", which an app opening itself from the background needs. */
    static boolean allowed(Context context) {
        return Settings.canDrawOverlays(context);
    }

    /** Android's page for granting it to this app, or null where the device has none. */
    static Intent askIntent(Context context) {
        Intent ask = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + context.getPackageName()))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return ask.resolveActivity(context.getPackageManager()) != null ? ask : null;
    }

    /** Opens the app, if it was asked to and may. */
    static void open(Context context) {
        if (!enabled(context) || !allowed(context)) {
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("tvinto://start"), context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            context.startActivity(intent);
        } catch (Exception refused) {
            // Refused by the device: the television simply opens as it always did.
        }
    }
}
