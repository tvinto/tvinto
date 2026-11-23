package app.tvinto.device;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Error reports the app wrote about itself, kept in a folder of its own until
 * the page takes them (ErrorReportsPlugin). Sentry's event JSON, one file
 * each, nothing else: no minidump, no screenshot, no memory.
 *
 * Plain files rather than Sentry's own cache, because Sentry's cache is
 * something it sends from by itself, and nothing here may leave the device
 * except through the page's cleaning.
 */
public final class KeptReports {

    /** The most kept at once; the oldest go first. A crash every launch is still one problem. */
    static final int MOST = 20;

    private final File folder;
    private long written = 0;

    public KeptReports(File folder) {
        this.folder = folder;
    }

    /** Written whole and then renamed, so a crash half way through leaves no half a report. */
    public synchronized void keep(byte[] eventJson) throws IOException {
        if (!folder.isDirectory() && !folder.mkdirs()) {
            throw new IOException("No folder for error reports");
        }
        String name = String.format(java.util.Locale.ROOT, "%013d-%04d", System.currentTimeMillis(), written++ % 10000);
        File part = new File(folder, name + ".part");
        try (FileOutputStream out = new FileOutputStream(part)) {
            out.write(eventJson);
            out.getFD().sync();
        }
        if (!part.renameTo(new File(folder, name + ".json"))) {
            part.delete();
            throw new IOException("Could not keep an error report");
        }
        File[] kept = sorted();
        for (int i = 0; i < kept.length - MOST; i++) {
            kept[i].delete();
        }
    }

    /** Every kept report, oldest first, and none kept after. */
    public synchronized List<String> take() {
        List<String> events = new ArrayList<>();
        for (File file : sorted()) {
            try {
                events.add(read(file));
            } catch (IOException ignored) {
                // Unreadable: dropped with the rest.
            }
            file.delete();
        }
        return events;
    }

    /** The switch went off: nothing kept, half-written ones included. */
    public synchronized void clear() {
        File[] all = folder.listFiles();
        if (all != null) {
            for (File file : all) {
                file.delete();
            }
        }
    }

    // Not Files.readAllBytes: that needs Android 8, and the app runs from 7.
    private static String read(File file) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            for (int n; (n = in.read(buffer)) > 0; ) {
                bytes.write(buffer, 0, n);
            }
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }

    private File[] sorted() {
        File[] kept = folder.listFiles((dir, name) -> name.endsWith(".json"));
        if (kept == null) {
            return new File[0];
        }
        Arrays.sort(kept, (a, b) -> a.getName().compareTo(b.getName()));
        return kept;
    }
}
