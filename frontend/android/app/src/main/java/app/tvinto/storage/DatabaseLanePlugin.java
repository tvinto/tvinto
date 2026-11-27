package app.tvinto.storage;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.community.database.sqlite.CapacitorSQLitePlugin;

import android.database.Cursor;
import android.os.SystemClock;
import android.util.Log;

import net.zetetic.database.sqlcipher.SQLiteDatabase;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The SQLite plugin, on a thread of its own.
 *
 * Capacitor runs every plugin call of the app on one thread, one after the
 * other, and the SQLite plugin does its work on it: a read of every live
 * channel held that thread for 22 s, and the channel preview's show and hide,
 * the full player's start, reminders and the update check all waited behind
 * it. On a user's television OK on a previewed channel did nothing, the
 * channel opened later by itself, and the preview stayed over the next page
 * until its hide came round (23 October). Here each call goes to a lane of
 * its own, still one at a time and in the order asked, and returns at once.
 *
 * Registered under the plugin's own name after Capacitor's list
 * (MainActivity), so it replaces the plugin rather than sitting beside it.
 */
@CapacitorPlugin(name = "CapacitorSQLite")
public class DatabaseLanePlugin extends CapacitorSQLitePlugin {

    private static final String TAG = "DatabaseLane";

    private final ExecutorService lane = Executors.newSingleThreadExecutor(work -> new Thread(work, "database"));

    /** The app's database (device-database.service.ts), as the plugin names its file. */
    private static final String FILE = "xtream-catalogueSQLite.db";

    /**
     * A log this long, 16 MB, is folded in and started over (`untilFolded`):
     * the size it is cut back to afterwards (device-database.service.ts).
     */
    private static final int RESTART_FRAMES = 4096;

    /** How long a "foldDue" the app has not answered waits before it is said again. */
    private static final long ASK_AGAIN_MS = 10_000;

    /**
     * Folding the log into the file, on a connection and a thread of its own,
     * while the app holds its writes.
     *
     * SQLite folds it in at the end of whichever write filled it, so that write
     * held the lane: on the TV emulator every write over 38 ms of a first load
     * was one that folded (103 of 1,118, 24 to 126 ms against a median of 10),
     * and on a user's TV 37 to 42 writes held it 1 to 3 s (26 November).
     * Folded beside the writes instead, a write made while a fold synced waited
     * for the sync, 0.5 to 2 s on that TV whatever the fold's size (27
     * November). So the app's writes wait while the fold runs; its reads go on.
     */
    private final ExecutorService folding = Executors.newSingleThreadExecutor(work -> new Thread(work, "database-fold"));
    /** When "foldDue" was last said and not yet answered by a fold; 0 when it was. */
    private final AtomicLong askedAt = new AtomicLong();
    /** Held by a fold, and by whatever closes or deletes the file, so neither happens during the other. */
    private final Object foldLock = new Object();

    private void onLane(Runnable work) {
        lane.execute(() -> {
            work.run();
            foldIfDue();
        });
    }

    /**
     * Run on the lane after each call: tells the app when the log is
     * RESTART_FRAMES long, and again if nothing answered (a page reloading
     * loses what it was told).
     */
    private void foldIfDue() {
        if (log()[0] < RESTART_FRAMES) {
            askedAt.set(0);
            return;
        }
        long now = SystemClock.elapsedRealtime();
        long asked = askedAt.get();
        if ((asked == 0 || now - asked > ASK_AGAIN_MS) && askedAt.compareAndSet(asked, now)) {
            notifyListeners("foldDue", new JSObject());
        }
    }

    /**
     * Folds the whole log in and answers when it is: asked by the app
     * (device-database.service.ts) when told "foldDue", with its writes held
     * meanwhile, so the next write starts the log over -- it starts over only
     * at a write that finds every page of it folded in.
     */
    @PluginMethod
    public void untilFolded(PluginCall call) {
        folding.execute(() -> {
            try {
                // A few tries: a write that was not held (a `run`) can add pages meanwhile.
                for (int tries = 0; tries < 3; tries++) {
                    synchronized (foldLock) {
                        fold();
                    }
                    int[] log = log();
                    if (log[0] == log[1]) {
                        break;
                    }
                }
            } finally {
                // Told again after the next write if the log is still long.
                askedAt.set(0);
                call.resolve();
            }
        });
    }

    /** The folds' own connection, kept open between them (opening it was most of a short fold's time). */
    private SQLiteDatabase folder;

