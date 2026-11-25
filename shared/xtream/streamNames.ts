/**
 * A word index of the device catalogue's stream names (SQLite FTS5), for
 * `Catalogue.findTitles` -- a film page's More like this, its collection and
 * its copies.
 *
 * Without it each such lookup was twenty `LIKE '%word%'` tests of every name:
 * 2.6 s a read on a user's TV with 200,000 films, two or three reads a film
 * page, queued one after another on Android's one database lane (26
 * November). Here a word is looked up, not searched for: under a
 * millisecond on a PC.
 *
 * Contentless, with `contentless_delete` (SQLite 3.43): deleting a row that
 * was never indexed does nothing and a row can be indexed again, so the
 * triggers keep it right whatever came first, and a library already held is
 * indexed a piece at a time (`STREAM_NAMES_FILL`) without the lane held
 * for the whole of it. Keyed by the rowid of `streams`, which UPSERT_STREAM
 * keeps: `INSERT OR REPLACE` would give a row a new rowid and leave the old
 * one indexed.
 *
 * shortcut: a full VACUUM could renumber `streams`' rowids, which would leave
 * the index pointing at the wrong rows (found names are re-tested, so wrong
 * rows are dropped, but right ones missed). SQLite keeps them in practice and
 * DatabaseSpace does a full VACUUM once per device; if titles go missing after
 * one, drop `stream_names_filled` there so the index is filled again.
 */

/**
 * One statement a line: the Android plugin splits a script at ";" and a line
 * end. The triggers delete before they insert rather than INSERT OR REPLACE:
 * inside a trigger the writing statement's conflict policy wins, and an
 * UPSERT's left a renamed film found by its old name too.
 */
export const STREAM_NAMES_SETUP = `CREATE VIRTUAL TABLE IF NOT EXISTS stream_names USING fts5(name, content='', contentless_delete=1);
CREATE TABLE IF NOT EXISTS stream_names_filled (id INTEGER PRIMARY KEY CHECK (id = 1), upto INTEGER NOT NULL, done INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS stream_names_insert AFTER INSERT ON streams BEGIN DELETE FROM stream_names WHERE rowid = new.rowid; INSERT INTO stream_names (rowid, name) VALUES (new.rowid, new.name); END;
CREATE TRIGGER IF NOT EXISTS stream_names_delete AFTER DELETE ON streams BEGIN DELETE FROM stream_names WHERE rowid = old.rowid; END;
CREATE TRIGGER IF NOT EXISTS stream_names_update AFTER UPDATE OF name ON streams WHEN old.name IS NOT new.name BEGIN DELETE FROM stream_names WHERE rowid = new.rowid; INSERT INTO stream_names (rowid, name) VALUES (new.rowid, new.name); END;
`;

/** Rows indexed by one call of `STREAM_NAMES_FILL`: about half a second on a slow TV. */
export const STREAM_NAMES_PIECE = 1000;

/** Indexes the rows whose rowid is above the first value and at most the second. */
export const STREAM_NAMES_FILL = `INSERT OR REPLACE INTO stream_names (rowid, name) SELECT rowid, name FROM streams WHERE rowid > ? AND rowid <= ?`;

/** How far filling has come; `done` once every row held when it began is indexed. */
export const STREAM_NAMES_PROGRESS = `INSERT OR REPLACE INTO stream_names_filled (id, upto, done) VALUES (1, ?, ?)`;

/** A stream's columns, written so a stream already held keeps its row (and rowid). */
export const STREAM_COLUMNS = [
  'provider',
  'type',
  'category_id',
  'stream_id',
  'name',
  'stream_icon',
  'epg_channel_id',
  'added',
  'num',
  'container_extension',
  'tv_archive',
  'tv_archive_duration',
  'extra'
] as const;

export const UPSERT_STREAM = `INSERT INTO streams (${STREAM_COLUMNS.join(', ')})
  VALUES (${STREAM_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT (provider, type, stream_id) DO UPDATE SET
  ${STREAM_COLUMNS.slice(4)
    .concat('category_id')
    .map(column => `${column} = excluded.${column}`)
    .join(', ')}`;

/**
 * An FTS5 query for names with a word beginning with any of these, the words
 * quoted so nothing in them is read as syntax.
 */
export const namesBeginningWith = (words: readonly string[]): string =>
  words.map(word => `"${word.replace(/"/g, '""')}"*`).join(' OR ');

/** `streams` rows matching a `namesBeginningWith` query (the first parameter), joined on the index's rowid. */
export const STREAMS_NAMED = `FROM stream_names JOIN streams ON streams.rowid = stream_names.rowid WHERE stream_names MATCH ?`;
