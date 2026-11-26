import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  SQLiteDBConnection
} from '@capacitor-community/sqlite';

/** The database the device keeps its own copy of things in. */
const DB_NAME = 'xtream-catalogue';
const DB_VERSION = 1;

/** DatabaseLanePlugin.java's own method, beside the SQLite plugin's. */
interface Folding {
  untilFolded(): Promise<void>;
  addListener(event: 'foldDue', listener: () => void): Promise<unknown>;
}

/** The calls that touch the file, held while a clean rewrites it (`hold`). */
const HELD_CALLS = new Set(['query', 'run', 'execute', 'executeSet', 'executeTransaction', 'beginTransaction', 'commitTransaction', 'rollbackTransaction']);

/**
 * The one connection to the device's database.
 *
 * Extracted from ProviderAccessService when the guide became the second thing
 * wanting to store something. The plugin keeps its own registry of connections
 * and refuses to create one twice, so two services each opening "the database"
 * is not two connections but one and an error -- and the second caller is the
 * one that fails, which makes it look like the guide is broken when nothing
 * about the guide is.
 *
 * Opened lazily and shared. Everything that stores anything on the device asks
 * here.
 */
@Injectable({ providedIn: 'root' })
export class DeviceDatabaseService {
  /**
   * One wrapper for the life of the app, and that is load-bearing.
   *
   * `SQLiteConnection` keeps a map of the connections *it* made, while the
   * plugin keeps its own on the native side. A fresh wrapper has an empty map,
   * so it answers "no connection" to `isConnection` and cannot hand one back
   * from `retrieveConnection` -- while the native side, which remembers across
   * a page reload, refuses to create a second. Build a new wrapper each time
   * and the two can never agree.
   */
  private readonly sqlite = new SQLiteConnection(CapacitorSQLite);

  private connection: SQLiteDBConnection | null = null;
  private opening: Promise<SQLiteDBConnection> | null = null;

  /** Set while the log is folded in before it starts over; writes wait for it (`open`). */
  private folding: Promise<void> | null = null;

  constructor() {
    if (Capacitor.getPlatform() !== 'android') {
      return;
    }
    const lane = CapacitorSQLite as unknown as Folding;
    void lane.addListener('foldDue', () => {
      this.folding ??= lane.untilFolded()
        .catch(() => undefined)
        .finally(() => (this.folding = null));
    });
  }

  /** Set while "Free up space" rewrites the file on a connection of its own (DatabaseSpaceService). */
  private held: Promise<void> | null = null;

  /**
   * Makes every call to the database wait until the returned function is
   * called. The clean runs on a connection of its own and waits on the app's
   * locks for half a minute at most; a call that went on regardless would
   * get "database is locked" instead, as an error somewhere behind the busy
   * screen. Waiting is what the busy screen is there to explain.
   */
  hold(): () => void {
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    this.held = held;
    return () => {
      if (this.held === held) {
        this.held = null;
      }
      release();
    };
  }

  /**
   * The connection, opened if it is not already.
   *
   * Memoised on the promise rather than the result so that several callers
   * arriving together during startup share one attempt rather than racing to
   * create the same connection.
   */
  async connect(): Promise<SQLiteDBConnection> {
    if (this.connection) {
      return this.connection;
    }

    this.opening ??= this.open();

    try {
      this.connection = await this.opening;
      return this.connection;
    } finally {
      this.opening = null;
    }
  }

  /**
   * Closes it, for a sign-out.
   *
   * A connection that will not close is not worth failing a sign-out for, so
   * the handle is dropped either way: what actually stops it being used is
   * this class forgetting it.
   */
  async close(): Promise<void> {
    const open = this.connection;
    this.connection = null;
    this.opening = null;

    if (!open) {
      return;
    }

    try {
      await open.close();
      await this.sqlite.closeConnection(DB_NAME, false);
    } catch {
      // Nothing above depends on the close succeeding.
    }
  }

  private async open(): Promise<SQLiteDBConnection> {
    const db = await this.eitherDoor();

    if (!(await db.isDBOpen()).result) {
      await db.open();
    }

    // Write-ahead logging. With SQLite's default rollback journal each
    // commit wrote and synced a journal file of its own, several hundred ms
    // on the TV emulator, so a library refresh either held the database for
    // seconds at a time -- the largest film category in one write, every
    // screen waiting behind it -- or, in pieces, took four times as long.
    // In WAL mode the same category in pieces took under a second, and a
    // read asked meanwhile waited 40-60 ms (23 October). Kept in the file
    // once set; asked at every open, which costs nothing when it already is.
    // The log is cut back to 16 MB after each checkpoint, rather than
    // keeping the size of the largest write it ever held.
    try {
      await db.query('PRAGMA journal_mode = WAL');
      await db.query('PRAGMA journal_size_limit = 16777216');
      // Android folds the log into the file on a connection of its own
      // (DatabaseLanePlugin.java): folded in by whichever write filled it,
      // that write held every other call 1 to 3 s on a user's TV. When the
      // log is long, writes wait while all of it is folded in, so the next
      // one starts it over; reads go on.
      if (Capacitor.getPlatform() === 'android') {
        await db.query('PRAGMA wal_autocheckpoint = 0');
      }
    } catch {
      // The rollback journal still works, only slower.
    }

    return this.waitingWhileHeld(db);
  }

  /** The connection, its calls that touch the file waiting while it is held. */
  private waitingWhileHeld(db: SQLiteDBConnection): SQLiteDBConnection {
    return new Proxy(db, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        if (typeof key !== 'string' || !HELD_CALLS.has(key) || typeof value !== 'function') {
          return value;
        }
        return async (...args: unknown[]) => {
          while (this.held) {
            await this.held;
          }
          while (key === 'executeSet' && this.folding) {
            await this.folding;
          }
          return value.apply(target, args);
        };
      }
    });
  }

  /**
   * The connection, however the plugin happens to feel about it.
   *
   * A page reload in a WebView leaves the plugin's registry intact, so the
   * connection may already exist even though this object is new -- which is
   * what `isConnection` is asked. The catch is that the two answers can
   * disagree: on the TV emulator `isConnection` said no and `createConnection`
   * then failed with "Connection xtream-catalogue already exists", logged by
   * the plugin and thrown here.
   *
   * What that cost is out of all proportion to the bug. Opening the database is
   * how the catalogue is read, so a failure here is not a failure to open a
   * database -- it is a device that reports "not indexed on this device yet"
   * for a library it has fully indexed, and a search that can never find
   * anything however long it is left. Measured on the emulator, where every
   * library read as empty and indexing appeared to run forever.
   *
   * So the question is not asked. Both doors are tried, and either one opening
   * is a success.
   */
  private async eitherDoor(): Promise<SQLiteDBConnection> {
    if ((await this.sqlite.isConnection(DB_NAME, false)).result) {
      return await this.sqlite.retrieveConnection(DB_NAME, false);
    }

    try {
      return await this.sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
    } catch {
      // The native side is holding one this wrapper knows nothing about, which
      // is what a reload leaves behind. Let it go and take a fresh one: the
      // database is a cache of the provider's catalogue, so nothing is lost by
      // reconnecting to it.
      await this.sqlite.closeConnection(DB_NAME, false).catch(() => undefined);
      return await this.sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
    }
  }
}