    /** Under foldLock. */
    private void fold() {
        try {
            if (folder == null) {
                File file = getContext().getDatabasePath(FILE);
                if (!file.exists()) {
                    return;
                }
                // Opened as WAL: opened plainly, SQLCipher sets its default
                // journal mode, which takes the file out of WAL if no other
                // connection has it open.
                folder = SQLiteDatabase.openDatabase(file.getPath(), "", null,
                    SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING, null, null);
            }
            try (Cursor result = folder.rawQuery("PRAGMA wal_checkpoint(PASSIVE)", null)) {
                result.moveToFirst();
            }
        } catch (Exception failure) {
            // The next write past the point asks again, on a connection opened anew.
            Log.w(TAG, "fold: " + failure.getClass().getSimpleName());
            closeFolder();
        }
    }

    /** Under foldLock. */
    private void closeFolder() {
        if (folder != null) {
            try {
                folder.close();
            } catch (Exception ignored) {
                // Closed already, or the file gone: either way not ours to keep.
            }
            folder = null;
        }
    }

    /**
     * The log's length in pages and how many of them are folded in, from its
     * index beside it (sqlite.org/walformat.html: mxFrame at byte 16,
     * nBackfill at byte 96, in the device's byte order), read without taking
     * any lock. Zeros when there is no log.
     */
    private int[] log() {
        File index = new File(getContext().getDatabasePath(FILE).getPath() + "-shm");
        try (RandomAccessFile shm = new RandomAccessFile(index, "r")) {
            if (shm.length() < 100) {
                return new int[] { 0, 0 };
            }
            byte[] head = new byte[100];
            shm.readFully(head);
            ByteBuffer read = ByteBuffer.wrap(head).order(ByteOrder.nativeOrder());
            return new int[] { read.getInt(16), read.getInt(96) };
        } catch (IOException missing) {
            return new int[] { 0, 0 };
        }
    }

    /** A call that closes or deletes the file, once no fold is under way and the folds' connection is closed. */
    private void afterFolding(Runnable work) {
        onLane(() -> {
            synchronized (foldLock) {
                closeFolder();
                work.run();
            }
        });
    }

    @Override
    @PluginMethod
    public void echo(PluginCall call) {
        onLane(() -> super.echo(call));
    }

    @Override
    @PluginMethod
    public void isSecretStored(PluginCall call) {
        onLane(() -> super.isSecretStored(call));
    }

    @Override
    @PluginMethod
    public void setEncryptionSecret(PluginCall call) {
        onLane(() -> super.setEncryptionSecret(call));
    }

    @Override
    @PluginMethod
    public void changeEncryptionSecret(PluginCall call) {
        onLane(() -> super.changeEncryptionSecret(call));
    }

    @Override
    @PluginMethod
    public void clearEncryptionSecret(PluginCall call) {
        onLane(() -> super.clearEncryptionSecret(call));
    }

    @Override
    @PluginMethod
    public void checkEncryptionSecret(PluginCall call) {
        onLane(() -> super.checkEncryptionSecret(call));
    }

    @Override
    @PluginMethod
    public void getNCDatabasePath(PluginCall call) {
        onLane(() -> super.getNCDatabasePath(call));
    }

    @Override
    @PluginMethod
    public void createNCConnection(PluginCall call) {
        onLane(() -> super.createNCConnection(call));
    }

    @Override
    @PluginMethod
    public void createConnection(PluginCall call) {
        onLane(() -> super.createConnection(call));
    }

    @Override
    @PluginMethod
    public void open(PluginCall call) {
        onLane(() -> super.open(call));
    }

    @Override
    @PluginMethod
    public void close(PluginCall call) {
        afterFolding(() -> super.close(call));
    }

    @Override
    @PluginMethod
    public void beginTransaction(PluginCall call) {
        onLane(() -> super.beginTransaction(call));
    }

    @Override
    @PluginMethod
    public void commitTransaction(PluginCall call) {
        onLane(() -> super.commitTransaction(call));
    }

    @Override
    @PluginMethod
    public void rollbackTransaction(PluginCall call) {
        onLane(() -> super.rollbackTransaction(call));
    }

    @Override
    @PluginMethod
    public void isTransactionActive(PluginCall call) {
        onLane(() -> super.isTransactionActive(call));
    }

    @Override
    @PluginMethod
    public void getUrl(PluginCall call) {
        onLane(() -> super.getUrl(call));
    }

    @Override
    @PluginMethod
    public void getVersion(PluginCall call) {
        onLane(() -> super.getVersion(call));
    }

    @Override
    @PluginMethod
    public void closeNCConnection(PluginCall call) {
        afterFolding(() -> super.closeNCConnection(call));
    }

