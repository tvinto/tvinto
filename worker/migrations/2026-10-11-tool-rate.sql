-- A tool's changes per minute, for a database
-- made before it. schema.sql already has this for a new one.
--
-- Run with --command, then read the columns back:
--   SELECT name FROM pragma_table_info('sessions');
-- Before deploying the Worker that writes it: without the column every push
-- from a tool would fail.

ALTER TABLE sessions ADD COLUMN tool_window TEXT;
