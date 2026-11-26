import Database from 'better-sqlite3';
import { Stream, StreamType } from '../types';
import { Catalogue, CatalogueStore } from './catalogue';
import { searchableSql } from './channelNames';
import { foldText } from './guideSearch';
import { CatalogueSource } from './source';
import {
  namesWithAny,
  namesWithEvery,
  STREAM_NAMES_FILL,
  STREAM_NAMES_RETIRE,
  STREAM_NAMES_SETUP,
  STREAMS_NAMED,
  UPSERT_STREAM
} from './streamNames';

/**
 * The name index the Android catalogue (CapacitorCatalogueStore) looks titles
 * up in, on a real SQLite: the web's sql.js, which the frontend's tests run
 * on, has no FTS5.
 */
describe('stream_words', () => {
  const open = () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE streams (
      provider TEXT NOT NULL, type TEXT NOT NULL, category_id TEXT NOT NULL, stream_id TEXT NOT NULL,
      name TEXT NOT NULL, stream_icon TEXT, epg_channel_id TEXT, added TEXT, num INTEGER,
      container_extension TEXT, tv_archive INTEGER, tv_archive_duration INTEGER, extra TEXT,
      PRIMARY KEY (provider, type, stream_id))`);
    const write = (id: string, name: string, type = 'vod') =>
      db.prepare(UPSERT_STREAM).run('me', type, '1', id, name, null, null, null, null, null, null, null, null);
    const read = (query: string) =>
      db
        .prepare(`SELECT streams.stream_id ${STREAMS_NAMED} AND streams.provider = ? ORDER BY streams.name`)
        .all(query, 'me')
        .map(row => (row as { stream_id: string }).stream_id);
    const found = (words: string[], type = 'vod') => read(namesWithAny(type, words));
    return { db, write, found, read };
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

  it('finds every word in the library asked about only, whole when short', () => {
    const { db, write, read } = open();
    db.exec(STREAM_NAMES_SETUP);
    write('1', 'EN - Blade Runner 2 (1982)');
    write('2', 'Blade Runner 2049 (2017)');
    write('3', 'Blade Runner (1982)', 'series');

    expect(read(namesWithEvery('vod', ['blade', 'run']))).toEqual(['2', '1']);
    expect(read(namesWithEvery('vod', ['blade', '2']))).toEqual(['1']);
    expect(read(namesWithEvery('series', ['blade']))).toEqual(['3']);
  });

  it('finds a word typed as one that the name writes as two or three', () => {
    const { db, write, read } = open();
    db.exec(STREAM_NAMES_SETUP);
    write('1', 'X-Men: Apocalypse (2016)');
    write('2', "Ocean's Eleven");
    write('3', 'R.I.P.D. (2013)');

    expect(read(namesWithEvery('vod', ['xmen', 'apoca'], true))).toEqual(['1']);
    expect(read(namesWithEvery('vod', ['oceans'], true))).toEqual(['2']);
    expect(read(namesWithEvery('vod', ['rip'], true))).toEqual(['3']);
    expect(read(namesWithEvery('vod', ['xmen']))).toEqual([]);
  });

  it('folds đ, which FTS5 leaves alone, and the accents it takes off itself', () => {
    const { db, write, read } = open();
    db.exec(STREAM_NAMES_SETUP);
    write('1', 'Đuro i prijatelji');
    write('2', 'Mačak u čizmama');

    expect(read(namesWithEvery('vod', ['duro']))).toEqual(['1']);
    expect(read(namesWithEvery('vod', ['macak', 'cizmama']))).toEqual(['2']);
  });

  it('replaces the index without the type: its triggers at once, its table when retired', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE streams (provider TEXT, type TEXT, category_id TEXT, stream_id TEXT, name TEXT);
      CREATE VIRTUAL TABLE stream_names USING fts5(name, content='', contentless_delete=1);
      CREATE TABLE stream_names_filled (id INTEGER PRIMARY KEY, upto INTEGER, done INTEGER);
      CREATE TRIGGER stream_names_insert AFTER INSERT ON streams BEGIN INSERT INTO stream_names (rowid, name) VALUES (new.rowid, new.name); END;`);
    db.exec(STREAM_NAMES_SETUP);
    db.exec("INSERT INTO streams VALUES ('me', 'vod', '1', '1', 'Heat')");
    db.exec(STREAM_NAMES_RETIRE);

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'stream_names%'").all()).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n ${STREAMS_NAMED}`).get(namesWithEvery('vod', ['heat']))).toEqual({ n: 1 });
  });
});

