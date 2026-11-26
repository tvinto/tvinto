import Database from 'better-sqlite3';
import { config } from '../config/config';
import { foldText } from '../../../shared/xtream/guideSearch';
import { runMigrations } from './migrations';
import { observeTime } from './syncClock';

// The one place the cache file is chosen is config.database.path, so
// DATABASE_PATH means the same thing everywhere -- including in tests, which
// point it at a throwaway file rather than the live cache.
const db = new Database(config.database.path);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Off by default in SQLite, so the references declared below would otherwise be
// documentation rather than rules -- and deleting an account would leave its
// subscriptions behind.
db.pragma('foreign_keys = ON');

// A name as Catalogue.search reads it, accents folded, for SqliteCatalogueStore.findStreams.
db.function('fold', { deterministic: true }, (value: unknown) => (typeof value === 'string' ? foldText(value) : value));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id TEXT NOT NULL,
    category_name TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_id INTEGER,
    username TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category_id, type, username)
  );

  CREATE TABLE IF NOT EXISTS streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    stream_type TEXT,
    stream_icon TEXT,
    epg_channel_id TEXT,
    category_id TEXT NOT NULL,
    type TEXT NOT NULL,
    username TEXT NOT NULL,
    added TEXT,
    custom_sid TEXT,
    tv_archive INTEGER,
    direct_source TEXT,
    tv_archive_duration INTEGER,
    num INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stream_id, type, username)
  );

  CREATE TABLE IF NOT EXISTS sync_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    type TEXT NOT NULL,
    last_sync DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending',
    total_categories INTEGER DEFAULT 0,
    total_streams INTEGER DEFAULT 0,
    UNIQUE(username, type)
  );

  CREATE TABLE IF NOT EXISTS epg_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epg_channel_id TEXT NOT NULL,
    start DATETIME NOT NULL,
    stop DATETIME NOT NULL,
    title TEXT,
    description TEXT,
    lang TEXT,
    username TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(epg_channel_id, start, username)
  );

  CREATE TABLE IF NOT EXISTS epg_fetch_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    epg_channel_id TEXT NOT NULL,
    attempted_at DATETIME NOT NULL,
    UNIQUE(username, epg_channel_id)
  );

  CREATE INDEX IF NOT EXISTS idx_epg_attempts ON epg_fetch_attempts(username, attempted_at);

  -- Keyed to the account, not to the subscription: provider credentials expire
  -- and are reissued, and a favourite must not expire with them. username is
  -- kept only so rows written before accounts existed can still be claimed by
  -- whoever proves they hold those credentials.
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    username TEXT,
    stream_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS watch_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    username TEXT,
    type TEXT NOT NULL,
    -- The playable id: a stream_id for live and movies, an episode id for a show.
    item_id TEXT NOT NULL,
    -- Set only for episodes, so a show groups under one entry however many of
    -- its episodes have been watched.
    series_id TEXT,
    season INTEGER,
    episode_num INTEGER,
    -- Name and icon are copied in, not joined: an episode has no row in
    -- streams, and a channel the provider drops loses its row on the next sync.
    name TEXT NOT NULL,
    episode_title TEXT,
    icon TEXT,
    container_extension TEXT,
    position_seconds REAL NOT NULL DEFAULT 0,
    duration_seconds REAL NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sort_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    username TEXT,
    scope TEXT NOT NULL,
    item_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    name TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_epg_channel_start ON epg_listings(epg_channel_id, start);
  CREATE INDEX IF NOT EXISTS idx_epg_username ON epg_listings(username);

  CREATE INDEX IF NOT EXISTS idx_streams_name ON streams(name);
  CREATE INDEX IF NOT EXISTS idx_streams_category ON streams(category_id, type, username);
  CREATE INDEX IF NOT EXISTS idx_streams_type ON streams(type, username);
  CREATE INDEX IF NOT EXISTS idx_categories_type ON categories(type, username);
`);

// Schema changes that CREATE TABLE IF NOT EXISTS cannot make -- adding a column
// to a table that already exists, and anything else that has to happen once
// against data already on disk.
runMigrations(db);

// A restart must not begin handing out times that have already been used: a
// new change sorting before an old one would be missed by any device whose
// cursor sits between them.
for (const table of ['favorites', 'sort_order', 'watch_progress', 'user_settings']) {
  const row = db.prepare(`SELECT MAX(updated_at) AS latest FROM ${table}`).get() as {
    latest: string | null;
  };
  observeTime(row?.latest);
}

// Prepared statements
export const statements = {
  // Categories
  insertCategory: db.prepare(`
    INSERT OR REPLACE INTO categories (category_id, category_name, type, parent_id, username)
    VALUES (?, ?, ?, ?, ?)
  `),
  
  getCategories: db.prepare(`
    SELECT category_id, category_name, parent_id
    FROM categories
    WHERE type = ? AND username = ?
    ORDER BY category_name
  `),

  // Streams
  insertStream: db.prepare(`
    INSERT OR REPLACE INTO streams (
      stream_id, name, stream_type, stream_icon, epg_channel_id,
      category_id, type, username, added, custom_sid, tv_archive,
      direct_source, tv_archive_duration, num
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getStreamsByCategory: db.prepare(`
    SELECT * FROM streams
    WHERE category_id = ? AND type = ? AND username = ?
    ORDER BY name
  `),

  searchStreams: db.prepare(`
    SELECT * FROM streams
    WHERE name LIKE ? AND type = ? AND username = ?
    ORDER BY name
    LIMIT 500
  `),

  // Sync status
  updateSyncStatus: db.prepare(`
    INSERT OR REPLACE INTO sync_status (username, type, last_sync, status, total_categories, total_streams)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
  `),

  getSyncStatus: db.prepare(`
    SELECT * FROM sync_status
    WHERE username = ? AND type = ?
  `),

  clearUserData: db.prepare(`
    DELETE FROM streams WHERE username = ? AND type = ?
  `),

  clearUserCategories: db.prepare(`
    DELETE FROM categories WHERE username = ? AND type = ?
  `),

  // EPG
  upsertEPGListing: db.prepare(`
    INSERT OR REPLACE INTO epg_listings (
      epg_channel_id, start, stop, title, description, lang, username
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `),

  getEPGForChannelNow: db.prepare(`
    SELECT * FROM epg_listings
    WHERE epg_channel_id = ? AND username = ? AND start <= ? AND stop >= ?
    ORDER BY start DESC LIMIT 1
  `),

  getEPGNowForUser: db.prepare(`
    SELECT e.* FROM epg_listings e
    WHERE e.username = ? AND e.start <= ? AND e.stop >= ?
  `)
};

export { db };
