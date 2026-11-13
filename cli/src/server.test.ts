import fs from 'fs';
import os from 'os';
import path from 'path';
import { run } from './cli';
import { Runner, WRANGLER, serverInit, serverTmdbKey } from './server';
import { TMDB_KEY_EXAMPLES } from '../../shared/tmdb/key';
import { SERVER_FILES } from './serverFiles.generated';
import { MemoryStore } from './store';

/** `tvinto server init`, with wrangler stood in for: what it is asked, in what order. */

const ADDRESS = 'https://tvinto-sync.someone.workers.dev';

const made: string[] = [];
const tempFolder = () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tvinto-server-'));
  made.push(folder);
  return folder;
};
afterAll(() => made.forEach(folder => fs.rmSync(folder, { recursive: true, force: true })));

/** A wrangler that answers as a signed-in one does, recording every call. */
const fakeWrangler = (signedIn = true) => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const runner: Runner = async (command, args, options) => {
    expect(command).toBe('npx');
    expect(args.slice(0, 2)).toEqual(['--yes', WRANGLER]);
    const rest = args.slice(2);
    calls.push({ args: rest, input: options.input });
    if (rest[0] === 'whoami') {
      return { code: 0, output: signedIn ? 'You are logged in with an OAuth Token' : 'You are not authenticated. Please run `wrangler login`.' };
    }
    if (rest[0] === 'deploy') {
      return { code: 0, output: `Uploaded tvinto-sync\nDeployed tvinto-sync triggers\n  ${ADDRESS}\n` };
    }
    return { code: 0, output: '' };
  };
  return { calls, runner };
};

const health = (async () => ({ json: async () => ({ data: { registration: 'open' } }) })) as never;

describe('tvinto server init', () => {
  it('writes the service, deploys it, makes its tables and sets its secret, in that order', async () => {
    const folder = tempFolder();
    const { calls, runner } = fakeWrangler();
    let printed = '';

    expect(await serverInit(folder, { run: runner, fetch: health, write: text => (printed += text) })).toBe(0);

    for (const [name, text] of Object.entries(SERVER_FILES)) {
      expect(fs.readFileSync(path.join(folder, ...name.split('/')), 'utf8')).toBe(text);
    }
    expect(calls.map(call => call.args.join(' '))).toEqual([
      'whoami',
      'deploy',
      'd1 migrations apply DB --remote',
      'secret put ACCOUNT_SALT_SECRET'
    ]);
    expect(printed).toContain(`Your sync service: ${ADDRESS}`);
    expect(printed).toContain('needs no invite code');
  });

  it('hands the secret to wrangler only, never to the screen', async () => {
    const { calls, runner } = fakeWrangler();
    let printed = '';

    await serverInit(tempFolder(), { run: runner, fetch: health, write: text => (printed += text) });

    const secret = calls.find(call => call.args[0] === 'secret')?.input ?? '';
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(printed).not.toContain(secret);
  });

  it('has wrangler sign in to Cloudflare when it is not', async () => {
    const { calls, runner } = fakeWrangler(false);

    await serverInit(tempFolder(), { run: runner, fetch: health, write: () => undefined });

    expect(calls.map(call => call.args[0])).toEqual(['whoami', 'login', 'deploy', 'd1', 'secret']);
  });

  it('updates a service it made before: tables first, then the code, and its own settings kept', async () => {
    const folder = tempFolder();
    await serverInit(folder, { run: fakeWrangler().runner, fetch: health, write: () => undefined });
    // What wrangler and the person did to the settings after the first deploy.
    const settings = path.join(folder, 'wrangler.json');
    const changed = fs.readFileSync(settings, 'utf8').replace('"database_name": "tvinto"', '"database_name": "tvinto", "database_id": "kept"');
    fs.writeFileSync(settings, changed);
    fs.writeFileSync(path.join(folder, 'src', 'worker.js'), '// an older version');

    const { calls, runner } = fakeWrangler();
    let printed = '';
    await serverInit(folder, { run: runner, fetch: health, write: text => (printed += text) });

    expect(calls.map(call => call.args.join(' '))).toEqual(['whoami', 'd1 migrations apply DB --remote', 'deploy']);
    expect(fs.readFileSync(settings, 'utf8')).toBe(changed);
    expect(fs.readFileSync(path.join(folder, 'src', 'worker.js'), 'utf8')).toBe(SERVER_FILES['src/worker.js']);
    expect(printed).toContain('Updated the service');
  });

  it('will not write over a folder that holds something else', async () => {
    const folder = tempFolder();
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'mine');
    const { calls, runner } = fakeWrangler();

    await expect(serverInit(folder, { run: runner, fetch: health, write: () => undefined })).rejects.toThrow('already holds something else');
    expect(calls).toEqual([]);
    expect(fs.readdirSync(folder)).toEqual(['notes.txt']);
  });

  it('stops at a step wrangler could not finish', async () => {
    const { runner } = fakeWrangler();
    const failing: Runner = async (command, args, options) =>
      args.includes('deploy') ? { code: 1, output: 'Authentication error' } : runner(command, args, options);

    await expect(serverInit(tempFolder(), { run: failing, fetch: health, write: () => undefined })).rejects.toThrow('Deploying did not finish');
  });

  it('is for a person at a terminal, never through an agent', async () => {
    let printed = '';
    const code = await run(['server', 'init'], {
      fetch: health,
      store: new MemoryStore(),
      hostname: 'test',
      terminal: { isTTY: false, ask: async () => '', askHidden: async () => '' },
      run: fakeWrangler().runner,
      write: text => (printed += text)
    });

    expect(code).toBe(1);
    expect(printed).toContain('run by a person, at a terminal');
  });
});

