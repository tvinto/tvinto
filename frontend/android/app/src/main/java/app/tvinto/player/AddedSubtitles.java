package app.tvinto.player;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Subtitles the account added from OpenSubtitles, as files a player can open.
 *
 * The page cannot write a file, and neither player takes text -- Media3 wants a
 * URI for a side-loaded track and VLC wants a slave. So the plugin writes each
 * one into the app's cache under its sync-service id and passes the paths on
 * the Intent. Same id, same file: playing a film twice writes it once, and
 * Android may clear the cache whenever it likes, since the text is on the
 * account and comes back with it.
 */
public final class AddedSubtitles {

    /** A JSON array of { path, language, label }, as written by `write`. */
    public static final String EXTRA = "addedSubtitles";

    /** Two is a menu; ten would be a library nobody chose. */
    private static final int MOST = 4;

    /** Comfortably more than a long film, and a stop on anything absurd. */
    private static final int MAX_CHARS = 600_000;

    private AddedSubtitles() {}

    /** One subtitle, already on disk. */
    public static final class Added {
        public final File file;
        public final String language;
        public final String label;

        Added(File file, String language, String label) {
            this.file = file;
            this.language = language;
            this.label = label;
        }

        public Uri uri() {
            return Uri.fromFile(file);
        }
    }

    /**
     * Writes what the page sent and returns what to put on the Intent.
     *
     * Anything unusable is skipped rather than refused: a film with one
     * unwritable subtitle should still play with the others, and with its own.
     */
    public static String write(Context context, JSArray subtitles) {
        if (subtitles == null) {
            return "";
        }

        JSONArray out = new JSONArray();
        File folder = new File(context.getCacheDir(), "subtitles");

        for (int index = 0; index < subtitles.length() && out.length() < MOST; index++) {
            JSObject entry = optObject(subtitles, index);
            if (entry == null) {
                continue;
            }

            String id = entry.getString("id", "");
            String text = entry.getString("text", "");
            // Only ids the sync service made reach a file name.
            if (!id.matches("[A-Za-z0-9-]{8,64}") || text.isEmpty() || text.length() > MAX_CHARS) {
                continue;
            }

            try {
                folder.mkdirs();
                File file = new File(folder, id + ".vtt");
                try (OutputStreamWriter writer =
                         new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
                    writer.write(text);
                }

                JSONObject saved = new JSONObject();
                saved.put("path", file.getAbsolutePath());
                saved.put("language", entry.getString("language", ""));
                saved.put("label", entry.getString("label", ""));
                out.put(saved);
            } catch (Exception ignored) {
                // Skipped; the film plays without this one.
            }
        }

        return out.length() == 0 ? "" : out.toString();
    }

    /** What an Activity was given, or an empty list. */
    public static List<Added> from(Intent intent) {
        List<Added> added = new ArrayList<>();
        String raw = intent == null ? null : intent.getStringExtra(EXTRA);
        if (raw == null || raw.isEmpty()) {
            return added;
        }

        try {
            JSONArray array = new JSONArray(raw);
            for (int index = 0; index < array.length(); index++) {
                JSONObject entry = array.optJSONObject(index);
                if (entry == null) {
                    continue;
                }
                File file = new File(entry.optString("path", ""));
                if (!file.isFile()) {
                    continue;
                }
                added.add(new Added(file, entry.optString("language", ""), entry.optString("label", "")));
            }
        } catch (Exception ignored) {
            // Nothing added; the stream's own tracks are unaffected.
        }

        return added;
    }

    private static JSObject optObject(JSArray subtitles, int index) {
        try {
            Object entry = subtitles.get(index);
            return entry instanceof JSONObject ? JSObject.fromJSONObject((JSONObject) entry) : null;
        } catch (Exception ignored) {
            return null;
        }
    }
}
