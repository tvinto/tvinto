import { CapacitorGuideStore, DELETE_PIECE_ROWS, ensureColumns } from './capacitorGuideStore';

/** A connection that knows each table's columns, and can refuse ALTERs a number of times. */
function fakeDb(columns: Record<string, string[]>, refusals = 0) {
  const altered: string[] = [];
  let refused = 0;
  return {
    altered,
    query: async (sql: string) => {
      const table = /pragma_table_info\('(\w+)'\)/.exec(sql)?.[1] ?? '';
      return { values: (columns[table] ?? []).map(name => ({ name })) };
    },
    execute: async (sql: string) => {
      const [, table, column] = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(sql) ?? [];
      if (refused < refusals) {
        refused++;
        throw new Error('database table is locked');
      }
      altered.push(`${table}.${column}`);
      columns[table].push(column);
      return { changes: { changes: 0 } };
    }
  };
}

describe('ensureColumns', () => {
  it('adds only the columns a table is missing', async () => {
    const db = fakeDb({ guide_channels: ['source_id', 'generation'], guide_programmes: ['source_id'] });
    await ensureColumns(db as never, [
      ['guide_channels', 'generation', 'TEXT'],
      ['guide_programmes', 'generation', 'TEXT']
    ]);
    expect(db.altered).toEqual(['guide_programmes.generation']);
  });

  it('tries again when the ALTER is refused for a moment', async () => {
    const db = fakeDb({ guide_programmes: ['source_id'] }, 2);
    await ensureColumns(db as never, [['guide_programmes', 'generation', 'TEXT']]);
    expect(db.altered).toEqual(['guide_programmes.generation']);
  });

  it('says so when the column cannot be added at all', async () => {
    const db = fakeDb({ guide_programmes: ['source_id'] }, 99);
    await expect(ensureColumns(db as never, [['guide_programmes', 'generation', 'TEXT']])).rejects.toThrow(
      'Could not add generation to guide_programmes: database table is locked'
    );
  });
});

describe('CapacitorGuideStore writes in pieces', () => {
  /** Records the calls; the table's last rowid is `last`. */
  function recording(last: number) {
    const sets: number[] = [];
    const runs: unknown[][] = [];
    return {
      sets,
      runs,
      executeSet: async (set: { values: unknown[][] }[]) => {
        sets.push(set[0].values.length);
        return { changes: { changes: 0 } };
      },
      run: async (_sql: string, values: unknown[]) => {
        runs.push(values);
        return { changes: { changes: 0 } };
      },
      query: async () => ({ values: [{ last }] })
    };
  }

  it('writes programmes a hundred to a call', async () => {
    const db = recording(0);
    const programme = { channel: 'c', start: 0, stop: 1, title: 't', description: '', category: '' };
    await new CapacitorGuideStore(db as never).writeProgrammes('s', Array(250).fill(programme));
    expect(db.sets).toEqual([100, 100, 50]);
  });

  it('removes a previous load a slice of rows at a time, the slices covering every row', async () => {
    const db = recording(2 * DELETE_PIECE_ROWS + 1);
    const store = new CapacitorGuideStore(db as never);
    await store.beginLoad('s');
    await store.finishLoad('s', 'now');
    const slices = db.runs.filter(values => values.length === 4).map(([from, to]) => [from, to]);
    expect(slices).toEqual([
      [0, DELETE_PIECE_ROWS],
      [DELETE_PIECE_ROWS, 2 * DELETE_PIECE_ROWS],
      [2 * DELETE_PIECE_ROWS, 3 * DELETE_PIECE_ROWS]
    ]);
  });

  it('removes past programmes a slice of rows at a time', async () => {
    const db = recording(DELETE_PIECE_ROWS + 1);
    await new CapacitorGuideStore(db as never).prune(42);
    expect(db.runs).toEqual([
      [0, DELETE_PIECE_ROWS, 42],
      [DELETE_PIECE_ROWS, 2 * DELETE_PIECE_ROWS, 42]
    ]);
  });
});

