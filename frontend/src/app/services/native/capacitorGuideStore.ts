import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import {
  ChannelRef,
  GuideChannel,
  GuideHit,
  GuideLoadSummary,
  GuideProgramme,
  GuideStore,
  GuideTotals,
  KnownChannel
} from '@shared/xtream/guide';
import { likePattern, titleMatches } from '@shared/xtream/guideSearch';
import { whenRunningOut } from '@shared/xtream/guideReload';
import {
  GUIDE_TITLES_FILL,
  GUIDE_TITLES_FILLED,
  GUIDE_TITLES_PIECE,
  GUIDE_TITLES_PROGRESS,
  GUIDE_TITLES_SETUP,
  PROGRAMMES_TITLED,
  titlesHolding
} from '@shared/xtream/guideTitles';
import { untilIdleWork } from '../../utils/library-refresh.utils';

/** Guide channels per read (`allChannels`). */
const CHANNELS_PER_READ = 500;

/** Programmes per write (`writeProgrammes`). */
const WRITE_PIECE_PROGRAMMES = 100;

/** Rows of guide_programmes looked through per DELETE of a previous load (`finishLoad`). */
export const DELETE_PIECE_ROWS = 25000;

/**
 * The device's own guide, in SQLite on the phone.
 *
 * The counterpart to MemoryGuideStore on the desktop: same interface, same
 * policy above it, a driver that survives a restart underneath. Which matters
 * more for a guide than it does for a catalogue -- a catalogue refills one
 * category at a time as you browse, while a guide is one large download, and
 * paying for it again at every launch is exactly what a phone should not do.
 *
 * Nothing here is per-subscription. A guide describes channels by their own
 * ids, and the same feed is the same feed whichever line is used to watch it;
 * what ties a guide channel to a stream is the mapping, which lives with the
 * account.
 */
export class CapacitorGuideStore implements GuideStore {
  constructor(private readonly db: SQLiteDBConnection) {}

