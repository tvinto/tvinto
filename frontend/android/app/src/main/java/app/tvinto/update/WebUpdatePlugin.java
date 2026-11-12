package app.tvinto.update;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web app's way of replacing itself.
 *
 * Four methods, and the decisions are not among them: what counts as a newer
 * bundle, which APK a bundle needs and whether one has already failed are all
 * worked out in TypeScript, where they can be tested. This carries out the
 * parts that need Android -- the network, the archive, the file system and the
 * preference Capacitor reads as it starts.
 *
 * The reasoning, and the rollback that makes it survivable, is in
 * `WebBundles`.
 */
@CapacitorPlugin(name = "WebUpdate")
public class WebUpdatePlugin extends Plugin {

    /**
     * What is running, what is waiting, and what this phone is willing to run.
     *
     * "Running" is asked of the bridge's own server -- the folder it is serving
     * this launch -- and not of the preference naming the folder to serve. That
     * preference is for the next launch, and a bundle downloaded a few seconds
     * after starting writes it at once; reading it here reported the new bundle
     * as running while the old one was, and made a device look as though it
     * had ignored being reset.
     */
    @PluginMethod
    public void state(PluginCall call) {
        JSObject state = new JSObject();
        String served = getBridge().getServerBasePath();
        String running = WebBundles.versionServedFrom(getContext(), served);

        state.put("version", running != null ? running : WebBundles.appVersion(getContext()));
        state.put("app", WebBundles.appVersion(getContext()));
        state.put("downloaded", running != null);

        String pending = WebBundles.pendingVersion(getContext(), served);
        if (pending == null) {
            state.put("pending", JSObject.NULL);
        } else {
            state.put("pending", pending);
        }

        String refused = WebBundles.refusedVersion(getContext());
        if (refused == null) {
            state.put("refused", JSObject.NULL);
        } else {
            state.put("refused", refused);
        }

        call.resolve(state);
    }

    /**
     * Fetch, check and unpack a bundle, for use from the next launch.
     *
     * On a thread of its own: this is tens of megabytes over a phone's network,
     * and a Capacitor method runs where it is called from. `call.resolve` is
     * safe from any thread.
     */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String version = call.getString("version");
        String sha256 = call.getString("sha256");

        new Thread(() -> {
            try {
                WebBundles.install(getContext(), url, version, sha256);

                JSObject done = new JSObject();
                done.put("version", version);
                call.resolve(done);
            } catch (Exception failure) {
                // The message is for a log. Every caller of this treats a
                // failure as "not today" and asks again later.
                call.reject(failure.getMessage(), failure);
            }
        }).start();
    }

    /**
     * The bundle in use saying that it started.
     *
     * The whole of the rollback. Something that white-screens never reaches
     * the code that calls this.
     */
    @PluginMethod
    public void confirm(PluginCall call) {
        WebBundles.confirm(getContext());
        call.resolve();
    }

    /** Back to the bundle inside the APK. An escape hatch, for a person. */
    @PluginMethod
    public void forget(PluginCall call) {
        WebBundles.forget(getContext());
        call.resolve();
    }

    /**
     * Start the web app again, on the bundle the next launch would serve.
     *
     * A launch without the launch: the same bookkeeping `MainActivity` does
     * before the bridge exists -- counting the start, clearing out bundles
     * nothing will serve, rolling back one that never confirmed -- and then
     * the WebView pointed at whatever that leaves and reloaded. So a
     * downloaded update takes effect on the spot, and a stuck app can be
     * started again, on a television where closing and reopening one means
     * digging through the system settings (22 September).
     *
     * Not a new process. Killing this one and scheduling another was the other
     * way, and Android 14 is increasingly unwilling to start an activity for a
     * process that has just ended. The native players and plugins survive a
     * reload; everything in JavaScript starts afresh, which is what matters.
     */
    @PluginMethod
    public void restart(PluginCall call) {
        WebBundles.onLaunch(getContext());
        String path = WebBundles.nextServingPath(getContext());
        call.resolve();

        getActivity().runOnUiThread(() -> {
            if (path != null) {
                getBridge().setServerBasePath(path);
            } else {
                getBridge().setServerAssetPath("public");
            }
        });
    }
}
