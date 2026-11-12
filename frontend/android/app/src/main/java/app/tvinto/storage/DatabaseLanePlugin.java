package app.tvinto.storage;

import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.community.database.sqlite.CapacitorSQLitePlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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

    private final ExecutorService lane = Executors.newSingleThreadExecutor(work -> new Thread(work, "database"));

    @Override
    @PluginMethod
    public void echo(PluginCall call) {
        lane.execute(() -> super.echo(call));
    }

    @Override
    @PluginMethod
    public void isSecretStored(PluginCall call) {
        lane.execute(() -> super.isSecretStored(call));
    }

    @Override
    @PluginMethod
    public void setEncryptionSecret(PluginCall call) {
        lane.execute(() -> super.setEncryptionSecret(call));
    }

    @Override
    @PluginMethod
    public void changeEncryptionSecret(PluginCall call) {
        lane.execute(() -> super.changeEncryptionSecret(call));
    }

    @Override
    @PluginMethod
    public void clearEncryptionSecret(PluginCall call) {
        lane.execute(() -> super.clearEncryptionSecret(call));
    }

    @Override
    @PluginMethod
    public void checkEncryptionSecret(PluginCall call) {
        lane.execute(() -> super.checkEncryptionSecret(call));
    }

    @Override
    @PluginMethod
    public void getNCDatabasePath(PluginCall call) {
        lane.execute(() -> super.getNCDatabasePath(call));
    }

    @Override
    @PluginMethod
    public void createNCConnection(PluginCall call) {
        lane.execute(() -> super.createNCConnection(call));
    }

    @Override
    @PluginMethod
    public void createConnection(PluginCall call) {
        lane.execute(() -> super.createConnection(call));
    }

    @Override
    @PluginMethod
    public void open(PluginCall call) {
        lane.execute(() -> super.open(call));
    }

    @Override
    @PluginMethod
    public void close(PluginCall call) {
        lane.execute(() -> super.close(call));
    }

    @Override
    @PluginMethod
    public void beginTransaction(PluginCall call) {
        lane.execute(() -> super.beginTransaction(call));
    }

    @Override
    @PluginMethod
    public void commitTransaction(PluginCall call) {
        lane.execute(() -> super.commitTransaction(call));
    }

    @Override
    @PluginMethod
    public void rollbackTransaction(PluginCall call) {
        lane.execute(() -> super.rollbackTransaction(call));
    }

    @Override
    @PluginMethod
    public void isTransactionActive(PluginCall call) {
        lane.execute(() -> super.isTransactionActive(call));
    }

    @Override
    @PluginMethod
    public void getUrl(PluginCall call) {
        lane.execute(() -> super.getUrl(call));
    }

    @Override
    @PluginMethod
    public void getVersion(PluginCall call) {
        lane.execute(() -> super.getVersion(call));
    }

    @Override
    @PluginMethod
    public void closeNCConnection(PluginCall call) {
        lane.execute(() -> super.closeNCConnection(call));
    }

    @Override
    @PluginMethod
    public void closeConnection(PluginCall call) {
        lane.execute(() -> super.closeConnection(call));
    }

    @Override
    @PluginMethod
    public void checkConnectionsConsistency(PluginCall call) {
        lane.execute(() -> super.checkConnectionsConsistency(call));
    }

    @Override
    @PluginMethod
    public void isDatabase(PluginCall call) {
        lane.execute(() -> super.isDatabase(call));
    }

    @Override
    @PluginMethod
    public void isDatabaseEncrypted(PluginCall call) {
        lane.execute(() -> super.isDatabaseEncrypted(call));
    }

    @Override
    @PluginMethod
    public void isInConfigEncryption(PluginCall call) {
        lane.execute(() -> super.isInConfigEncryption(call));
    }

    @Override
    @PluginMethod
    public void isInConfigBiometricAuth(PluginCall call) {
        lane.execute(() -> super.isInConfigBiometricAuth(call));
    }

    @Override
    @PluginMethod
    public void isNCDatabase(PluginCall call) {
        lane.execute(() -> super.isNCDatabase(call));
    }

    @Override
    @PluginMethod
    public void isTableExists(PluginCall call) {
        lane.execute(() -> super.isTableExists(call));
    }

    @Override
    @PluginMethod
    public void getDatabaseList(PluginCall call) {
        lane.execute(() -> super.getDatabaseList(call));
    }

    @Override
    @PluginMethod
    public void getMigratableDbList(PluginCall call) {
        lane.execute(() -> super.getMigratableDbList(call));
    }

    @Override
    @PluginMethod
    public void addSQLiteSuffix(PluginCall call) {
        lane.execute(() -> super.addSQLiteSuffix(call));
    }

    @Override
    @PluginMethod
    public void deleteOldDatabases(PluginCall call) {
        lane.execute(() -> super.deleteOldDatabases(call));
    }

    @Override
    @PluginMethod
    public void moveDatabasesAndAddSuffix(PluginCall call) {
        lane.execute(() -> super.moveDatabasesAndAddSuffix(call));
    }

    @Override
    @PluginMethod
    public void execute(PluginCall call) {
        lane.execute(() -> super.execute(call));
    }

    @Override
    @PluginMethod
    public void executeSet(PluginCall call) {
        lane.execute(() -> {
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
        lane.execute(() -> super.run(call));
    }

    @Override
    @PluginMethod
    public void query(PluginCall call) {
        lane.execute(() -> super.query(call));
    }

    @Override
    @PluginMethod
    public void getTableList(PluginCall call) {
        lane.execute(() -> super.getTableList(call));
    }

    @Override
    @PluginMethod
    public void isDBExists(PluginCall call) {
        lane.execute(() -> super.isDBExists(call));
    }

    @Override
    @PluginMethod
    public void isDBOpen(PluginCall call) {
        lane.execute(() -> super.isDBOpen(call));
    }

    @Override
    @PluginMethod
    public void deleteDatabase(PluginCall call) {
        lane.execute(() -> super.deleteDatabase(call));
    }

    @Override
    @PluginMethod
    public void createSyncTable(PluginCall call) {
        lane.execute(() -> super.createSyncTable(call));
    }

    @Override
    @PluginMethod
    public void setSyncDate(PluginCall call) {
        lane.execute(() -> super.setSyncDate(call));
    }

    @Override
    @PluginMethod
    public void getSyncDate(PluginCall call) {
        lane.execute(() -> super.getSyncDate(call));
    }

    @Override
    @PluginMethod
    public void addUpgradeStatement(PluginCall call) {
        lane.execute(() -> super.addUpgradeStatement(call));
    }

    @Override
    @PluginMethod
    public void isJsonValid(PluginCall call) {
        lane.execute(() -> super.isJsonValid(call));
    }

    @Override
    @PluginMethod
    public void importFromJson(PluginCall call) {
        lane.execute(() -> super.importFromJson(call));
    }

    @Override
    @PluginMethod
    public void exportToJson(PluginCall call) {
        lane.execute(() -> super.exportToJson(call));
    }

    @Override
    @PluginMethod
    public void deleteExportedRows(PluginCall call) {
        lane.execute(() -> super.deleteExportedRows(call));
    }

    @Override
    @PluginMethod
    public void copyFromAssets(PluginCall call) {
        lane.execute(() -> super.copyFromAssets(call));
    }

    @Override
    @PluginMethod
    public void getFromHTTPRequest(PluginCall call) {
        lane.execute(() -> super.getFromHTTPRequest(call));
    }
}
