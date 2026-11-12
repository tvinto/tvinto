package app.tvinto.device;

import android.app.Activity;
import android.app.Application;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opening the app when the television is turned on (StartUp): the setting,
 * whether Android allows it, and asking for that.
 *
 * Also where the screen coming back on is heard. Android tells only apps
 * already running, and only receivers registered while they run, so this one
 * lives as long as the app's process. Most televisions are turned on from
 * standby rather than started; when Android has closed the app meanwhile,
 * the television opens as it always did.
 */
@CapacitorPlugin(name = "StartUp")
public class StartUpPlugin extends Plugin {

    /** How long after the screen comes on to see whether the app came back by itself. */
    private static final long SETTLE_MS = 1500;

    private BroadcastReceiver screenOn;

    /** How many of the app's screens are in front: the main one, or a player. Counted from here,
     * which is before the main one's first resume. */
    private int inFront = 0;

    private final Application.ActivityLifecycleCallbacks counting = new Application.ActivityLifecycleCallbacks() {
        @Override public void onActivityResumed(Activity activity) { inFront++; }
        @Override public void onActivityPaused(Activity activity) { inFront = Math.max(0, inFront - 1); }
        @Override public void onActivityCreated(Activity activity, Bundle state) {}
        @Override public void onActivityStarted(Activity activity) {}
        @Override public void onActivityStopped(Activity activity) {}
        @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) {}
        @Override public void onActivityDestroyed(Activity activity) {}
    };

    @Override
    public void load() {
        ((Application) getContext().getApplicationContext()).registerActivityLifecycleCallbacks(counting);
        screenOn = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                // Android may put the app back in front itself, as the last
                // one used -- the guide, or a player that was playing; opened
                // again on top of that it would start over.
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    if (inFront == 0) {
                        StartUp.open(getContext().getApplicationContext());
                    }
                }, SETTLE_MS);
            }
        };
        getContext().getApplicationContext().registerReceiver(screenOn, new IntentFilter(Intent.ACTION_SCREEN_ON));
    }

    @Override
    protected void handleOnDestroy() {
        ((Application) getContext().getApplicationContext()).unregisterActivityLifecycleCallbacks(counting);
        try {
            getContext().getApplicationContext().unregisterReceiver(screenOn);
        } catch (IllegalArgumentException alreadyGone) {
            // Nothing to take back.
        }
        super.handleOnDestroy();
    }

    /** `enabled`: asked for on this device; `allowed`: Android lets it happen; `canAsk`: the device has the page to allow it. */
    @PluginMethod
    public void state(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", StartUp.enabled(getContext()));
        result.put("allowed", StartUp.allowed(getContext()));
        result.put("canAsk", StartUp.askIntent(getContext()) != null);
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        StartUp.setEnabled(getContext(), Boolean.TRUE.equals(call.getBoolean("enabled", false)));
        state(call);
    }

    /** Opens Android's page for "Display over other apps" for this app. `opened`: whether there was one. */
    @PluginMethod
    public void ask(PluginCall call) {
        Intent ask = StartUp.askIntent(getContext());
        JSObject result = new JSObject();
        if (ask == null) {
            result.put("opened", false);
            call.resolve(result);
            return;
        }
        try {
            getActivity().startActivity(ask);
            result.put("opened", true);
        } catch (Exception refused) {
            result.put("opened", false);
        }
        call.resolve(result);
    }
}
