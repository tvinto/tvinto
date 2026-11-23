package app.tvinto.device;

import android.content.pm.ApplicationInfo;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The page's side of ErrorReports: the switch, and the kept reports handed
 * over for cleaning and sending (services/native/nativeErrorReports.ts).
 */
@CapacitorPlugin(name = "ErrorReports")
public class ErrorReportsPlugin extends Plugin {

    @Override
    public void load() {
        ErrorReports.onKept(() -> notifyListeners("kept", new JSObject()));
    }

    @Override
    protected void handleOnDestroy() {
        ErrorReports.onKept(null);
    }

    @PluginMethod
    public void set(PluginCall call) {
        ErrorReports.set(getContext(), call.getData().optBoolean("on", false));
        call.resolve();
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSArray events = new JSArray();
        for (String event : ErrorReports.reports(getContext()).take()) {
            events.put(event);
        }
        JSObject result = new JSObject();
        result.put("events", events);
        call.resolve(result);
    }

    /**
     * A debug build only: a Java crash, or the app not answering for twenty
     * seconds, on the main thread, to see a report come through.
     */
    @PluginMethod
    public void rehearse(PluginCall call) {
        if ((getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            call.reject("Only in a debug build");
            return;
        }
        String what = call.getString("what", "");
        call.resolve();
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if ("anr".equals(what)) {
                SystemClock.sleep(20_000);
            } else if ("crash".equals(what)) {
                throw new IllegalStateException("Rehearsed crash (debug build)");
            }
        }, 500);
    }
}
