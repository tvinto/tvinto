import { Stream } from '@shared/types';
import { CapacitorCatalogueStore } from './capacitorCatalogueStore';

describe('CapacitorCatalogueStore.writeStreams', () => {
  const stream = (id: number) => ({ stream_id: String(id), name: `Film ${id}` }) as unknown as Stream;

  it('writes a large category in pieces, so a read waits for one piece and not the whole of it', async () => {
    const written: number[] = [];
    const db = {
      executeSet: async (set: Array<{ values: unknown[][] }>) => {
        written.push(set[0].values.length);
        return { changes: { changes: set[0].values.length } };
      }
    };
    const store = new CapacitorCatalogueStore(db as never, 'provider');

    await store.writeStreams('vod', '7', Array.from({ length: 600 }, (_, i) => stream(i)));

    expect(written).toEqual([250, 250, 100]);
  });
});

describe('CapacitorCatalogueStore searches', () => {
  type Rows = { values: Record<string, unknown>[] };
  interface SqlJs {
    exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  }

  /** The store on a real SQLite (sql.js, which the web build's plugin already ships). */
  const open = async () => {
    const module = 'sql.js/dist/sql-asm.js';
    const initSqlJs = ((await import(module)) as { default: () => Promise<{ Database: new () => SqlJs }> }).default;
    const sqlite = new (await initSqlJs()).Database();
    const query = async (sql: string, params: unknown[] = []): Promise<Rows> => {
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
    const store = new CapacitorCatalogueStore(db as never, 'provider');
    await store.initialise();
    return { store, query };
  };

  const film = (id: number, name: string) => ({ stream_id: String(id), name }) as unknown as Stream;

  it('finds a word in any case, through the name index rather than a seek per film', async () => {
    const { store, query } = await open();
    await store.writeStreams('vod', '1', [film(1, 'EN| The MATRIX (1999)'), film(2, 'Heat (1995)')]);

    expect((await store.findStreams('vod', ['matrix'], 10)).map(found => found.stream_id)).toEqual(['1']);
    expect((await store.findStreamsWithAny!('vod', ['heat', 'matrix'], 10)).map(found => found.stream_id)).toEqual(['1', '2']);

    const plan = await query(
      "EXPLAIN QUERY PLAN SELECT stream_id FROM streams WHERE provider = ? AND type = ? AND name LIKE ? ORDER BY name LIMIT 10",
      ['provider', 'vod', '%matrix%']
    );
    const steps = plan.values.map(step => String(step['detail'])).join(' | ');
    expect(steps).toContain('idx_streams_name');
    expect(steps).not.toContain('TEMP B-TREE');
  });
});
