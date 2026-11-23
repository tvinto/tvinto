package app.tvinto.device;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.io.File;
import java.io.IOException;

import io.sentry.Hint;
import io.sentry.Sentry;
import io.sentry.SentryEnvelope;
import io.sentry.SentryEnvelopeItem;
import io.sentry.SentryItemType;
import io.sentry.SentryOptions;
import io.sentry.android.core.AnrV2Integration;
import io.sentry.android.core.cache.AndroidEnvelopeCache;
import io.sentry.android.core.SentryAndroid;
import io.sentry.hints.DiskFlushNotification;
import io.sentry.hints.Retryable;
import io.sentry.hints.SubmissionResult;
import io.sentry.transport.ITransport;
import io.sentry.transport.RateLimiter;
import io.sentry.util.HintUtils;

/**
 * The Android app's own crashes as error reports (docs/error-reports.md):
 * Java exceptions, native crashes in the players and the plugins, and the app
 * not responding.
 *
 * Sentry's Android SDK catches them; nothing it catches leaves from here. Its
 * transport writes each event to the device (KeptReports) and the page takes
 * them, cleans them with the same step as its own reports and sends them --
 * or deletes them, if the switch is off. So a crash before the page has said
 * anything waits on the device until the next start, and goes only if the
 * switch is on then.
 *
 * What the SDK may collect is cut down to errors: no breadcrumbs, sessions,
 * screenshots, view hierarchies, tombstones or thread dumps, and a native
 * crash's minidump is dropped (KeepOnDevice), since a dump is memory nothing
 * can clean.
 */
public final class ErrorReports {

    private static final String TAG = "ErrorReports";
    private static final String PREFS = "tvinto_error_reports";
    private static final String SWITCH = "switch";

    /**
     * Sentry starts only with an address. Nothing is ever sent to it: the
     * transport below keeps every event on the device.
     */
    private static final String NOWHERE = "https://kept@localhost/0";

    private static volatile boolean started = false;
    private static volatile KeptReports kept = null;
    private static volatile Runnable onKept = null;

    private ErrorReports() {}

    /** At every start of the app's process, before anything can crash. Off since the page said so: nothing. */
    public static void onLaunch(Context context) {
        if ("off".equals(prefs(context).getString(SWITCH, null))) {
            reports(context).clear();
            return;
        }
        start(context);
    }

    /** The page's switch: on keeps catching, off stops it and deletes what is kept, this launch and the next. */
    static synchronized void set(Context context, boolean on) {
        prefs(context).edit().putString(SWITCH, on ? "on" : "off").apply();
        if (on) {
            start(context);
            return;
        }
        if (started) {
            Sentry.close();
            started = false;
        }
        reports(context).clear();
    }

    static KeptReports reports(Context context) {
        if (kept == null) {
            kept = new KeptReports(new File(context.getApplicationContext().getFilesDir(), "error-reports"));
        }
        return kept;
    }

    /** Told when a report was kept while the app runs, so the page can take it now. */
    static void onKept(@Nullable Runnable listener) {
        onKept = listener;
    }

    private static synchronized void start(Context context) {
        if (started) {
            return;
        }
        Context app = context.getApplicationContext();
        KeptReports store = reports(app);
        boolean debuggable = (app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        try {
            SentryAndroid.init(app, options -> {
                options.setDsn(NOWHERE);
                options.setTransportFactory((o, request) -> new KeepOnDevice(store, o));
                options.setRelease("tvinto-android@" + versionName(app));
                options.setEnvironment("android");
                options.setSendDefaultPii(false);
                options.setSendClientReports(false);
                options.setEnableAutoSessionTracking(false);
                options.setMaxBreadcrumbs(0);
                options.setEnableActivityLifecycleBreadcrumbs(false);
                options.setEnableAppComponentBreadcrumbs(false);
                options.setEnableSystemEventBreadcrumbs(false);
                options.setEnableNetworkEventBreadcrumbs(false);
                options.setEnableUserInteractionBreadcrumbs(false);
                options.setEnableFramesTracking(false);
                options.setEnableScopeSync(false);
                options.setAttachScreenshot(false);
                options.setAttachViewHierarchy(false);
                options.setAttachAnrThreadDump(false);
                options.setTombstoneEnabled(false);
                options.setCollectAdditionalContext(false);
                options.setEnableRootCheck(false);
                // Only the last time the app stopped answering, not every one Android remembers.
                options.setReportHistoricalAnrs(false);
                // A debug build is how this is tested (docs/error-reports.md).
                options.setAnrReportInDebug(debuggable);
            });
            started = true;
        } catch (Throwable error) {
            // Reports are never worth the app not starting.
            Log.w(TAG, "Error reports could not start: " + error.getClass().getSimpleName());
        }
    }

    private static String versionName(Context context) {
        try {
            String name = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            return name == null ? "unknown" : name;
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Sentry's transport, which keeps the event of each envelope on the
     * device and drops everything else in it -- a minidump, an attachment, a
     * session. Answers Sentry's hints as a sent envelope would, so a crash
     * does not wait to flush and nothing is tried again.
     */
    static final class KeepOnDevice implements ITransport {
        private final KeptReports store;
        private final SentryOptions options;

        KeepOnDevice(KeptReports store, SentryOptions options) {
            this.store = store;
            this.options = options;
        }

        @Override
        public void send(@NonNull SentryEnvelope envelope, @NonNull Hint hint) {
            boolean keptOne = false;
            for (SentryEnvelopeItem item : envelope.getItems()) {
                if (item.getHeader().getType() != SentryItemType.Event) {
                    continue;
                }
                try {
                    store.keep(item.getData());
                    keptOne = true;
                } catch (Exception e) {
                    Log.w(TAG, "An error report could not be kept: " + e.getClass().getSimpleName());
                }
            }
            HintUtils.runIfHasType(hint, DiskFlushNotification.class, DiskFlushNotification::markFlushed);
            // Sentry's own cache marks an ANR as reported; skipping that cache, the
            // same ANR came again at every start until there was a newer one.
            HintUtils.runIfHasType(hint, AnrV2Integration.AnrV2Hint.class, anr -> AndroidEnvelopeCache.markAnrReported(options, anr.timestamp()));
            HintUtils.runIfHasType(hint, Retryable.class, retryable -> retryable.setRetry(false));
            HintUtils.runIfHasType(hint, SubmissionResult.class, result -> result.setResult(true));
            Runnable listener = onKept;
            if (keptOne && listener != null) {
                listener.run();
            }
        }

        @Override
        public void flush(long timeoutMillis) {}

        @Override
        public @Nullable RateLimiter getRateLimiter() {
            return null;
        }

        @Override
        public void close(boolean isRestarting) throws IOException {}

        @Override
        public void close() throws IOException {}
    }
}
