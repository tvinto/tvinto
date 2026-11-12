-- What a tool asks the app to do, for a database made
-- before it. schema.sql already has this for a new one.
--
-- Run each statement with --command, then check it is there:
--   SELECT name FROM pragma_table_info('tool_actions');

CREATE TABLE IF NOT EXISTS tool_actions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, tool_name TEXT NOT NULL, kind TEXT NOT NULL, details TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_tool_actions_user ON tool_actions(user_id, status);
