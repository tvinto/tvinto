import { foldText } from './guideSearch';

/**
 * A trigram index of the device guide's programme titles (SQLite FTS5), for
 * finding a programme by its title (`CapacitorGuideStore.searchProgrammes`).
 *
 * Without it every search read every title with LIKE: 0.6 to 2.7 s on a
 * user's TV with 292,000 programmes, even through an index of the titles
 * alone (27 November). A trigram index finds a run of three letters or more
 * anywhere in a title, which is what `titleMatches` asks, and finds only
 * candidates: the store checks each with `titleMatches` still.
 *
 * Contentless with `contentless_delete`, keyed by the rowid of
 * guide_programmes, kept by triggers like `stream_words`
 * (shared/xtream/streamNames.ts). Programmes are written with an upsert, which
 * keeps a row's rowid: INSERT OR REPLACE deletes a row without its delete
 * triggers, and left every old title of every reload indexed.
 */

/** One statement a line: the Android plugin splits a script at ";" and a line end. */
export const GUIDE_TITLES_SETUP = `CREATE VIRTUAL TABLE IF NOT EXISTS guide_titles USING fts5(title, tokenize='trigram remove_diacritics 1', content='', contentless_delete=1);
CREATE TABLE IF NOT EXISTS guide_titles_filled (id INTEGER PRIMARY KEY CHECK (id = 1), upto INTEGER NOT NULL, done INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS guide_titles_insert AFTER INSERT ON guide_programmes BEGIN DELETE FROM guide_titles WHERE rowid = new.rowid; INSERT INTO guide_titles (rowid, title) VALUES (new.rowid, ${indexedTitle('new.title')}); END;
CREATE TRIGGER IF NOT EXISTS guide_titles_delete AFTER DELETE ON guide_programmes BEGIN DELETE FROM guide_titles WHERE rowid = old.rowid; END;
CREATE TRIGGER IF NOT EXISTS guide_titles_update AFTER UPDATE OF title ON guide_programmes WHEN old.title IS NOT new.title BEGIN DELETE FROM guide_titles WHERE rowid = new.rowid; INSERT INTO guide_titles (rowid, title) VALUES (new.rowid, ${indexedTitle('new.title')}); END;
`;

/** Rows indexed by one call of `GUIDE_TITLES_FILL`, for a guide held before the index. */
export const GUIDE_TITLES_PIECE = 1000;

/** Indexes the rows whose rowid is above the first value and at most the second. */
export const GUIDE_TITLES_FILL = `INSERT OR REPLACE INTO guide_titles (rowid, title) SELECT rowid, ${indexedTitle('title')} FROM guide_programmes WHERE rowid > ? AND rowid <= ?`;

/** How far filling has come; `done` once every row held when it began is indexed. */
export const GUIDE_TITLES_PROGRESS = `INSERT OR REPLACE INTO guide_titles_filled (id, upto, done) VALUES (1, ?, ?)`;

/** Where filling has come to. */
export const GUIDE_TITLES_FILLED = 'SELECT upto, done FROM guide_titles_filled WHERE id = 1';

/**
 * Programmes with a title holding the query (the first parameter, from
 * `titlesHolding`), in finished loads, on between the second and third
 * parameters, earliest first, at most the fourth.
 */
export const PROGRAMMES_TITLED = `SELECT p.source_id, p.channel_id, p.start, p.stop, p.title, p.description, p.category
  FROM guide_titles t
  JOIN guide_programmes p ON p.rowid = t.rowid
  JOIN guide_loads l ON l.source_id = p.source_id
 WHERE guide_titles MATCH ? AND p.stop > ? AND p.start < ?
 ORDER BY p.start
 LIMIT ?`;

/** The FTS5 query for titles holding this, folded as `titleMatches` folds it, quoted so nothing in it is syntax. */
export const titlesHolding = (query: string): string => `"${foldText(query).replace(/"/g, '""')}"`;

/** A title as the index reads it: FTS5 folds č, ć, š and ž itself, not đ (as `foldText` does). */
function indexedTitle(column: string): string {
  return `REPLACE(REPLACE(${column}, 'đ', 'd'), 'Đ', 'D')`;
}
