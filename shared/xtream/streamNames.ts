/**
 * A word index of the device catalogue's stream names (SQLite FTS5, `stream_words`), for
 * search and `Catalogue.findTitles` -- a film page's More like this, its collection and
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
 * one, drop `stream_words_filled` there so the index is filled again.
 */

/**
 * One statement a line: the Android plugin splits a script at ";" and a line
 * end. The triggers delete before they insert rather than INSERT OR REPLACE:
 * inside a trigger the writing statement's conflict policy wins, and an
 * UPSERT's left a renamed film found by its old name too.
 *
 * With the library type beside the name, so a word looked for in shows is
 * not checked against every film it is in: `stream_names` had the name
 * alone, and "film" in shows read all 201,000 film rows to turn each away
 * (the PC: 103 ms against 6, warm). Its triggers go here and its table once
 * the device is idle (STREAM_NAMES_RETIRE): dropping it can hold the database.
 */
export const STREAM_NAMES_SETUP = `DROP TRIGGER IF EXISTS stream_names_insert;
DROP TRIGGER IF EXISTS stream_names_delete;
DROP TRIGGER IF EXISTS stream_names_update;
CREATE VIRTUAL TABLE IF NOT EXISTS stream_words USING fts5(name, type, content='', contentless_delete=1);
CREATE TABLE IF NOT EXISTS stream_words_filled (id INTEGER PRIMARY KEY CHECK (id = 1), upto INTEGER NOT NULL, done INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS stream_words_insert AFTER INSERT ON streams BEGIN DELETE FROM stream_words WHERE rowid = new.rowid; INSERT INTO stream_words (rowid, name, type) VALUES (new.rowid, ${indexedName('new.name')}, new.type); END;
CREATE TRIGGER IF NOT EXISTS stream_words_delete AFTER DELETE ON streams BEGIN DELETE FROM stream_words WHERE rowid = old.rowid; END;
CREATE TRIGGER IF NOT EXISTS stream_words_update AFTER UPDATE OF name ON streams WHEN old.name IS NOT new.name BEGIN DELETE FROM stream_words WHERE rowid = new.rowid; INSERT INTO stream_words (rowid, name, type) VALUES (new.rowid, ${indexedName('new.name')}, new.type); END;
`;

/** The name index before the type was in it, thrown away once the device is idle. */
export const STREAM_NAMES_RETIRE = `DROP TABLE IF EXISTS stream_names;
DROP TABLE IF EXISTS stream_names_filled;
`;

/** Rows indexed by one call of `STREAM_NAMES_FILL`: about half a second on a slow TV. */
export const STREAM_NAMES_PIECE = 1000;

/** Indexes the rows whose rowid is above the first value and at most the second. */
export const STREAM_NAMES_FILL = `INSERT OR REPLACE INTO stream_words (rowid, name, type) SELECT rowid, ${indexedName('name')}, type FROM streams WHERE rowid > ? AND rowid <= ?`;

/** How far filling has come; `done` once every row held when it began is indexed. */
export const STREAM_NAMES_PROGRESS = `INSERT OR REPLACE INTO stream_words_filled (id, upto, done) VALUES (1, ?, ?)`;

/** Where filling has come to. */
export const STREAM_NAMES_FILLED = 'SELECT upto, done FROM stream_words_filled WHERE id = 1';

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
  'extra',
  // streamGuideKeys (guideMatching.ts), live streams only.
  'guide_id',
  'guide_name'
] as const;

export const UPSERT_STREAM = `INSERT INTO streams (${STREAM_COLUMNS.join(', ')})
  VALUES (${STREAM_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT (provider, type, stream_id) DO UPDATE SET
  ${STREAM_COLUMNS.slice(4)
    .concat('category_id')
    .map(column => `${column} = excluded.${column}`)
    .join(', ')}`;

/**
 * A name as the index reads it. FTS5 takes the accents off č, ć, š and ž
 * itself, as `foldText` does for the words looked for, but not đ, which is a
 * letter of its own to Unicode: "duro" would not find "Đuro".
 */
function indexedName(column: string): string {
  return `REPLACE(REPLACE(${column}, 'đ', 'd'), 'Đ', 'D')`;
}

/** Shorter words than this must be a whole word of the name, as in `Catalogue.search`. */
export const PREFIX_FROM = 3;

const quoted = (text: string): string => `"${text.replace(/"/g, '""')}"`;

/** A word that begins a word of the name, or is one when it is short. */
const beginning = (word: string): string => (word.length >= PREFIX_FROM ? `${quoted(word)}*` : quoted(word));

/**
 * The word, or the word as two or three words of the name written together
 * ("xmen" for "X-Men", "oceans" for "Ocean's"): `nameWordsJoined` in the
 * index, a phrase for each place the word could be cut.
 */
const joinedRuns = (word: string): string => {
  const runs = [word];
  for (let first = 1; first < word.length; first++) {
    runs.push(`${word.slice(0, first)} ${word.slice(first)}`);
    for (let second = first + 1; second < word.length; second++) {
      runs.push(`${word.slice(0, first)} ${word.slice(first, second)} ${word.slice(second)}`);
    }
  }
  return `(${runs.map(run => `${quoted(run)}*`).join(' OR ')})`;
};

/**
 * An FTS5 query for a library's names with a word beginning with any of
 * these, the words quoted so nothing in them is read as syntax.
 */
export const namesWithAny = (type: string, words: readonly string[]): string =>
  `type : ${quoted(type)} AND name : (${words.map(word => `${quoted(word)}*`).join(' OR ')})`;

/**
 * An FTS5 query for a library's names with every one of these words, as
 * `Catalogue.search` matches them: each begins a word of the name (or is
 * one, when short), or with `joined` begins two or three of them written
 * together. Words reach it folded and ASCII (`nameWords`).
 */
export const namesWithEvery = (type: string, words: readonly string[], joined = false): string =>
  `type : ${quoted(type)} AND name : (${words.map(joined ? joinedRuns : beginning).join(' AND ')})`;

/** `streams` rows matching a `namesWith...` query (the first parameter), joined on the index's rowid. */
export const STREAMS_NAMED = `FROM stream_words JOIN streams ON streams.rowid = stream_words.rowid WHERE stream_words MATCH ?`;
