package app.tvinto.update;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Downloading a newer app and handing it to Android's installer.
 *
 * A web bundle updates itself (WebUpdatePlugin); an APK cannot, and should not
 * try to: installing one is the person's decision, and Android asks them. What
 * this does is the part that was clumsy by hand -- a television has no browser
 * to download with -- so the app fetches the file itself, checks it is the
 * one that was published, and opens the installer on it.
 *
 * One download at a time, into the app's cache, where Android can clear it.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    /** How often progress is told to the page, at most. */
    private static final long PROGRESS_EVERY_MS = 250L;

    private volatile boolean downloading = false;

    /**
     * Throws away downloads that are installed or older. Each was 176 MB and
     * none was ever deleted: on the TV emulator on 19 October two of them
     * were most of the app's data, and a phone that took many updates kept
     * one for each.
     */
    @Override
    public void load() {
        String installed = installedVersion();
        File[] held = updatesDir().listFiles();
        if (held == null || installed == null) {
            return;
        }
        for (File file : held) {
            String version = versionOf(file);
            if (version == null || compareVersions(version, installed) <= 0) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
    }

    /**
     * Fetch the APK at `url` and check its sha256. Resolves when it is on the
     * device and matches; emits `progress` { received, total } on the way.
     */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String sha256 = call.getString("sha256", "");
        String version = call.getString("version", "update");
        // Fail closed: an update with no hash to check would be installed on
        // whatever arrived.
        if (sha256 == null || !sha256.matches("[0-9a-fA-F]{64}")) {
            call.reject("A sha256 is required");
            return;
        }
        if (url == null || !url.startsWith("https://")) {
            call.reject("An https url is required");
            return;
        }
        if (downloading) {
            call.reject("Already downloading");
            return;
        }
        downloading = true;
        // One download kept at a time: any other is a version no longer offered.
        File keep = apkFile(version);
        File[] others = updatesDir().listFiles();
        if (others != null) {
            for (File file : others) {
                if (!file.getName().equals(keep.getName())) {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                }
            }
        }

        new Thread(() -> {
            File target = apkFile(version);
            File partial = new File(target.getPath() + ".part");
            HttpURLConnection connection = null;
            try {
                target.getParentFile().mkdirs();
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(30_000);
                if (connection.getResponseCode() != 200) {
                    throw new IllegalStateException("The server answered " + connection.getResponseCode());
                }
                long total = connection.getContentLengthLong();
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long received = 0;
                long toldAt = 0;
                try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(partial)) {
                    byte[] buffer = new byte[64 * 1024];
                    for (int read; (read = in.read(buffer)) != -1; ) {
                        out.write(buffer, 0, read);
                        digest.update(buffer, 0, read);
                        received += read;
                        long now = System.currentTimeMillis();
                        if (now - toldAt >= PROGRESS_EVERY_MS) {
                            toldAt = now;
                            JSObject progress = new JSObject();
                            progress.put("received", received);
                            progress.put("total", total);
                            notifyListeners("progress", progress);
                        }
                    }
                }

                String actual = hex(digest.digest());
                if (!sha256.equalsIgnoreCase(actual)) {
                    partial.delete();
                    throw new IllegalStateException("The download did not match the published file");
                }
                if (target.exists()) {
                    target.delete();
                }
                if (!partial.renameTo(target)) {
                    throw new IllegalStateException("Could not keep the download");
                }

                JSObject done = new JSObject();
                done.put("version", version);
                done.put("size", received);
                call.resolve(done);
            } catch (Exception failure) {
                partial.delete();
                call.reject(failure.getMessage() == null ? "Download failed" : failure.getMessage());
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
                downloading = false;
            }
        }).start();
    }

    /**
     * Open Android's installer on a downloaded version.
     *
     * Android lets an app offer an install only once the person has allowed it
     * to, in settings. When that has not happened this opens that setting and
     * resolves { needsPermission: true }; pressing Install again afterwards
     * carries on.
     */
    @PluginMethod
    public void install(PluginCall call) {
        File apk = apkFile(call.getString("version", "update"));
        if (!apk.exists()) {
            call.reject("Nothing downloaded to install");
            return;
        }

        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(allow);
            result.put("needsPermission", true);
            call.resolve(result);
            return;
        }

        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(uri, "application/vnd.android.package-archive");
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(install);
        result.put("needsPermission", false);
        call.resolve(result);
    }

    /** Whether a version has already been downloaded, so the page can offer Install straight away. */
    @PluginMethod
    public void downloaded(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ready", apkFile(call.getString("version", "update")).exists());
        call.resolve(result);
    }

    private File apkFile(String version) {
        // Only digits and dots reach a file name.
        String safe = version.replaceAll("[^0-9.]", "");
        return new File(updatesDir(), "xtream-" + (safe.isEmpty() ? "update" : safe) + ".apk");
    }

    private File updatesDir() {
        return new File(getContext().getCacheDir(), "app-updates");
    }

    /** "1.0.54" from "xtream-1.0.54.apk"; null for anything else. */
    static String versionOf(File file) {
        String name = file.getName();
        if (!name.startsWith("xtream-") || !name.endsWith(".apk")) {
            return null;
        }
        String version = name.substring("xtream-".length(), name.length() - ".apk".length());
        return version.matches("[0-9]+(\\.[0-9]+)*") ? version : null;
    }

    /** Negative, zero or positive as a is older, the same as, or newer than b, part by part. */
    static int compareVersions(String a, String b) {
        String[] left = a.split("\\.");
        String[] right = b.split("\\.");
        for (int i = 0; i < Math.max(left.length, right.length); i++) {
            long one = i < left.length ? parse(left[i]) : 0;
            long two = i < right.length ? parse(right[i]) : 0;
            if (one != two) {
                return Long.compare(one, two);
            }
        }
        return 0;
    }

    private static long parse(String part) {
        try {
            return Long.parseLong(part);
        } catch (NumberFormatException notANumber) {
            return 0;
        }
    }

    private String installedVersion() {
        try {
            return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
        } catch (Exception unknown) {
            return null;
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(String.format("%02x", b));
        }
        return out.toString();
    }
}
