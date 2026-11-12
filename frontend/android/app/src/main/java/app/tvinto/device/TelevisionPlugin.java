package app.tvinto.device;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Whether this device is a television, asked of the platform.
 *
 * The web app used to find out by waiting for the first press of a D-pad key,
 * because every signal a web page can read is a guess -- the TV emulator
 * reports seven touchscreens. So a television opened on the desktop layout
 * with nothing focused, and the first press landed on the logo. Android itself
 * does know: the UI mode is television, or the device declares the leanback
 * feature that Android TV requires. Both are asked; either is enough.
 */
@CapacitorPlugin(name = "Television")
public class TelevisionPlugin extends Plugin {

    @PluginMethod
    public void isTelevision(PluginCall call) {
        Context context = getContext();

        UiModeManager uiMode = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
        boolean televisionMode =
            uiMode != null && uiMode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;

        PackageManager packages = context.getPackageManager();
        boolean leanback = packages.hasSystemFeature(PackageManager.FEATURE_LEANBACK);

        JSObject result = new JSObject();
        result.put("television", televisionMode || leanback);
        call.resolve(result);
    }
}
