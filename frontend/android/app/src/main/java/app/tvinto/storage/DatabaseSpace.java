package app.tvinto.storage;

import android.app.UiModeManager;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.res.Configuration;
import android.database.Cursor;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
import android.util.Log;

import net.zetetic.database.sqlcipher.SQLiteDatabase;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * The device database's wasted space, and the clean that gives it back.
 *
 * SQLite keeps the pages of deleted rows inside the file, and the guide and
 * catalogue are deleted and written again all day, so the file only grows:
 * 1.2 GB on a user's television where TiviMate kept 300 MB (19 October).
 * VACUUM rewrites it at the size of what it holds -- and holds every other
 * query to the file while it does. Run through the SQLite plugin, on the one
 * thread the plugin runs everything on, that froze the television for minutes
 * (web 1.0.108). So it runs here, on a connection and a thread of its own: by
 * itself while the device is idle -- a television in standby, a phone asleep
 * and charging (CompactJobService) -- and stopped the moment it is not; or
 * when "Free up space" is pressed, behind a busy screen.
 *
 * Only the first clean on a device is a whole VACUUM, which cannot be stopped
 * quickly; it also turns on SQLite's incremental mode, and every clean after
 * it gives pages back a megabyte at a time, stoppable between any two.
 *
 * Opened with SQLCipher, the plugin's own SQLite, never Android's: two copies
 * of SQLite in one process do not see each other's locks, which is a
 * documented way to corrupt a database. And in the app's own process, not one
 * of its own -- tried first, 20 October: Android froze that process 10 s after
 * its job was called off, part way through the rollback, holding the file's
 * lock, and every query of the app waited on it. The app's own process is
 * never frozen while the app is in use.
 *
 * Stopping is always safe. VACUUM is all or nothing: interrupted, SQLite rolls
 * it back, and if the process dies first the rollback happens at the next open.
 */
public final class DatabaseSpace {

    /** Where @capacitor-community/sqlite keeps the database named "xtream-catalogue". */
    static final String FILE = "xtream-catalogueSQLite.db";

    /** Below this, a rewrite is not worth what it costs. */
    static final long WORTH_CLEANING = 50L * 1024 * 1024;

    static final int WHEN_IDLE = 7301;

    /** SQLite's auto_vacuum = INCREMENTAL. */
    private static final long INCREMENTAL = 2;

    /** A megabyte, at the plugin's 4 KB pages. */
    private static final int STEP_PAGES = 256;

    /** Between steps, for the app's own queries to go first. */
    private static final long STEP_PAUSE_MS = 20;

    private static final String STATUS = "database-clean.json";
    private static final String TAG = "DatabaseClean";

    /** The clean in progress, to stop; null when none is. */
    private static CancellationSignal running;

    private DatabaseSpace() {}

    static File database(Context context) {
        return context.getDatabasePath(FILE);
    }

    /**
     * The file's size and how much of it is free pages, read from the header
     * (page size at byte 16, free page count at byte 36) rather than through
     * SQLite, so measuring takes no lock. The size counts the write-ahead log
     * beside it (device-database.service.ts), which holds pages not yet folded
     * back into the file; the header read is the file's own, a little behind
     * until they are.
     */
    static long[] measure(Context context) {
        File file = database(context);
        if (!file.exists()) {
            return new long[] { 0, 0 };
        }
        long log = new File(file.getPath() + "-wal").length();
        try (RandomAccessFile reading = new RandomAccessFile(file, "r")) {
            byte[] header = new byte[100];
            reading.readFully(header);
            if (!new String(header, 0, 15, StandardCharsets.US_ASCII).equals("SQLite format 3")) {
                return new long[] { file.length() + log, 0 };
            }
            int pageSize = ((header[16] & 0xff) << 8) | (header[17] & 0xff);
            if (pageSize == 1) {
                pageSize = 65536;
            }
            long freePages = ((long) (header[36] & 0xff) << 24) | ((header[37] & 0xff) << 16)
                | ((header[38] & 0xff) << 8) | (header[39] & 0xff);
            return new long[] { file.length() + log, freePages * pageSize };
        } catch (IOException unreadable) {
            return new long[] { file.length() + log, 0 };
        }
    }

    /**
     * Asks Android to clean the next time the device is idle, if there is
     * enough to give back. A television has no battery to charge, so only a
     * phone waits for the charger as well.
     */
    static void scheduleWhenIdle(Context context) {
        if (measure(context)[1] < WORTH_CLEANING) {
            return;
        }
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        if (jobs == null || jobs.getPendingJob(WHEN_IDLE) != null) {
            return;
        }
        JobInfo.Builder job = new JobInfo.Builder(WHEN_IDLE, new ComponentName(context, CompactJobService.class))
            .setRequiresDeviceIdle(true);
        if (!television(context)) {
            job.setRequiresCharging(true);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            job.setRequiresStorageNotLow(true);
        }
        jobs.schedule(job.build());
    }

    /** Somebody is using the app: an idle clean in progress stops, and none waits. */
    static void cancelWhenIdle(Context context) {
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        if (jobs != null) {
            jobs.cancel(WHEN_IDLE);
        }
    }

    static synchronized boolean cleaning() {
        return running != null;
    }

    /** Stops the clean in progress, if there is one; it rolls back. */
    static synchronized void stop() {
        if (running != null) {
            running.cancel();
        }
    }

