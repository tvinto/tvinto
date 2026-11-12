package app.tvinto.storage;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.Iterator;

/**
 * The database's size and wasted space for the Account page, and "Free up
 * space" (DatabaseSpace). An idle clean is asked for each time the app goes to
 * the background, and called off each time it comes back.
 */
@CapacitorPlugin(name = "DatabaseSpace")
public class DatabaseSpacePlugin extends Plugin {

    @Override
    public void load() {
        new Thread(() -> DatabaseSpace.scheduleWhenIdle(getContext()), "database-space").start();
    }

    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        DatabaseSpace.cancelWhenIdle(getContext());
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        new Thread(() -> DatabaseSpace.scheduleWhenIdle(getContext()), "database-space").start();
    }

    /** Size, free space, and what the last clean did. */
    @PluginMethod
    public void measure(PluginCall call) {
        long[] space = DatabaseSpace.measure(getContext());
        JSObject result = new JSObject();
        result.put("bytes", space[0]);
        result.put("freeBytes", space[1]);
        JSONObject last = DatabaseSpace.status(getContext());
        JSObject copied = new JSObject();
        Iterator<String> keys = last.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            copied.put(key, last.opt(key));
        }
        result.put("last", copied);
        // A "running" left by a process that died part way is not running.
        result.put("cleaning", DatabaseSpace.cleaning());
        call.resolve(result);
    }

    /** Starts "Free up space"; `measure` says how it goes. */
    @PluginMethod
    public void clean(PluginCall call) {
        DatabaseSpace.cancelWhenIdle(getContext());
        new Thread(() -> DatabaseSpace.clean(getContext(), true), "database-clean").start();
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        DatabaseSpace.stop();
        call.resolve();
    }
}
