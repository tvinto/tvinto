-- Families, for a database made before them.
-- schema.sql already has all of this for a new one.
--
-- Run one statement at a time with --command (--file fails with an
-- authentication error here), then read the columns back:
--   SELECT name FROM pragma_table_info('users');
--   SELECT name FROM pragma_table_info('sessions');

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE users ADD COLUMN manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN household INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);

ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';

CREATE TABLE IF NOT EXISTS account_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  sealed_private_key TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_keys (
  member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sealed_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (member_id, manager_id)
);

CREATE INDEX IF NOT EXISTS idx_managed_keys_manager ON managed_keys(manager_id);
