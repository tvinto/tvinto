-- Wrong sign-ins and invite codes, counted (src/signInLimit.ts), for a
-- database made before it. schema.sql already has this for a new one.
--
-- Run with --command, then read the columns back:
--   SELECT name FROM pragma_table_info('sign_in_failures');
-- Before deploying the Worker that uses it: without the table every sign-in
-- would fail.

CREATE TABLE IF NOT EXISTS sign_in_failures (key TEXT PRIMARY KEY, since TEXT NOT NULL, count INTEGER NOT NULL);
