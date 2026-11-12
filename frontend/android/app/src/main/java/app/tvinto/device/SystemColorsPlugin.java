package app.tvinto.device;

import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The status bar and navigation bar in the page's own colour, with icons that
 * read on it.
 *
 * They were light grey above and below a dark app on the phone.
 * Capacitor keeps the page out from under the bars
 * -- on Android 15 it pads the WebView's parent by their height -- so what shows
 * there is whatever is behind the WebView, and that was the theme's light
 * window. The app has a light theme too, so the colour comes from the page
 * (ThemeService) each time the theme changes, rather than being fixed here.
 */
@CapacitorPlugin(name = "SystemColors")
public class SystemColorsPlugin extends Plugin {

    /** `background`: "#rrggbb"; `dark`: whether that colour is dark, for light icons. */
    @PluginMethod
    public void set(PluginCall call) {
        int background;
        try {
            background = Color.parseColor(call.getString("background", ""));
        } catch (IllegalArgumentException notAColour) {
            call.reject("Not a colour");
            return;
        }
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", true));

        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            window.getDecorView().setBackgroundColor(background);
            View parent = (View) getBridge().getWebView().getParent();
            if (parent != null) {
                parent.setBackgroundColor(background);
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                // Before Android 15 the bars have colours of their own.
                window.setStatusBarColor(background);
                window.setNavigationBarColor(background);
            }
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
            bars.setAppearanceLightStatusBars(!dark);
            bars.setAppearanceLightNavigationBars(!dark);
            call.resolve();
        });
    }
}
