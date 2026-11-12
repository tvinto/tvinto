import fs from 'fs';
import os from 'os';
import path from 'path';

const PACKAGE_ROOT = path.resolve(__dirname, '../..');

/**
 * Loads config fresh with the given environment.
 *
 * dotenv is stubbed out: config.ts calls it at import time, so without this a
 * variable deleted here would be repopulated from whatever .env the developer
 * happens to have, and the test would be asserting against their machine.
 */
const loadConfigWith = async (env: Record<string, string | undefined>) => {
  const previous: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  let loaded!: typeof import('./config').config;
  await jest.isolateModulesAsync(async () => {
    jest.doMock('dotenv', () => ({ config: () => ({ parsed: {} }) }));
    ({ config: loaded } = await import('./config'));
  });

  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return loaded;
};

const resolvePath = async (databasePath: string | undefined) =>
  (await loadConfigWith({ DATABASE_PATH: databasePath })).database.path;

describe('database.path', () => {
  it('resolves a relative setting against the backend package', async () => {
    // Not the working directory: the same setting has to name the same file
    // whether the server is started from the package or the repository root.
    expect(await resolvePath('./data/cache.db')).toBe(path.join(PACKAGE_ROOT, 'data', 'cache.db'));
  });

  it('gives the same answer whatever the working directory is', async () => {
    const cwd = process.cwd();
    const fromPackage = await resolvePath('./cache.db');
    try {
      process.chdir(os.tmpdir());
      expect(await resolvePath('./cache.db')).toBe(fromPackage);
    } finally {
      process.chdir(cwd);
    }
  });

  it('honours an absolute setting as given', async () => {
    const absolute = path.join(os.tmpdir(), 'somewhere', 'cache.db');
    expect(await resolvePath(absolute)).toBe(absolute);
  });

  it('falls back to the cache file the app has always used', async () => {
    // The default must not move, or an existing install loses its cache.
    expect(await resolvePath(undefined)).toBe(path.join(PACKAGE_ROOT, 'xtream-cache.db'));
  });

  it('ignores a blank setting rather than resolving to the package directory', async () => {
    expect(await resolvePath('   ')).toBe(path.join(PACKAGE_ROOT, 'xtream-cache.db'));
  });

  it('creates the directory, since better-sqlite3 will not', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtream-cfg-'));
    const nested = path.join(dir, 'a', 'b');

    await resolvePath(path.join(nested, 'cache.db'));

    expect(fs.existsSync(nested)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('epgRefresh', () => {
  const enabledWith = async (value: string | undefined) =>
    (await loadConfigWith({ EPG_AUTO_REFRESH: value })).epgRefresh.enabled;

  it('is on by default and off only when explicitly disabled', async () => {
    expect(await enabledWith(undefined)).toBe(true);
    expect(await enabledWith('true')).toBe(true);
    expect(await enabledWith('false')).toBe(false);
    expect(await enabledWith('FALSE')).toBe(false);
  });
});

describe('the provider credentials that used to live here', () => {
  it('is not a thing the configuration has any more', async () => {
    // XTREAM_USERNAME and XTREAM_PASSWORD fed a field nothing outside this
    // test ever read, while a provider password sat in .env in plaintext. The
    // test is kept, pointed the other way, so that putting them back is a
    // decision somebody makes rather than one that slips in.
    const config = await loadConfigWith({ XTREAM_USERNAME: 'joe', XTREAM_PASSWORD: 'hunter2' });

    expect(config).not.toHaveProperty('xtreamCredentials');
    expect(JSON.stringify(config)).not.toContain('hunter2');
  });
});
