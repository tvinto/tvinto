import Database from 'better-sqlite3';
import {
  namesBeginningWith,
  STREAM_NAMES_FILL,
  STREAM_NAMES_SETUP,
  STREAMS_NAMED,
  UPSERT_STREAM
} from './streamNames';

/**
 * The name index the Android catalogue (CapacitorCatalogueStore) looks titles
 * up in, on a real SQLite: the web's sql.js, which the frontend's tests run
 * on, has no FTS5.
 */
describe('stream_names', () => {
  const open = () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE streams (
      provider TEXT NOT NULL, type TEXT NOT NULL, category_id TEXT NOT NULL, stream_id TEXT NOT NULL,
      name TEXT NOT NULL, stream_icon TEXT, epg_channel_id TEXT, added TEXT, num INTEGER,
      container_extension TEXT, tv_archive INTEGER, tv_archive_duration INTEGER, extra TEXT,
      PRIMARY KEY (provider, type, stream_id))`);
    const write = (id: string, name: string, type = 'vod') =>
      db.prepare(UPSERT_STREAM).run('me', type, '1', id, name, null, null, null, null, null, null, null, null);
    const found = (words: string[], type = 'vod') =>
      db
        .prepare(`SELECT streams.stream_id ${STREAMS_NAMED} AND streams.provider = ? AND streams.type = ? ORDER BY streams.name`)
        .all(namesBeginningWith(words), 'me', type)
        .map(row => (row as { stream_id: string }).stream_id);
    return { db, write, found };
  };

  it('indexes the names held before it, a piece at a time, and every name written after', () => {
    const { db, write, found } = open();
    write('1', 'EN - Blade Runner (1982)');
    write('2', 'HR| Čuvar plaže');
    db.exec(STREAM_NAMES_SETUP);
    expect(found(['blade'])).toEqual([]);

    db.prepare(STREAM_NAMES_FILL).run(0, 1);
    db.prepare(STREAM_NAMES_FILL).run(1, 2);
    write('3', 'DE - Blade (1998)');

    expect(found(['blade'])).toEqual(['3', '1']);
    expect(found(['cuvar', 'nothing'])).toEqual(['2']);
    expect(found(['blade'], 'series')).toEqual([]);
  });

  it('keeps a renamed stream under its new name only, and forgets a deleted one', () => {
    const { db, write, found } = open();
    db.exec(STREAM_NAMES_SETUP);
    write('1', 'EN - Heat (1995)');
    const rowid = () => db.prepare("SELECT rowid FROM streams WHERE stream_id = '1'").pluck().get();
    const before = rowid();

    write('1', 'EN - Heat (1995)');
    write('1', 'EN - Ronin (1998)');

    expect(rowid()).toBe(before);
    expect(found(['heat'])).toEqual([]);
    expect(found(['ronin'])).toEqual(['1']);
    db.exec("DELETE FROM streams WHERE stream_id = '1'");
    expect(found(['ronin'])).toEqual([]);
  });

  it('reads a word with a quote in it as a word, not as part of the query', () => {
    const { db, write, found } = open();
    db.exec(STREAM_NAMES_SETUP);
    write('1', 'Say "Cheese"');

    expect(found(['"cheese', 'x" OR "say'])).toEqual(['1']);
    expect(found(['x" OR "say'])).toEqual([]);
  });
});
