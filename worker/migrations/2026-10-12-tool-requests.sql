-- Approving a tool's sign-in on a device, for a database
-- made before it. schema.sql already has this for a new one.
--
-- Run each statement with --command, then check it is there:
--   SELECT name FROM pragma_table_info('tool_requests');

CREATE TABLE IF NOT EXISTS tool_requests (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, history INTEGER NOT NULL DEFAULT 0, public_key TEXT NOT NULL, code TEXT NOT NULL, secret_hash TEXT NOT NULL, status TEXT NOT NULL, sealed_token TEXT, sealed_enc TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_tool_requests_user ON tool_requests(user_id, status);
