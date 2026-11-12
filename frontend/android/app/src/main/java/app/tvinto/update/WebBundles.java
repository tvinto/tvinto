package app.tvinto.update;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.util.Log;

import com.getcapacitor.plugin.WebView;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * The web bundle this app runs, and how it comes to be replaced.
 *
 * Almost every change to this app is a change to files the WebView loads, and
 * Capacitor can be told to load them from the phone's own storage instead of
 * from the APK. So a fix reaches a phone without anybody plugging it in, and
 * the APK is sideloaded once rather than every time.
 *
 * Capacitor already does the serving: it reads `serverBasePath` out of its own
 * preferences as it starts and hosts that directory, and it clears the setting
 * by itself when the APK's version changes -- which is what makes a freshly
 * installed APK win over a bundle downloaded earlier. What Capacitor has no
 * opinion about is whether the bundle works. That is what this adds.
 *
 * ## The rollback, which is the whole safety of it
 *
 * A downloaded bundle that fails to start leaves a white screen, and a white
 * screen cannot ask for a different bundle. Without an answer to that, one bad
 * release means every phone has to be plugged in again -- which is the thing
 * this exists to stop.
 *
 * So each launch counts as an attempt, and the web app clears the count once
 * it is up (`confirm`). A bundle that never gets that far runs out of attempts,
 * is deleted, and is remembered as refused so it is not fetched again.
 *
 * ## What is trusted
 *
 * The bundle is the app's own code, and whoever can publish one can make this
 * app do anything on a device that holds the provider password. It is the same
 * server that already holds the account, so nothing new is being trusted -- but
 * the checks that can be made cheaply are made: HTTPS only, a SHA-256 agreed
 * in advance, and an archive that may not write outside the directory meant
 * for it.
 */
public final class WebBundles {

    private static final String TAG = "WebBundles";

    /** Our own preferences. Capacitor's are separate and are not ours to crowd. */
    private static final String PREFS = "TvintoWebUpdate";

    private static final String ACTIVE = "activeVersion";
    private static final String ATTEMPTS = "startsWithoutConfirming";
    private static final String REFUSED = "refusedVersion";

    /**
     * How many launches a bundle gets to say it started.
     *
     * Three rather than one, because an app can be closed within a few seconds
     * for reasons that have nothing to do with it working -- a wrong tap, a
     * phone call. Three launches that all end before the app is up is not that.
     */
    private static final int ALLOWED_STARTS = 3;

    /** Anything larger is not this app. The whole bundle is a few megabytes. */
    private static final long MOST_BYTES = 64L * 1024 * 1024;

    private static final String BUNDLES = "web-bundles";

    private WebBundles() {}

    /**
     * Called before Capacitor builds its bridge, which is when it reads the
     * path it will serve.
     *
     * Deliberately does not set that path. Capacitor's own logic already
     * decides whether to honour it, and it clears the setting when the APK
     * changes -- so writing it here would resurrect an old bundle over a newly
     * installed APK, which is the one thing a sideload must not have to fight.
     */
    public static void onLaunch(Context context) {
        try {
            SharedPreferences ours = ours(context);
            String serving = servingPath(context);

            // Before anything is served, so nothing can be reading these.
            forgetBundlesExcept(context, serving);

            if (serving == null) {
                // The APK's own bundle: either nothing was ever installed, or a
                // new APK cleared it. Either way there is nothing to police,
                // and the count belongs to a bundle that is no longer in use.
                ours.edit().remove(ACTIVE).putInt(ATTEMPTS, 0).apply();
                return;
            }

            int attempts = ours.getInt(ATTEMPTS, 0) + 1;

            if (attempts > ALLOWED_STARTS) {
                String failed = ours.getString(ACTIVE, null);
                Log.w(TAG, "Bundle " + failed + " never said it started. Going back to the built-in one.");
                rollBack(context, failed);
                return;
            }

            ours.edit().putInt(ATTEMPTS, attempts).apply();
        } catch (Exception failure) {
            // Nothing here is worth taking the app down for. The worst case is
            // that a rollback does not happen, and the app still starts.
            Log.e(TAG, "Could not check the web bundle", failure);
        }
    }

    /** The web app saying it is up, which is what stops the rollback. */
    public static void confirm(Context context) {
        ours(context).edit().putInt(ATTEMPTS, 0).apply();
    }

    /** Back to the bundle inside the APK, and willing to try a new one again. */
    public static void forget(Context context) {
        serve(context, "");
        ours(context).edit().remove(ACTIVE).remove(REFUSED).putInt(ATTEMPTS, 0).apply();
        // The files themselves go at the next launch (`onLaunch`): this is called
        // from inside the app, which may be running from them right now.
    }

