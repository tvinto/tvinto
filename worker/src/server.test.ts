import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

/**
 * server/, the folder the "Deploy to Cloudflare" button deploys, kept from
 * drifting away from worker/ (worker/scripts/build-server.mjs).
 */

const ROOT = path.resolve(__dirname, '../..');

/** Every table's columns, and every index, as a database built this way has them. */
const shapeOf = (statements: string[]): Record<string, string[]> => {
  const db = new Database(':memory:');
  try {
    statements.forEach(sql => db.exec(sql));
    const shape: Record<string, string[]> = {};
    const things = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ type: string; name: string }>;
    for (const { type, name } of things) {
      shape[`${type} ${name}`] =
        type === 'table'
          ? (db.prepare(`SELECT name, type FROM pragma_table_info('${name}') ORDER BY name`).all() as Array<{ name: string; type: string }>).map(
              column => `${column.name} ${column.type}`
            )
          : [];
    }
    return shape;
  } finally {
    db.close();
  }
};

describe('server/', () => {
  it('runs the Worker as worker/ is now', () => {
    // Exits 1, with what to run, when server/src/worker.js is out of date.
    expect(() =>
      execFileSync(process.execPath, [path.join(ROOT, 'worker', 'scripts', 'build-server.mjs'), '--check'], { stdio: 'pipe' })
    ).not.toThrow();
  });

  it('makes, through its migrations in order, the database schema.sql makes', () => {
    const migrations = path.join(ROOT, 'server', 'migrations');
    const files = fs
      .readdirSync(migrations)
      .filter(name => /^\d{4}_.*\.sql$/.test(name))
      .sort();

    expect(files[0]).toBe('0001_schema.sql');
    expect(shapeOf(files.map(name => fs.readFileSync(path.join(migrations, name), 'utf8')))).toEqual(
      shapeOf([fs.readFileSync(path.join(ROOT, 'worker', 'schema.sql'), 'utf8')])
    );
  });
});
