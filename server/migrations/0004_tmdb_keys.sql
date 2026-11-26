-- The account's own TMDB key, sealed on the device like the OpenSubtitles login.
CREATE TABLE IF NOT EXISTS tmdb_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