    /**
     * The version of a downloaded bundle the server is serving from `served`,
     * or null when it is serving the APK's own.
     *
     * Bundles are unpacked into a folder named for their version, so the folder
     * being served says which one it is -- without trusting a preference that
     * may already describe the next launch.
     */
    public static String versionServedFrom(Context context, String served) {
        if (served == null || served.isEmpty()) {
            return null;
        }
        try {
            File folder = new File(served).getCanonicalFile();
            File root = new File(context.getFilesDir(), BUNDLES).getCanonicalFile();
            return root.equals(folder.getParentFile()) ? folder.getName() : null;
        } catch (IOException unreadable) {
            return null;
        }
    }

    /** A downloaded bundle set to be served from the next launch, if it is not this one. */
    public static String pendingVersion(Context context, String served) {
        String next = servingPath(context);
        String active = ours(context).getString(ACTIVE, null);

        if (next == null || active == null) {
            return null;
        }
        try {
            boolean same = served != null
                && !served.isEmpty()
                && new File(next).getCanonicalFile().equals(new File(served).getCanonicalFile());
            return same ? null : active;
        } catch (IOException unreadable) {
            return null;
        }
    }

    /** The folder the next start will serve, or null for the APK's own bundle. */
    public static String nextServingPath(Context context) {
        return servingPath(context);
    }

    public static String refusedVersion(Context context) {
        return ours(context).getString(REFUSED, null);
    }

    /** The APK's own version name, which is what says how new the native half is. */
    public static String appVersion(Context context) {
        try {
            String name = context
                .getPackageManager()
                .getPackageInfo(context.getPackageName(), 0)
                .versionName;
            return name == null ? "0" : name;
        } catch (PackageManager.NameNotFoundException impossible) {
            // The package this code is running from is not installed.
            return "0";
        }
    }

    /**
     * Fetch a bundle, check it, unpack it, and use it from the next launch.
     *
     * Not from this one. Swapping the files under a running app means a reload
     * in the middle of whatever somebody was doing, and half of this app's
     * state is in memory.
     *
     * Throws with a message meant to be read in a log, not shown to anybody:
     * every caller of this treats a failure as "not today".
     */
    public static void install(Context context, String url, String version, String expectedSha256)
        throws IOException {
        if (url == null || !url.startsWith("https://")) {
            throw new IOException("A bundle may only come over https");
        }
        // Checked here as well as in the page: the version names folders this
        // deletes and unpacks into, and "../.." would name the app's own.
        if (version == null || !version.matches("[0-9]+(\\.[0-9]+)*")) {
            throw new IOException("A bundle must say which version it is");
        }
        if (expectedSha256 == null || expectedSha256.length() != 64) {
            throw new IOException("A bundle must come with a sha256");
        }

        File archive = new File(context.getCacheDir(), "web-bundle-" + version + ".zip");
        deleteTree(archive);

        String got = download(url, archive);

        if (!got.equalsIgnoreCase(expectedSha256)) {
            // Refused before a single byte of it is unpacked. This is the one
            // check that stands between "the download was interfered with" and
            // "the app is now running whatever arrived".
            deleteTree(archive);
            throw new IOException("The bundle did not match its sha256");
        }

        File target = bundleDir(context, version);
        deleteTree(target);

        try {
            unpack(archive, target);

            if (!new File(target, "index.html").isFile()) {
                throw new IOException("The bundle has no index.html, so it is not one");
            }
        } catch (IOException failure) {
            deleteTree(target);
            throw failure;
        } finally {
            deleteTree(archive);
        }

        serve(context, target.getAbsolutePath());
        ours(context).edit().putString(ACTIVE, version).remove(REFUSED).putInt(ATTEMPTS, 0).apply();

        // Nothing is deleted here. The bundle this launch is serving is still
        // in use -- a screen or a chunk not yet loaded is read from it later --
        // and deleting it with the rest, as this used to, left the running app
        // answering 404 for its own files until it was restarted. `onLaunch`
        // clears out everything but the bundle about to be served, which is the
        // first moment nothing is using the others.
    }

    // ---- the parts the above is made of ----

    private static SharedPreferences ours(Context context) {
        return context.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    private static SharedPreferences capacitors(Context context) {
        return context.getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE);
    }

