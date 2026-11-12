package app.tvinto.recording;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Where recordings are kept and what is known about them: a `.ts` and a
 * `.json` describing it for each, in the app's own folder on a drive.
 *
 * A drive is any storage Android has mounted -- the device's own, a USB
 * drive, a memory card. Every app has a folder of its own on each
 * (getExternalFilesDirs), which it may write without asking for any
 * permission and which the player and RecordingTail read as plain files.
 * The person chooses one for new recordings (`choose`); recordings already
 * made stay where they are and are listed from every drive mounted. A chosen
 * drive that is unplugged is passed over for the device's own until it is
 * back. What is on a drive goes with the app if it is uninstalled.
 *
 * Nothing here holds a stream's address.
 */
final class Recordings {

    private static final String FILE = "recording_storage";
    private static final String CHOSEN = "chosen";

    private Recordings() {}

    /** The recordings folder on every drive mounted now, the device's own first. */
    static List<File> roots(Context context) {
        List<File> found = new ArrayList<>();
        for (File root : context.getExternalFilesDirs("Recordings")) {
            if (root != null && Environment.MEDIA_MOUNTED.equals(Environment.getExternalStorageState(root))) {
                //noinspection ResultOfMethodCallIgnored
                root.mkdirs();
                if (root.isDirectory() && root.canWrite()) {
                    found.add(root);
                }
            }
        }
        if (found.isEmpty()) {
            File inside = new File(context.getFilesDir(), "Recordings");
            //noinspection ResultOfMethodCallIgnored
            inside.mkdirs();
            found.add(inside);
        }
        return found;
    }

    /** Where a new recording goes: the drive chosen, while it is mounted; else the device's own. */
    static File dir(Context context) {
        List<File> roots = roots(context);
        String chosen = prefs(context).getString(CHOSEN, null);
        for (File root : roots) {
            if (root.getAbsolutePath().equals(chosen)) {
                return root;
            }
        }
        return roots.get(0);
    }

    /** A recording's file by name, on whichever drive holds it; null when none does. */
    @Nullable
    static File find(Context context, String name) {
        for (File root : roots(context)) {
            File candidate = new File(root, name);
            if (candidate.exists()) {
                return candidate;
            }
        }
        return null;
    }

    /** The drives that can be recorded to, with their names and space, for the person to choose from. */
    static JSONArray volumes(Context context) {
        JSONArray found = new JSONArray();
        String chosen = dir(context).getAbsolutePath();
        StorageManager storage = (StorageManager) context.getSystemService(Context.STORAGE_SERVICE);
        for (File root : roots(context)) {
            try {
                JSONObject one = new JSONObject();
                one.put("id", root.getAbsolutePath());
                String label = null;
                boolean removable = false;
                if (storage != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    StorageVolume volume = storage.getStorageVolume(root);
                    if (volume != null) {
                        label = volume.getDescription(context);
                        removable = volume.isRemovable();
                    }
                }
                one.put("label", label == null ? "" : label);
                one.put("removable", removable);
                one.put("freeBytes", root.getUsableSpace());
                one.put("totalBytes", root.getTotalSpace());
                one.put("chosen", root.getAbsolutePath().equals(chosen));
                found.put(one);
            } catch (JSONException ignored) {
                // Left out.
            }
        }
        return found;
    }

    /** Chooses the drive new recordings go to, by the id `volumes` gave. False for one not mounted. */
    static boolean choose(Context context, String id) {
        for (File root : roots(context)) {
            if (root.getAbsolutePath().equals(id)) {
                prefs(context).edit().putString(CHOSEN, id).apply();
                return true;
            }
        }
        return false;
    }

    /** Every recording on every drive mounted, with its file's address for the player and its size now. */
    static JSONArray read(Context context) {
        JSONArray found = new JSONArray();
        for (File root : roots(context)) {
            File[] files = root.listFiles((parent, name) -> name.endsWith(".json"));
            if (files == null) {
                continue;
            }
            for (File about : files) {
                try {
                    JSONObject one = new JSONObject(text(about));
                    File video = new File(about.getParentFile(), one.optString("id") + ".ts");
                    one.put("path", "file://" + video.getAbsolutePath());
                    one.put("bytes", video.length());
                    if ("recording".equals(one.optString("state")) && !RecordingService.isRecording(one.optString("id"))) {
                        // Left as recording by an app that was stopped: it ends where the file ends.
                        one.put("state", video.length() > 0 ? "done" : "failed");
                    }
                    found.put(one);
                } catch (IOException | JSONException unreadable) {
                    // A description half written: the next look will find it whole.
                }
            }
        }
        return found;
    }

    /** Deletes a finished recording and its description, from whichever drive holds them. False while it is still recording. */
    static boolean remove(Context context, String id) {
        if (RecordingService.isRecording(id) || !id.matches("[A-Za-z0-9_-]{1,64}")) {
            return false;
        }
        boolean gone = true;
        for (File root : roots(context)) {
            for (String name : new String[] {id + ".ts", id + ".json"}) {
                File file = new File(root, name);
                if (file.exists() && !file.delete()) {
                    gone = false;
                }
            }
        }
        return gone;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    private static String text(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) Math.min(file.length(), 64 * 1024)];
            int read = 0;
            while (read < bytes.length) {
                int got = in.read(bytes, read, bytes.length - read);
                if (got < 0) {
                    break;
                }
                read += got;
            }
            return new String(bytes, 0, read, StandardCharsets.UTF_8);
        }
    }
}
