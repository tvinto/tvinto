-- Who made a session (sessions.ts, MintedBy), and the confirmation a tool
-- sends back once allowed (toolRequests.ts), for a database made before
-- them. schema.sql already has these for a new one.
-- Run each with --command, then read the columns back:
--   SELECT name FROM pragma_table_info('sessions');
ALTER TABLE sessions ADD COLUMN minted_by INTEGER;
ALTER TABLE sessions ADD COLUMN minted_by_session TEXT;
ALTER TABLE sessions ADD COLUMN minted_by_tool INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tool_requests ADD COLUMN confirm_hash TEXT;
ALTER TABLE tool_requests ADD COLUMN confirm_tries INTEGER NOT NULL DEFAULT 0;
