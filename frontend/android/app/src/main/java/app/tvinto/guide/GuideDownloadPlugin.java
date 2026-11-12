package app.tvinto.guide;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.UUID;

/**
 * Downloads a programme guide to a file, so the web app can read it a piece at
 * a time.
 *
 * The guide used to come through CapacitorHttp, which has no notion of a
 * stream: the whole body was read into memory on this side, turned into Base64
 * to cross the bridge, and decoded again in JavaScript -- the provider's guide
 * (some 300,000 programmes) existing four or five times over at the peak. An
 * emulator shrugs that off; a television box with a gigabyte of memory is
 * killed half way through, which on screen looks exactly like a guide that
 * never loads.
 *
 * So this writes the body to the app's cache as it arrives and hands it back
 * in chunks of a size the caller chooses. At no point does more than one chunk
 * exist in memory on either side. Everything after the bytes -- decompressing,
 * parsing, storing -- was already streamed, and is shared with the desktop.
 *
 * The body is kept as the server sent it. Asking for gzip explicitly stops
 * HttpURLConnection unpacking it on the way in, so the file is the compressed
 * size, and the shared code already recognises gzip by its first two bytes.
 *
 * Nothing here says where a guide came from in an error or a log. A provider's
 * guide address carries the subscription's username and password in its query
 * string, and Java's own exceptions are happy to repeat an address.
 */
@CapacitorPlugin(name = "GuideDownload")
public class GuideDownloadPlugin extends Plugin {

    /** Files are named for this, so leftovers from a killed load can be found. */
    private static final String PREFIX = "guide-download-";

    /** The most one read may ask for; the caller asks for less. */
    private static final int MAX_CHUNK = 4 * 1024 * 1024;

    @Override
    public void load() {
        // A load the system killed half way leaves its file behind, and a
        // compressed guide is tens of megabytes. Nothing can be reading one yet.
        File[] leftovers = getContext().getCacheDir().listFiles();
        if (leftovers != null) {
            for (File file : leftovers) {
                if (file.getName().startsWith(PREFIX)) {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                }
            }
        }
    }

    /**
     * Downloads to a file and resolves with a handle to it.
     *
     * The read timeout is per read, not for the whole download: a guide still
     * arriving is not stuck however long it takes, and one that has sent
     * nothing for the idle timeout is.
     */
    @PluginMethod
    public void download(PluginCall call) {
        String address = call.getString("url");
        // The JSON accessors rather than `call.getInt`, for the reason given in `read`.
        int connectTimeout = call.getData().optInt("connectTimeoutMs", 120_000);
        int idleTimeout = call.getData().optInt("idleTimeoutMs", 60_000);

        if (address == null || !(address.startsWith("http://") || address.startsWith("https://"))) {
            call.reject("A guide address must be http or https");
            return;
        }

        new Thread(() -> {
            String id = UUID.randomUUID().toString();
            File file = fileFor(id);
            HttpURLConnection connection = null;

            try {
                connection = (HttpURLConnection) new URL(address).openConnection();
                connection.setConnectTimeout(connectTimeout);
                connection.setReadTimeout(idleTimeout);
                connection.setInstanceFollowRedirects(true);
                connection.setRequestProperty("Accept", "application/xml, text/xml, */*");
                connection.setRequestProperty("Accept-Encoding", "gzip");

                int status = connection.getResponseCode();
                if (status >= 400) {
                    // Asked before the body: for a failed request
                    // getInputStream throws an exception naming the address.
                    call.reject("Guide server answered " + status);
                    return;
                }

                long total = 0;
                byte[] buffer = new byte[64 * 1024];
                try (InputStream in = connection.getInputStream();
                     FileOutputStream out = new FileOutputStream(file)) {
                    for (int read; (read = in.read(buffer)) != -1; ) {
                        out.write(buffer, 0, read);
                        total += read;
                    }
                }

                JSObject done = new JSObject();
                done.put("id", id);
                done.put("bytes", total);
                // Where it is, for a reader that takes the file straight through
                // the WebView's local file address rather than over the bridge
                // a chunk at a time (shared/xtream/libraryWorker.ts).
                done.put("path", file.getAbsolutePath());
                call.resolve(done);
            } catch (Exception failure) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                // The kind of failure, never its message: see the class comment.
                call.reject("Could not download the guide (" + failure.getClass().getSimpleName() + ")");
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }).start();
    }

    /** One chunk of a downloaded guide, as Base64, and whether it was the last. */
    @PluginMethod
    public void read(PluginCall call) {
        String id = call.getString("id");
        // Not `call.getLong`. That answers only for a value stored as a Long,
        // and a number from JavaScript arrives as an Integer whenever it fits
        // one -- so it returned the default, every read started at zero, and
        // the first half megabyte came back over and over until the
        // decompressor gave up on it. The JSON object's own accessors convert.
        long offset = call.getData().optLong("offset", 0L);
        int length = Math.max(1, Math.min(call.getData().optInt("length", 512 * 1024), MAX_CHUNK));

        if (!validId(id)) {
            call.reject("No such guide download");
            return;
        }

        try (RandomAccessFile file = new RandomAccessFile(fileFor(id), "r")) {
            long size = file.length();
            int count = (int) Math.max(0, Math.min(length, size - offset));
            byte[] chunk = new byte[count];

            if (count > 0) {
                file.seek(offset);
                file.readFully(chunk);
            }

            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(chunk, Base64.NO_WRAP));
            result.put("eof", offset + count >= size);
            call.resolve(result);
        } catch (Exception failure) {
            call.reject("Could not read the guide download (" + failure.getClass().getSimpleName() + ")");
        }
    }

    /** Deletes a downloaded guide. Safe to call for one already gone. */
    @PluginMethod
    public void discard(PluginCall call) {
        String id = call.getString("id");
        if (validId(id)) {
            //noinspection ResultOfMethodCallIgnored
            fileFor(id).delete();
        }
        call.resolve();
    }

    private File fileFor(String id) {
        return new File(getContext().getCacheDir(), PREFIX + id);
    }

    /** Only ids this plugin made: nothing may name a path of its own choosing. */
    private static boolean validId(String id) {
        return id != null && id.matches("[0-9a-f-]{36}");
    }
}