    @Override
    @PluginMethod
    public void closeConnection(PluginCall call) {
        afterFolding(() -> super.closeConnection(call));
    }

    @Override
    @PluginMethod
    public void checkConnectionsConsistency(PluginCall call) {
        onLane(() -> super.checkConnectionsConsistency(call));
    }

    @Override
    @PluginMethod
    public void isDatabase(PluginCall call) {
        onLane(() -> super.isDatabase(call));
    }

    @Override
    @PluginMethod
    public void isDatabaseEncrypted(PluginCall call) {
        onLane(() -> super.isDatabaseEncrypted(call));
    }

    @Override
    @PluginMethod
    public void isInConfigEncryption(PluginCall call) {
        onLane(() -> super.isInConfigEncryption(call));
    }

    @Override
    @PluginMethod
    public void isInConfigBiometricAuth(PluginCall call) {
        onLane(() -> super.isInConfigBiometricAuth(call));
    }

    @Override
    @PluginMethod
    public void isNCDatabase(PluginCall call) {
        onLane(() -> super.isNCDatabase(call));
    }

    @Override
    @PluginMethod
    public void isTableExists(PluginCall call) {
        onLane(() -> super.isTableExists(call));
    }

    @Override
    @PluginMethod
    public void getDatabaseList(PluginCall call) {
        onLane(() -> super.getDatabaseList(call));
    }

    @Override
    @PluginMethod
    public void getMigratableDbList(PluginCall call) {
        onLane(() -> super.getMigratableDbList(call));
    }

    @Override
    @PluginMethod
    public void addSQLiteSuffix(PluginCall call) {
        onLane(() -> super.addSQLiteSuffix(call));
    }

    @Override
    @PluginMethod
    public void deleteOldDatabases(PluginCall call) {
        onLane(() -> super.deleteOldDatabases(call));
    }

    @Override
    @PluginMethod
    public void moveDatabasesAndAddSuffix(PluginCall call) {
        onLane(() -> super.moveDatabasesAndAddSuffix(call));
    }

    @Override
    @PluginMethod
    public void execute(PluginCall call) {
        onLane(() -> super.execute(call));
    }

    @Override
    @PluginMethod
    public void executeSet(PluginCall call) {
        onLane(() -> {
            try {
                super.executeSet(call);
            } catch (Exception failure) {
                call.reject("executeSet: " + failure.getMessage());
            }
        });
    }

    @Override
    @PluginMethod
    public void run(PluginCall call) {
        onLane(() -> super.run(call));
    }

    @Override
    @PluginMethod
    public void query(PluginCall call) {
        onLane(() -> super.query(call));
    }

    @Override
    @PluginMethod
    public void getTableList(PluginCall call) {
        onLane(() -> super.getTableList(call));
    }

    @Override
    @PluginMethod
    public void isDBExists(PluginCall call) {
        onLane(() -> super.isDBExists(call));
    }

    @Override
    @PluginMethod
    public void isDBOpen(PluginCall call) {
        onLane(() -> super.isDBOpen(call));
    }

    @Override
    @PluginMethod
    public void deleteDatabase(PluginCall call) {
        afterFolding(() -> super.deleteDatabase(call));
    }

    @Override
    @PluginMethod
    public void createSyncTable(PluginCall call) {
        onLane(() -> super.createSyncTable(call));
    }

    @Override
    @PluginMethod
    public void setSyncDate(PluginCall call) {
        onLane(() -> super.setSyncDate(call));
    }

    @Override
    @PluginMethod
    public void getSyncDate(PluginCall call) {
        onLane(() -> super.getSyncDate(call));
    }

    @Override
    @PluginMethod
    public void addUpgradeStatement(PluginCall call) {
        onLane(() -> super.addUpgradeStatement(call));
    }

    @Override
    @PluginMethod
    public void isJsonValid(PluginCall call) {
        onLane(() -> super.isJsonValid(call));
    }

    @Override
    @PluginMethod
    public void importFromJson(PluginCall call) {
        onLane(() -> super.importFromJson(call));
    }

    @Override
    @PluginMethod
    public void exportToJson(PluginCall call) {
        onLane(() -> super.exportToJson(call));
    }

    @Override
    @PluginMethod
    public void deleteExportedRows(PluginCall call) {
        onLane(() -> super.deleteExportedRows(call));
    }

    @Override
    @PluginMethod
    public void copyFromAssets(PluginCall call) {
        onLane(() -> super.copyFromAssets(call));
    }

    @Override
    @PluginMethod
    public void getFromHTTPRequest(PluginCall call) {
        onLane(() -> super.getFromHTTPRequest(call));
    }
}
