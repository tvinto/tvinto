-- Tool sessions, for a database made before them.
-- schema.sql already has this for a new one.
--
-- Run one statement at a time with --command (--file fails with an
-- authentication error here), then read the columns back:
--   SELECT name FROM pragma_table_info('sessions');

ALTER TABLE sessions ADD COLUMN label TEXT;
