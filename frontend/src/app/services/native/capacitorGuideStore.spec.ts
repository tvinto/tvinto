import { ensureColumns } from './capacitorGuideStore';

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