/**
 * Search through the word index finds what search through LIKE over every
 * name found (the store before it), on names that are hard on a tokenizer.
 */
describe('search through stream_words', () => {
  const NAMES = [
    'X-Men: Apocalypse (2016)', 'XMen Origins', 'Spider-Man: No Way Home', "Ocean's Eleven", 'HR| HRT 2 ⱽᴵᴾ ᴿᴬᵂ',
    'Hrt 1 HD', 'Čuvar plaže', 'Mačak u čizmama', 'Đuro i prijatelji', 'Međunarodni dan', 'EN - Blade Runner (1982)',
    'The Office (US)', 'Star Wars: A New Hope', 'R.I.P.D. (2013)', 'WALL·E', '9-1-1', 'BBC One', 'Abbey Road', 'Blade 2'
  ];
  const QUERIES = [
    'xmen', 'x men', 'x-men apoca', 'x-men apocalipse', 'spiderman', 'spider man', 'oceans', 'ocean', 'hrt 2', '2 hrt',
    'čuvar', 'cuvar', 'mačak', 'macak', 'đuro', 'duro', 'medunarodni', 'međunarodni', 'blade', 'blade 2', 'the office',
    'theoffice', 'starwars', 'ripd', 'r i p d', 'wall', 'walle', '911', 'bbc', 'abbey', 'rip', 'uvar', 'run'
  ];

  const searchWith = (indexed: boolean) => {
    const db = new Database(':memory:');
    db.function('fold', { deterministic: true }, (value: unknown) => foldText(String(value)));
    db.exec(`CREATE TABLE streams (provider TEXT, type TEXT, category_id TEXT, stream_id TEXT, name TEXT, stream_icon TEXT,
      epg_channel_id TEXT, added TEXT, num INTEGER, container_extension TEXT, tv_archive INTEGER, tv_archive_duration INTEGER,
      extra TEXT, PRIMARY KEY (provider, type, stream_id))`);
    db.exec(STREAM_NAMES_SETUP);
    NAMES.forEach((name, index) =>
      db.prepare(UPSERT_STREAM).run('me', 'vod', '1', String(index), name, null, null, null, null, null, null, null, null)
    );
    const liked = (words: string[], joined: boolean) =>
      words.map(() => `${joined ? searchableSql('fold(name)') : 'fold(name)'} LIKE ?`).join(' AND ');
    const store = {
      findStreams: async (type: StreamType, words: string[], limit: number, joined = false) =>
        (indexed
          ? db.prepare(`SELECT streams.* ${STREAMS_NAMED} AND streams.provider = 'me' LIMIT ?`).all(namesWithEvery(type, words, joined), limit)
          : db
              .prepare(`SELECT * FROM streams WHERE type = ? AND ${liked(words, joined)} LIMIT ?`)
              .all(type, ...words.map(word => `%${word}%`), limit)) as Stream[]
    } as unknown as CatalogueStore;
    const catalogue = new Catalogue({} as CatalogueSource, store);
    return async (query: string) => (await catalogue.search('vod', query)).map(stream => stream.name).sort();
  };

  it.each(QUERIES)('finds for "%s" what LIKE does', async query => {
    expect(await searchWith(true)(query)).toEqual(await searchWith(false)(query));
  });

  it('finds a name whatever accents it was typed with', async () => {
    const search = searchWith(true);
    expect(await search('cuvar')).toEqual(['Čuvar plaže']);
    expect(await search('čuvar')).toEqual(['Čuvar plaže']);
    expect(await search('duro')).toEqual(['Đuro i prijatelji']);
    expect(await search('xmen apoca')).toEqual(['X-Men: Apocalypse (2016)']);
  });
});
