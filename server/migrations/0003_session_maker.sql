-- Who made a session, so one a manager or a tool made ends with its maker.
ALTER TABLE sessions ADD COLUMN minted_by INTEGER;
ALTER TABLE sessions ADD COLUMN minted_by_session TEXT;
ALTER TABLE sessions ADD COLUMN minted_by_tool INTEGER NOT NULL DEFAULT 0;
-- The confirmation a tool sends back after it is allowed in the app.
ALTER TABLE tool_requests ADD COLUMN confirm_hash TEXT;
ALTER TABLE tool_requests ADD COLUMN confirm_tries INTEGER NOT NULL DEFAULT 0;
