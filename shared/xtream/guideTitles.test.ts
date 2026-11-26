import Database from 'better-sqlite3';
import { titleMatches } from './guideSearch';
import { GUIDE_TITLES_FILL, GUIDE_TITLES_SETUP, PROGRAMMES_TITLED, titlesHolding } from './guideTitles';

/**
 * The title index the Android guide (CapacitorGuideStore) searches, on a real
 * SQLite: the web's sql.js, which the frontend's tests run on, has no FTS5.
 */
describe('guide_titles', () => {
  const open = () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE guide_programmes (source_id TEXT NOT NULL, channel_id TEXT NOT NULL, start INTEGER NOT NULL,
      stop INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, category TEXT, generation TEXT,
      PRIMARY KEY (source_id, channel_id, start));
      CREATE TABLE guide_loads (source_id TEXT PRIMARY KEY, loaded_at TEXT NOT NULL);
      INSERT INTO guide_loads VALUES ('s', 'now');`);
    let start = 0;
    const write = (title: string, channel = 'c', source = 's') =>
      db
        .prepare('INSERT OR REPLACE INTO guide_programmes (source_id, channel_id, start, stop, title) VALUES (?, ?, ?, ?, ?)')
        .run(source, channel, (start += 10), start + 5, title);
    const found = (query: string, limit = 100) =>
      (db.prepare(PROGRAMMES_TITLED).all(titlesHolding(query), 0, 1e9, limit) as { title: string }[]).map(row => row.title);
    return { db, write, found };
  };

  it('finds a run of letters anywhere in a title, accents and case aside, in finished loads only', () => {
    const { db, write, found } = open();
    db.exec(GUIDE_TITLES_SETUP);
    write('Dnevnik 2');
    write('HRT: DNEVNIK');
    write('Šport uživo');
    write('Đir po Hrvatskoj');
    write('Dnevnik', 'c', 'unfinished');

    expect(found('dnevnik')).toEqual(['Dnevnik 2', 'HRT: DNEVNIK']);
    expect(found('nik 2')).toEqual(['Dnevnik 2']);
    expect(found('sport UŽIVO')).toEqual(['Šport uživo']);
    expect(found('đir')).toEqual(['Đir po Hrvatskoj']);
    expect(found('dir po')).toEqual(['Đir po Hrvatskoj']);
    expect(found('say "x" or')).toEqual([]);
  });

  it('keeps up with programmes replaced and removed, and is filled for a guide held before it', () => {
    const { db, write, found } = open();
    write('Vijesti');
    write('Kronika');
    db.exec(GUIDE_TITLES_SETUP);
    expect(found('vijesti')).toEqual([]);

    db.prepare(GUIDE_TITLES_FILL).run(0, 1);
    db.prepare(GUIDE_TITLES_FILL).run(1, 2);
    expect(found('vijesti')).toEqual(['Vijesti']);

    const upsert = db.prepare(
      'INSERT INTO guide_programmes (source_id, channel_id, start, stop, title) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (source_id, channel_id, start) DO UPDATE SET stop = excluded.stop, title = excluded.title'
    );
    upsert.run('s', 'c', 10, 15, 'Vijesti u 5');
    upsert.run('s', 'c', 20, 25, 'Kronika');
    db.exec("DELETE FROM guide_programmes WHERE title = 'Kronika'");

    expect(found('vijesti')).toEqual(['Vijesti u 5']);
    expect(db.prepare(PROGRAMMES_TITLED).all('"vijesti"', 0, 1e9, 10)).toHaveLength(1);
    expect(found('kronika')).toEqual([]);
  });

  it('finds every title titleMatches does', () => {
    const { db, write, found } = open();
    db.exec(GUIDE_TITLES_SETUP);
    const titles = ['Dnevnik', 'Šport', 'Đir', 'Međunarodni dan', 'NOVA: Vijesti', 'Ljubav na selu', 'Čarobnjak iz Oza', 'Go! Go!', 'C.S.I.: Miami'];
    titles.forEach(title => write(title));

    for (const query of ['dnevnik', 'sport', 'šport', 'dir', 'međun', 'medun', 'vijesti', 'nova: v', 'selu', 'carobnjak', 'go!', 'c.s.i', 'miami', 'iz oza']) {
      const wanted = titles.filter(title => titleMatches(title, query)).sort();
      expect([query, found(query).filter(title => titleMatches(title, query)).sort()]).toEqual([query, wanted]);
    }
  });
});