  async initialise(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS guide_channels (
        source_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (source_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS guide_programmes (
        source_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        start INTEGER NOT NULL,
        stop INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT,
        PRIMARY KEY (source_id, channel_id, start)
      );

      -- Every read is "what is on these channels around now", so the index
      -- that matters is channel and time together. Without it, drawing one
      -- screen of guide scans every programme in the database.
      CREATE INDEX IF NOT EXISTS idx_guide_programmes_window
        ON guide_programmes(channel_id, start, stop);

      -- Separate from the rows, so a load that was interrupted leaves no
      -- readable guide behind: the rows are there and this is not.
      CREATE TABLE IF NOT EXISTS guide_loads (
        source_id TEXT PRIMARY KEY,
        loaded_at TEXT NOT NULL
      );
    `);

    // Added after the tables existed, so a device that already has them keeps
    // its guide rather than being asked to download everything again.
    await ensureColumns(this.db, [
      ['guide_loads', 'channels', 'INTEGER'],
      ['guide_loads', 'programmes', 'INTEGER'],
      // Which load wrote a row, so a reload can leave the previous guide in
      // place until it has finished. Null on rows from before, which the next
      // finished load of their source removes.
      ['guide_channels', 'generation', 'TEXT'],
      ['guide_programmes', 'generation', 'TEXT']
    ]);

    try {
      await this.db.execute(GUIDE_TITLES_SETUP);
    } catch {
      // No FTS5 here (the web's sql.js): titles are looked for with LIKE.
      return;
    }
    void this.indexTitles().catch(() => undefined);
  }

  /** Whether `guide_titles` indexes every programme held (shared/xtream/guideTitles.ts). */
  private titlesIndexed = false;

  /**
   * Indexes the titles held before the index existed, a piece per call and
   * only while nobody uses the app, as `CapacitorCatalogueStore.indexNames`
   * does names. The triggers index whatever is written meanwhile; a guide
   * first loaded with the index has nothing to fill.
   */
  private async indexTitles(): Promise<void> {
    const filled = (await this.db.query(GUIDE_TITLES_FILLED)).values?.[0];
    let upto = Number(filled?.['upto'] ?? 0);
    if (!filled?.['done']) {
      const last = Number((await this.db.query('SELECT MAX(rowid) AS last FROM guide_programmes')).values?.[0]?.['last'] ?? 0);
      for (; upto < last; upto += GUIDE_TITLES_PIECE) {
        await untilIdleWork();
        await this.db.run(GUIDE_TITLES_FILL, [upto, upto + GUIDE_TITLES_PIECE]);
        await this.db.run(GUIDE_TITLES_PROGRESS, [upto + GUIDE_TITLES_PIECE, 0]);
      }
      await this.db.run(GUIDE_TITLES_PROGRESS, [upto, 1]);
    }
    this.titlesIndexed = true;
  }

  /** The load each source is in the middle of, if any. */
  private readonly generations = new Map<string, string>();

  /**
   * Starts a load, leaving the previous guide in place.
   *
   * It used to delete the source here, before a byte had arrived, so a phone
   * whose download dropped mid-way was left with no guide at all rather than
   * yesterday's. Rows are tagged with this load now and `finishLoad` removes
   * the ones that are not; `guide_loads` is left alone, so a source that has
   * never finished a load is still invisible and one being reloaded is not.
   */
  async beginLoad(sourceId: string): Promise<void> {
    this.generations.set(
      sourceId,
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    );
  }

  async writeChannels(sourceId: string, channels: GuideChannel[]): Promise<void> {
    this.channelsHeld = null;
    if (!channels.length) {
      return;
    }

    await this.db.executeSet([
      {
        statement:
          'INSERT OR REPLACE INTO guide_channels (source_id, channel_id, name, generation) ' +
          'VALUES (?, ?, ?, ?)',
        values: channels.map(channel => [
          sourceId,
          channel.id,
          channel.name,
          this.generations.get(sourceId) ?? null
        ])
      }
    ]);
    this.channelsHeld = null;
  }

  async writeProgrammes(sourceId: string, programmes: GuideProgramme[]): Promise<void> {
    if (!programmes.length) {
      return;
    }

    const rows = programmes.map(programme => [
      sourceId,
      programme.channel,
      programme.start,
      programme.stop,
      programme.title,
      programme.description,
      programme.category,
      this.generations.get(sourceId) ?? null
    ]);
    // In pieces, each its own call: a parsed batch of 200 held the database
    // up to 0.8 s on a user's TV during a first load (27 November).
    for (let at = 0; at < rows.length; at += WRITE_PIECE_PROGRAMMES) {
      await this.db.executeSet([
        {
          // An upsert rather than INSERT OR REPLACE, so a programme written
          // again keeps its row: a replaced row is deleted without its delete
          // triggers, and guide_titles kept every old title of every reload.
          statement:
            'INSERT INTO guide_programmes ' +
            '(source_id, channel_id, start, stop, title, description, category, generation) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT (source_id, channel_id, start) DO UPDATE SET stop = excluded.stop, title = excluded.title, ' +
            'description = excluded.description, category = excluded.category, generation = excluded.generation',
          values: rows.slice(at, at + WRITE_PIECE_PROGRAMMES)
        }
      ]);
    }
  }

  async finishLoad(sourceId: string, at: string, totals?: GuideTotals): Promise<void> {
    const generation = this.generations.get(sourceId) ?? null;
    this.generations.delete(sourceId);
    this.channelsHeld = null;

    // `IS NOT` rather than `!=`, which is never true against a null and would
    // keep every row from before generations existed, forever.
    //
    // `run`, not `executeSet`. The plugin runs a DELETE handed to `executeSet`
    // with bound values and reports zero changes, while the same statement
    // through `run` deletes -- checked on the TV emulator against a scratch
    // table, 13 September. So from the day generations arrived until then, no
    // Android load ever removed the one before it: programmes whose times had
    // moved stayed beside their replacements, and a reload killed half way
    // left its rows for good. Channels hid it by being rewritten in full on
    // every load. Inserts through `executeSet` are unaffected.
    //
    // `+source_id` keeps SQLite on the rowid range (`deleteProgrammesWhere`):
    // with no statistics in the file it chose the primary key by source
    // instead, and so read every programme of the source for each slice (12
    // slices of 0.5 to 2 s on a user's TV).
    await this.deleteProgrammesWhere('+source_id = ? AND generation IS NOT ?', [sourceId, generation]);
    await this.db.run(
      'DELETE FROM guide_channels WHERE source_id = ? AND generation IS NOT ?',
      [sourceId, generation]
    );
    await this.db.executeSet([
      {
        statement:
          'INSERT OR REPLACE INTO guide_loads (source_id, loaded_at, channels, programmes) ' +
          'VALUES (?, ?, ?, ?)',
        values: [[sourceId, at, totals?.channels ?? null, totals?.programmes ?? null]]
      }
    ]);
    // Again: a read that began while this ran holds the channels from before.
    this.channelsHeld = null;
  }

  async lastLoadedAt(sourceId: string): Promise<string | null> {
    const result = await this.db.query(
      'SELECT loaded_at FROM guide_loads WHERE source_id = ?',
      [sourceId]
    );
    return (result.values?.[0]?.['loaded_at'] as string) ?? null;
  }

  /**
   * Each channel's last programme, in one aggregate over this source's rows.
   *
   * The primary key leads with source_id and channel_id, so SQLite reads only
   * this source's range, in channel order, rather than every guide on the
   * device -- the same rows the single MAX it replaces read. It is asked when
   * the app starts and every few hours, not per screen.
   */
  async runsOutAt(sourceId: string): Promise<number | null> {
    const result = await this.db.query(
      'SELECT MAX(stop) AS last_stop FROM guide_programmes WHERE source_id = ? GROUP BY channel_id',
      [sourceId]
    );
    const stops = (result.values ?? [])
      .map(row => row['last_stop'])
      .filter((value): value is number => typeof value === 'number');
    const loaded = Date.parse((await this.lastLoadedAt(sourceId)) ?? '');
    return whenRunningOut(stops, Number.isFinite(loaded) ? loaded : null);
  }

  async loadSummary(sourceId: string): Promise<GuideLoadSummary | null> {
    const result = await this.db.query(
      'SELECT loaded_at, channels, programmes FROM guide_loads WHERE source_id = ?',
      [sourceId]
    );

    const row = result.values?.[0];
    if (!row) {
      return null;
    }

    return {
      loadedAt: row['loaded_at'] as string,
      // Null for a guide loaded before the counts were kept; zero reads as
      // "empty", which is a different and wronger claim, but there is nothing
      // better to say without loading it again.
      channels: (row['channels'] as number) ?? 0,
      programmes: (row['programmes'] as number) ?? 0
    };
  }

  async channels(sourceId: string): Promise<GuideChannel[]> {
    const result = await this.db.query(
      'SELECT channel_id, name FROM guide_channels WHERE source_id = ? ORDER BY name',
      [sourceId]
    );

    return (result.values ?? []).map(row => ({
      id: row['channel_id'] as string,
      name: row['name'] as string
    }));
  }

  /**
   * Every channel from every finished load.
   *
   * Joined against the loads for the same reason the programmes are: a source
   * part-way through loading should not contribute channels that the matching
   * would then find no programmes for.
   */
  async allChannels(): Promise<KnownChannel[]> {
    this.channelsHeld ??= this.readAllChannels().catch(error => {
      this.channelsHeld = null;
      throw error;
    });
    return [...(await this.channelsHeld)];
  }

  /** What `allChannels` read, until channels are written or a load finishes. */
  private channelsHeld: Promise<KnownChannel[]> | null = null;

  /**
   * A page of rows a call: a TV's 5,652 channels in one read held the
   * database 1.4 s, nearly all of it the plugin carrying them (27 November).
   */
  private async readAllChannels(): Promise<KnownChannel[]> {
    const channels: KnownChannel[] = [];
    for (let after = 0; ; ) {
      // Not DISTINCT on the channel: the same channel in two sources is two
      // answers, and which guide to take it from is the person's choice.
      const result = await this.db.query(
        `SELECT c.rowid AS at, c.source_id, c.channel_id, c.name
           FROM guide_channels c
           JOIN guide_loads l ON l.source_id = c.source_id
          WHERE c.rowid > ?
          ORDER BY c.rowid
          LIMIT ${CHANNELS_PER_READ}`,
        [after]
      );
      const rows = result.values ?? [];
      for (const row of rows) {
        channels.push({ id: row['channel_id'] as string, name: row['name'] as string, sourceId: row['source_id'] as string });
      }
      if (rows.length < CHANNELS_PER_READ) {
        break;
      }
      after = Number(rows[rows.length - 1]['at']);
    }
    // As ORDER BY name had them: by SQLite's binary order, not the locale's.
    return channels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Programmes overlapping the window.
   *
   * `start < to AND stop > from` rather than a containment test: the programme
   * on now started before the window did, and asking what is on at this moment
   * would otherwise come back empty.
   *
   * Joined against the finished loads so a half-written guide stays invisible.
   */
  async programmesFor(refs: ChannelRef[], from: number, to: number): Promise<GuideProgramme[]> {
    if (!refs.length) {
      return [];
    }

    // Source and channel together. Matching on channel alone returns the same
    // row from every guide that describes it, which draws two schedules on top
    // of one another.
    const pairs = refs.map(() => '(p.source_id = ? AND p.channel_id = ?)').join(' OR ');
    const values = refs.flatMap(ref => [ref.sourceId, ref.channelId]);

    const result = await this.db.query(
      `SELECT p.channel_id, p.start, p.stop, p.title, p.description, p.category
         FROM guide_programmes p
         JOIN guide_loads l ON l.source_id = p.source_id
        WHERE (${pairs})
          AND p.start < ? AND p.stop > ?
        ORDER BY p.start`,
      [...values, to, from]
    );

    return (result.values ?? []).map(row => ({
      channel: row['channel_id'] as string,
      start: row['start'] as number,
      stop: row['stop'] as number,
      title: row['title'] as string,
      description: (row['description'] as string) ?? '',
      category: (row['category'] as string) ?? ''
    }));
  }

  /**
   * Titles found through the trigram index (shared/xtream/guideTitles.ts), or
   * with LIKE over every row in the window until it is filled, and then
   * checked properly in code, since neither folds exactly as guideSearch.ts
   * does. Asked for more than the limit, for what the check turns away.
   */
  async searchProgrammes(query: string, from: number, to: number, limit: number): Promise<GuideHit[]> {
    const result = this.titlesIndexed
      ? await this.db.query(PROGRAMMES_TITLED, [titlesHolding(query), from, to, limit * 4])
      : await this.db.query(
          `SELECT p.source_id, p.channel_id, p.start, p.stop, p.title, p.description, p.category
             FROM guide_programmes p
             JOIN guide_loads l ON l.source_id = p.source_id
            WHERE p.stop > ? AND p.start < ?
              AND p.title LIKE ? ESCAPE '\\'
            ORDER BY p.start
            LIMIT ?`,
          [from, to, likePattern(query), limit * 4]
        );

    const seen = new Set<string>();
    const found: GuideHit[] = [];
    for (const row of result.values ?? []) {
      const hit: GuideHit = {
        sourceId: row['source_id'] as string,
        channel: row['channel_id'] as string,
        start: row['start'] as number,
        stop: row['stop'] as number,
        title: row['title'] as string,
        description: (row['description'] as string) ?? '',
        category: (row['category'] as string) ?? ''
      };
      // A guide being reloaded holds its old rows beside the new until it
      // finishes; one programme, once.
      const key = `${hit.sourceId} ${hit.channel} ${hit.start}`;
      if (!titleMatches(hit.title, query) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      found.push(hit);
      if (found.length >= limit) {
        break;
      }
    }
    return found;
  }

  async prune(before: number): Promise<void> {
    await this.deleteProgrammesWhere('stop < ?', [before]);
  }

  /**
   * Deletes the programmes meeting `condition` a slice of rowids at a time,
   * each its own call: one DELETE reads every programme held, which held the
   * database 1.6 to 1.9 s on a user's TV (275,000 programmes, 27 November).
   */
  private async deleteProgrammesWhere(condition: string, values: unknown[]): Promise<void> {
    const last = Number((await this.db.query('SELECT MAX(rowid) AS last FROM guide_programmes')).values?.[0]?.['last'] ?? 0);
    for (let from = 0; from < last; from += DELETE_PIECE_ROWS) {
      await this.db.run(
        `DELETE FROM guide_programmes WHERE rowid > ? AND rowid <= ? AND ${condition}`,
        [from, from + DELETE_PIECE_ROWS, ...values]
      );
    }
  }

  /** Throws the lot away, for a sign-out. */
  async forget(): Promise<void> {
    this.channelsHeld = null;
    await this.db.execute(`
      DELETE FROM guide_loads;
      DELETE FROM guide_channels;
      DELETE FROM guide_programmes;
    `);
  }
}


/** A column a table must have: table, column, SQL type. */
export type RequiredColumn = readonly [table: string, column: string, type: string];

/** How many times to try adding a column before saying so. */
const ALTER_ATTEMPTS = 4;
const ALTER_RETRY_MS = 250;

/**
 * Adds the columns a table is missing, and fails loudly if one cannot be added.
 *
 * This used to issue each ALTER TABLE and swallow any error, taking "duplicate
 * column" as the only way one could fail. A phone upgraded from 1.0.1 came back
 * with `generation` on guide_channels and not on guide_programmes -- the second
 * ALTER had failed for some other reason, most likely the catalogue store
 * reading on the same connection at that moment, which SQLite refuses an ALTER
 * over -- and every guide load after that died on its first insert. So: ask the
 * table what it has, add only what is missing, try again if that fails, and
 * throw if the column is still not there.
 */
export async function ensureColumns(
  db: Pick<SQLiteDBConnection, 'query' | 'execute'>,
  required: readonly RequiredColumn[]
): Promise<void> {
  for (const [table, column, type] of required) {
    for (let attempt = 1; !(await hasColumn(db, table, column)); attempt++) {
      try {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, false);
      } catch (error) {
        if (await hasColumn(db, table, column)) {
          break;
        }
        if (attempt >= ALTER_ATTEMPTS) {
          throw new Error(`Could not add ${column} to ${table}: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise(resolve => setTimeout(resolve, ALTER_RETRY_MS));
      }
    }
  }
}

async function hasColumn(
  db: Pick<SQLiteDBConnection, 'query'>,
  table: string,
  column: string
): Promise<boolean> {
  const result = await db.query(`SELECT name FROM pragma_table_info('${table}')`);
  return (result.values ?? []).some(row => row.name === column);
}