    /** The directory Capacitor will serve, or null when that is the APK's own. */
    private static String servingPath(Context context) {
        String path = capacitors(context).getString(WebView.CAP_SERVER_PATH, null);

        if (path == null || path.isEmpty() || !new File(path).exists()) {
            return null;
        }
        return path;
    }

    private static void serve(Context context, String path) {
        capacitors(context).edit().putString(WebView.CAP_SERVER_PATH, path).apply();
    }

    private static void rollBack(Context context, String failed) {
        serve(context, "");

        SharedPreferences.Editor editor = ours(context).edit().remove(ACTIVE).putInt(ATTEMPTS, 0);

        // Remembered by name, so the same broken bundle is not fetched again on
        // the next launch and every launch after. Nothing is remembered when
        // the name has been lost, because "" is not a version and would refuse
        // nothing while looking as though it refused something.
        if (failed != null) {
            editor.putString(REFUSED, failed);
        }

        editor.apply();

        if (failed != null) {
            deleteTree(bundleDir(context, failed));
        }
    }

    private static File bundleDir(Context context, String version) {
        return new File(new File(context.getFilesDir(), BUNDLES), version);
    }

    /** Deletes every unpacked bundle but the one at `keepPath`, which may be null for none. */
    private static void forgetBundlesExcept(Context context, String keepPath) {
        File root = new File(context.getFilesDir(), BUNDLES);
        File[] kept = root.listFiles();

        if (kept == null) {
            return;
        }

        for (File bundle : kept) {
            try {
                boolean keep = keepPath != null
                    && bundle.getCanonicalFile().equals(new File(keepPath).getCanonicalFile());
                if (!keep) {
                    deleteTree(bundle);
                }
            } catch (IOException unreadable) {
                // Left for the next launch rather than risking the one in use.
            }
        }
    }

    /** Downloads to a file, returning the SHA-256 of what actually arrived. */
    private static String download(String from, File to) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(from).openConnection();
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(60000);
        connection.setInstanceFollowRedirects(true);

        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new IOException("The server answered " + status);
            }

            MessageDigest digest;
            try {
                digest = MessageDigest.getInstance("SHA-256");
            } catch (Exception impossible) {
                throw new IOException("This device has no SHA-256", impossible);
            }

            long written = 0;

            try (
                DigestInputStream in = new DigestInputStream(connection.getInputStream(), digest);
                OutputStream out = new FileOutputStream(to)
            ) {
                byte[] buffer = new byte[64 * 1024];
                int read;

                while ((read = in.read(buffer)) != -1) {
                    written += read;
                    if (written > MOST_BYTES) {
                        // Whatever is at the other end, it is not this app.
                        throw new IOException("The bundle is far larger than a bundle");
                    }
                    out.write(buffer, 0, read);
                }
            }

            return hex(digest.digest());
        } finally {
            connection.disconnect();
        }
    }

    /**
     * Unpacks, refusing any entry that would land outside the target.
     *
     * A zip carries the names of its own files, so an entry called
     * `../../shared_prefs/something` writes wherever it likes unless somebody
     * checks -- and this archive comes over the network.
     */
    private static void unpack(File archive, File target) throws IOException {
        if (!target.mkdirs() && !target.isDirectory()) {
            throw new IOException("Could not make room for the bundle");
        }

        String inside = target.getCanonicalPath() + File.separator;

        try (ZipInputStream zip = new ZipInputStream(new FileInputStream(archive))) {
            ZipEntry entry;

            while ((entry = zip.getNextEntry()) != null) {
                File out = new File(target, entry.getName());

                if (!out.getCanonicalPath().startsWith(inside)) {
                    throw new IOException("The bundle tried to write outside itself");
                }

                if (entry.isDirectory()) {
                    if (!out.mkdirs() && !out.isDirectory()) {
                        throw new IOException("Could not make " + entry.getName());
                    }
                    continue;
                }

                File parent = out.getParentFile();
                if (parent != null && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new IOException("Could not make room for " + entry.getName());
                }

                try (OutputStream file = new FileOutputStream(out)) {
                    copy(zip, file);
                }
            }
        }
    }

    private static void copy(InputStream from, OutputStream to) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int read;

        while ((read = from.read(buffer)) != -1) {
            to.write(buffer, 0, read);
        }
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) {
            return;
        }

        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteTree(child);
            }
        }

        // Not checked: a file that will not go is a file that will be written
        // over. There is nothing better to do about it here.
        file.delete();
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);

        for (byte b : bytes) {
            text.append(Character.forDigit((b >> 4) & 0xf, 16));
            text.append(Character.forDigit(b & 0xf, 16));
        }

        return text.toString();
    }
}