    /**
     * Rewrites the database without its free pages, on the calling thread,
     * and records how it went (`status`). One at a time: a second call while
     * one runs returns at once. `asked` is "Free up space"; otherwise it is
     * the idle job, which does nothing when there is too little to give back.
     */
    static void clean(Context context, boolean asked) {
        long[] before = measure(context);
        if (!asked && before[1] < WORTH_CLEANING) {
            return;
        }
        CancellationSignal signal = new CancellationSignal();
        synchronized (DatabaseSpace.class) {
            if (running != null) {
                return;
            }
            running = signal;
        }

        long startedAt = System.currentTimeMillis();
        JSONObject status = new JSONObject();
        put(status, "state", "running");
        put(status, "asked", asked);
        put(status, "startedAt", startedAt);
        put(status, "beforeBytes", before[0]);
        writeStatus(context, status);

        String state;
        String reason = null;
        SQLiteDatabase database = null;
        try {
            System.loadLibrary("sqlcipher");
            // No key: the plugin opens it as "no-encryption", which is plain SQLite.
            database = SQLiteDatabase.openDatabase(database(context).getPath(), "", null, SQLiteDatabase.OPEN_READWRITE, null, null);
            // The app may be part way through a write; wait for it rather than give up.
            number(database, "PRAGMA busy_timeout = 30000");
            // Read something first: until a connection has read the file,
            // auto_vacuum answers SQLite's default rather than the file's.
            number(database, "SELECT count(*) FROM sqlite_master");

            if (number(database, "PRAGMA auto_vacuum") != INCREMENTAL) {
                // Once per device: one whole rewrite, which also switches the
                // file to giving pages back a few at a time. It cannot be
                // stopped part way -- SQLite checks for an interrupt while it
                // copies, not while it writes the copy back, which is most of
                // it (20 October: Cancel waited over a minute on the
                // emulator). The app shows the busy screen until it is over.
                put(status, "mode", "full");
                writeStatus(context, status);
                database.execSQL("PRAGMA auto_vacuum = INCREMENTAL");
                database.execSQL("VACUUM");
            } else {
                // From then on, a megabyte at a time: each step a short write
                // of its own, the app's queries going on between them, and a
                // stop taking effect at the next step.
                put(status, "mode", "steps");
                writeStatus(context, status);
                while (number(database, "PRAGMA freelist_count") > 0) {
                    if (signal.isCanceled()) {
                        throw new OperationCanceledException();
                    }
                    number(database, "PRAGMA incremental_vacuum(" + STEP_PAGES + ")");
                    Thread.sleep(STEP_PAUSE_MS);
                }
            }
            // In WAL mode what a clean gave back is in the log until it is
            // folded into the file, and the file shrinks only then: folded
            // in now, and the log emptied, so the space is free when it says so.
            number(database, "PRAGMA wal_checkpoint(TRUNCATE)");
            state = "done";
        } catch (OperationCanceledException stopped) {
            state = "stopped";
        } catch (Throwable other) {
            state = "failed";
            String said = String.valueOf(other.getMessage()).toLowerCase();
            reason = said.contains("locked") || said.contains("busy") ? "busy"
                : said.contains("full") || said.contains("disk") ? "full"
                : other.getClass().getSimpleName();
        } finally {
            if (database != null) {
                try {
                    database.close();
                } catch (Exception ignored) {
                    // Closing is all that is left to do with it.
                }
            }
            synchronized (DatabaseSpace.class) {
                running = null;
            }
        }

        long[] after = measure(context);
        long finishedAt = System.currentTimeMillis();
        put(status, "state", state);
        put(status, "finishedAt", finishedAt);
        put(status, "afterBytes", after[0]);
        if (reason != null) {
            put(status, "reason", reason);
        }
        writeStatus(context, status);
        Log.i(TAG, state + (reason == null ? "" : " (" + reason + ")") + ": "
            + before[0] / 1_000_000 + " MB to " + after[0] / 1_000_000 + " MB in "
            + (finishedAt - startedAt) / 1000 + " s" + (asked ? ", asked for" : ", while idle"));
    }

    static boolean television(Context context) {
        UiModeManager modes = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
        return modes != null && modes.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    /** What the last clean did, as it wrote it; empty if none has run. */
    static JSONObject status(Context context) {
        try {
            File file = new File(context.getFilesDir(), STATUS);
            if (!file.exists()) {
                return new JSONObject();
            }
            return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        } catch (Exception unreadable) {
            return new JSONObject();
        }
    }

    /** Written whole and renamed into place, so a reader never sees half of it. */
    static void writeStatus(Context context, JSONObject status) {
        File file = new File(context.getFilesDir(), STATUS);
        File writing = new File(context.getFilesDir(), STATUS + ".new");
        try (FileOutputStream out = new FileOutputStream(writing)) {
            out.write(status.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (IOException failed) {
            return;
        }
        if (!writing.renameTo(file)) {
            writing.delete();
        }
    }

    /** Runs a statement through a cursor, so it runs whole, and gives its first number back (0 if none). */
    private static long number(SQLiteDatabase database, String sql) {
        try (Cursor cursor = database.rawQuery(sql, (String[]) null)) {
            return cursor.getCount() > 0 && cursor.moveToFirst() && cursor.getColumnCount() > 0 ? cursor.getLong(0) : 0;
        }
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (Exception ignored) {
            // Keys are fixed strings; nothing here can fail.
        }
    }
}