/** A made-up key of the right shape. Never a real one, and TMDB is never called. */
const KEY = TMDB_KEY_EXAMPLES.apiKey;

/** TMDB stood in for: takes KEY, refuses anything else, and records what it was asked. */
const fakeTmdb = () => {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    const taken = new URL(url).searchParams.get('api_key') === KEY;
    return { ok: taken, status: taken ? 200 : 401, json: async () => (taken ? { images: {} } : { status_message: 'Invalid API key' }) };
  }) as never;
  return { asked, fetch };
};

describe('tvinto server tmdb-key', () => {
  const madeService = async () => {
    const folder = tempFolder();
    await serverInit(folder, { run: fakeWrangler().runner, fetch: health, write: () => undefined });
    return folder;
  };

  it('checks the key with TMDB, then gives it to wrangler as TMDB_API_KEY, never to the screen', async () => {
    const folder = await madeService();
    const { calls, runner } = fakeWrangler();
    const tmdb = fakeTmdb();
    let printed = '';

    const code = await serverTmdbKey(folder, { run: runner, fetch: tmdb.fetch, write: text => (printed += text), askKey: async () => `  "${KEY}"\n` });

    expect(code).toBe(0);
    expect(tmdb.asked).toHaveLength(1);
    expect(calls).toEqual([{ args: ['secret', 'put', 'TMDB_API_KEY'], input: KEY }]);
    expect(printed).toContain('TMDB key set');
    expect(printed).not.toContain(KEY);
  });

  it("refuses what is neither of TMDB's values without asking TMDB or wrangler", async () => {
    const folder = await madeService();
    const { calls, runner } = fakeWrangler();
    const tmdb = fakeTmdb();

    await expect(serverTmdbKey(folder, { run: runner, fetch: tmdb.fetch, write: () => undefined, askKey: async () => '12345' })).rejects.toThrow(
      "neither of TMDB's two values"
    );
    expect(tmdb.asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('sets nothing when TMDB refuses the key', async () => {
    const folder = await madeService();
    const { calls, runner } = fakeWrangler();

    await expect(
      serverTmdbKey(folder, { run: runner, fetch: fakeTmdb().fetch, write: () => undefined, askKey: async () => 'b'.repeat(32) })
    ).rejects.toThrow('TMDB did not accept that key');
    expect(calls).toEqual([]);
  });

  it('wants the folder tvinto server init made', async () => {
    await expect(
      serverTmdbKey(tempFolder(), { run: fakeWrangler().runner, fetch: fakeTmdb().fetch, write: () => undefined, askKey: async () => KEY })
    ).rejects.toThrow('holds no service');
  });
});
