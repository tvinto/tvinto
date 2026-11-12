-- A profile picture on each account (shared/profilePicture.ts), for a
-- database made before it. schema.sql already has this for a new one.
--
-- Run with --command, then read the columns back:
--   SELECT name FROM pragma_table_info('users');
ALTER TABLE users ADD COLUMN picture TEXT;
