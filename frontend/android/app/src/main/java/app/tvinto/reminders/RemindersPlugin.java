package app.tvinto.reminders;

import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Reminders that go off with the app closed or the player in front.
 * The web app keeps the reminders; this
 * holds a copy for the alarms, and says which ones went off here.
 */
@CapacitorPlugin(
    name = "Reminders",
    permissions = @Permission(strings = { "android.permission.POST_NOTIFICATIONS" }, alias = RemindersPlugin.NOTIFICATIONS)
)
public class RemindersPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";

    /** The whole list, replacing the last one: { reminders, texts }. */
    @PluginMethod
    public void schedule(PluginCall call) {
        JSONArray list = call.getArray("reminders", new JSArray());
        JSONObject texts = call.getObject("texts", new JSObject());
        ReminderStore.save(getContext(), list, texts);
        ReminderAlarms.reschedule(getContext());

        // Asked once there is something to be told about, and not on a
        // television, where the app stays open and its player shows the banner.
        if (list.length() > 0 && needsPermission() && !isTelevision()) {
            requestPermissionForAlias(NOTIFICATIONS, call, "afterPermission");
            return;
        }
        call.resolve();
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        call.resolve();
    }

    /** The keys of reminders already said here -- in the player, or as a notification. */
    @PluginMethod
    public void fired(PluginCall call) {
        JSArray keys = new JSArray();
        for (String key : ReminderStore.firedKeys(getContext())) {
            keys.put(key);
        }
        JSObject result = new JSObject();
        result.put("keys", keys);
        call.resolve(result);
    }

    private boolean needsPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED;
    }

    private boolean isTelevision() {
        return getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
    }
}