describe('CapacitorGuideStore.searchProgrammes', () => {
  interface SqlJs {
    exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  }

  /** The store on a real SQLite (sql.js, which the web build's plugin already ships). */
  const open = async () => {
    const module = 'sql.js/dist/sql-asm.js';
    const initSqlJs = ((await import(module)) as { default: () => Promise<{ Database: new () => SqlJs }> }).default;
    const sqlite = new (await initSqlJs()).Database();
    const query = async (sql: string, params: unknown[] = []) => {
      const [result] = sqlite.exec(sql, params);
      return { values: (result?.values ?? []).map(row => Object.fromEntries(result.columns.map((column, i) => [column, row[i]]))) };
    };
    const db = {
      execute: async (sql: string) => (sqlite.exec(sql), { changes: { changes: 0 } }),
      query,
      run: async (sql: string, params: unknown[] = []) => (sqlite.exec(sql, params), { changes: { changes: 0 } }),
      executeSet: async (set: Array<{ statement: string; values: unknown[][] }>) => {
        for (const row of set[0].values) {
          sqlite.exec(set[0].statement, row);
        }
        return { changes: { changes: set[0].values.length } };
      }
    };
    const store = new CapacitorGuideStore(db as never);
    await store.initialise();
    return { store, query };
  };

  const programme = (channel: string, start: number, title: string) => ({ channel, start, stop: start + 30, title, description: 'x'.repeat(500), category: '' });

  it('finds titles with LIKE until the title index is filled, the earliest first, only in finished loads', async () => {
    const { store } = await open();
    await store.beginLoad('a');
    await store.writeProgrammes('a', [programme('1', 300, 'Dnevnik'), programme('2', 100, 'Šport uživo'), programme('1', 200, 'Dnevnik 2'), programme('1', 10, 'Dnevnik')]);
    await store.finishLoad('a', 'now');
    await store.beginLoad('b');
    await store.writeProgrammes('b', [programme('9', 150, 'Dnevnik')]);

    const found = await store.searchProgrammes('dnevnik', 60, 1000, 2);
    expect(found.map(hit => [hit.channel, hit.start, hit.title])).toEqual([
      ['1', 200, 'Dnevnik 2'],
      ['1', 300, 'Dnevnik']
    ]);
    expect((await store.searchProgrammes('sport', 0, 1000, 5)).map(hit => hit.title)).toEqual(['Šport uživo']);

  });
});

describe('CapacitorGuideStore.allChannels', () => {
  interface SqlJs {
    exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  }

  it('reads channels a page at a time, by name, and again once a load has changed them', async () => {
    const module = 'sql.js/dist/sql-asm.js';
    const initSqlJs = ((await import(module)) as { default: () => Promise<{ Database: new () => SqlJs }> }).default;
    const sqlite = new (await initSqlJs()).Database();
    const reads: string[] = [];
    const query = async (sql: string, params: unknown[] = []) => {
      reads.push(sql);
      const [result] = sqlite.exec(sql, params);
      return { values: (result?.values ?? []).map(row => Object.fromEntries(result.columns.map((column, i) => [column, row[i]]))) };
    };
    const db = {
      execute: async (sql: string) => (sqlite.exec(sql), { changes: { changes: 0 } }),
      query,
      run: async (sql: string, params: unknown[] = []) => (sqlite.exec(sql, params), { changes: { changes: 0 } }),
      executeSet: async (set: Array<{ statement: string; values: unknown[][] }>) => {
        for (const row of set[0].values) {
          sqlite.exec(set[0].statement, row);
        }
        return { changes: { changes: set[0].values.length } };
      }
    };
    const store = new CapacitorGuideStore(db as never);
    await store.initialise();
    await store.beginLoad('a');
    await store.writeChannels('a', Array.from({ length: 1200 }, (_, i) => ({ id: `c${i}`, name: `Channel ${String(1200 - i).padStart(4, '0')}` })));
    await store.finishLoad('a', 'now');

    const paged = (sql: string) => sql.includes('FROM guide_channels c');
    reads.length = 0;
    const channels = await store.allChannels();
    expect(channels).toHaveLength(1200);
    expect(channels[0]).toEqual({ id: 'c1199', name: 'Channel 0001', sourceId: 'a' });
    expect(reads.filter(paged)).toHaveLength(3);

    await store.allChannels();
    expect(reads.filter(paged)).toHaveLength(3);

    await store.beginLoad('a');
    await store.writeChannels('a', [{ id: 'new', name: 'New' }]);
    await store.finishLoad('a', 'later');
    expect((await store.allChannels()).map(channel => channel.id)).toEqual(['new']);
  });
});
