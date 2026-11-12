import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { D1Database, D1PreparedStatement, D1Result } from '../d1';

/**
 * D1, as far as this service uses it, over a real SQLite database.
 *
 * D1 *is* SQLite, so the SQL under test is the SQL that will run. What this
 * cannot reproduce is the network and the limits -- so the one limit that
 * shapes the code, fifty queries per request, is counted here instead, and
 * asserted on directly. A budget nobody measures is a budget nobody keeps.
 *
 * The alternative was `wrangler dev` and `@cloudflare/vitest-pool-workers`,
 * which would mean a second test runner and a hundred megabytes of runtime to
 * exercise handlers that are, in the end, functions taking a Request.
 */

export interface TestD1 extends D1Database {
  /** How many statements have been run, which is what the budget is in. */
  readonly queries: number;
  resetQueryCount(): void;
  raw: Database.Database;
  close(): void;
}

const SCHEMA = path.resolve(__dirname, '../../schema.sql');

class Statement implements D1PreparedStatement {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly sql: string,
    private readonly values: unknown[],
    private readonly counted: () => void
  ) {}

  /** A new statement rather than a mutated one, as D1 does. */
  bind(...values: unknown[]): D1PreparedStatement {
    return new Statement(this.sqlite, this.sql, values, this.counted);
  }

  async first<T>(): Promise<T | null> {
    this.counted();
    return (this.sqlite.prepare(this.sql).get(...(this.values as never[])) as T) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    this.counted();
    return {
      results: this.sqlite.prepare(this.sql).all(...(this.values as never[])) as T[],
      success: true,
      meta: {}
    };
  }

  async run(): Promise<D1Result> {
    this.counted();
    return this.execute();
  }

  /** Used by `batch`, which has already counted and is inside a transaction. */
  executeUncounted(): D1Result {
    return this.execute();
  }

  private execute(): D1Result {
    const prepared = this.sqlite.prepare(this.sql);

    // A statement with RETURNING gives rows back, and better-sqlite3 refuses
    // run() for those where D1 does not mind either way.
    if (prepared.reader) {
      return {
        results: prepared.all(...(this.values as never[])) as unknown[],
        success: true,
        meta: {}
      };
    }

    const result = prepared.run(...(this.values as never[]));
    return {
      results: [],
      success: true,
      meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) }
    };
  }
}

export const openTestD1 = (): TestD1 => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(fs.readFileSync(SCHEMA, 'utf8'));

  let queries = 0;
  const counted = () => {
    queries += 1;
  };

  const database: TestD1 = {
    prepare: (sql: string) => new Statement(sqlite, sql, [], counted),

    batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      // Each statement counts, because on D1 each one does. This is the number
      // the fifty-per-request limit is measured in.
      queries += statements.length;

      const run = sqlite.transaction(() =>
        statements.map(statement => (statement as Statement).executeUncounted() as D1Result<T>)
      );

      return run();
    },

    get queries() {
      return queries;
    },

    resetQueryCount() {
      queries = 0;
    },

    raw: sqlite,
    close: () => sqlite.close()
  };

  return database;
};
