/**
 * tvinto end to end against a sync service on this machine (`wrangler dev
 * --local --port 8787`), with the real network and the operating system's
 * credential store -- what the Jest tests stand in for.
 *
 * Makes a throwaway account with a generated password and a made-up
 * provider, signs the CLI in through a stand-in terminal (there is no TTY
 * here), runs every reading command, and signs out. Never against the hosted
 * service, and never with a real provider: see CLAUDE.md.
 *
 *   TVINTO_HOME=<empty folder> npx tsx cli/e2e-local.ts
 */
import crypto from 'crypto';
import os from 'os';
import { CURRENT_KDF, SALT_BYTES, deriveAccountKeys, toBase64 } from '../shared/auth/accountKeys';
import { seal } from '../shared/auth/secretBox';
import { run } from './src/cli';
import { nodeKdf } from './src/nodeKdf';
import { KeyringStore, entryName, readConfig } from './src/store';

const SERVER = 'http://127.0.0.1:8787';
const API = `${SERVER}/api`;
const NOW = new Date().toISOString();

const post = async (path: string, body: unknown, token?: string) => {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  const answer = (await response.json()) as { data?: { token?: string }; message?: string };
  if (!response.ok) {
    throw new Error(`${path}: ${response.status} ${answer.message}`);
  }
  return answer.data;
};

async function main(): Promise<void> {
  if (!process.env['TVINTO_HOME']) {
    throw new Error('Set TVINTO_HOME to an empty folder');
  }
  const username = `tvinto-e2e-${crypto.randomBytes(3).toString('hex')}`;
  const password = crypto.randomBytes(18).toString('base64url');
  const salt = crypto.randomBytes(SALT_BYTES);
  const { auth, enc } = await deriveAccountKeys(password, salt, CURRENT_KDF, nodeKdf);
  const registered = await post('/accounts/register', {
    username,
    keys: { salt: toBase64(salt), ...CURRENT_KDF, auth: toBase64(auth) }
  });
  const token = registered!.token!;

  // A made-up provider on a reserved name (.test), and a guide with a
  // password in its address, as a real Xtream guide has.
  await post(
    '/accounts/providers',
    {
      id: 'e2e-1',
      active: true,
      payload: await seal(
        JSON.stringify({ kind: 'xtream', tag: '', enabled: true, label: 'Made-up provider', serverUrl: 'http://made-up.test:8080', username: 'e2e-user', password: 'e2e-pass' }),
        enc
      )
    },
    token
  );
  await post(
    '/devices/changes',
    {
      guideSources: [
        {
          id: 'g1',
          payload: await seal(JSON.stringify({ label: 'Made-up guide', url: 'http://made-up.test:8080/xmltv.php?username=e2e-user&password=e2e-pass', enabled: true, addedAt: NOW }), enc),
          updatedAt: NOW
        }
      ],
      settings: [{ key: 'hiddenCategories', value: JSON.stringify({ live: ['1', '2'], vod: [], series: [] }), updatedAt: NOW }]
    },
    token
  );

  const store = new KeyringStore();
  let printed = '';
  const deps = {
    fetch: (url: string, init?: RequestInit) => fetch(url, init),
    store,
    terminal: { isTTY: true, ask: async () => username, askHidden: async () => password },
    hostname: os.hostname(),
    write: (text: string) => {
      printed += text;
      process.stdout.write(text);
    }
  };

  const step = async (argv: string[]) => {
    process.stdout.write(`\n$ tvinto ${argv.join(' ')}\n`);
    const code = await run(argv, deps);
    if (code !== 0) {
      throw new Error(`tvinto ${argv.join(' ')} exited ${code}`);
    }
  };

  await step(['sign-in', '--server', SERVER]);
  const config = readConfig()!;
  console.log(`\n[credential store holds an entry for ${entryName(config)}: ${(await store.get(entryName(config))) !== null}]`);

  for (const command of ['status', 'providers', 'guides', 'settings', 'family']) {
    await step([command]);
  }

  const listed = await fetch(`${API}/accounts/tools`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`\n[the account's own device lists: ${JSON.stringify(((await listed.json()) as { data: { tools: unknown } }).data.tools)}]`);

  for (const secret of ['e2e-user', 'e2e-pass', 'made-up.test:8080', password]) {
    if (printed.includes(secret)) {
      throw new Error('A secret was printed');
    }
  }
  console.log('[nothing secret was printed]');

  // Left signed in for the bundled binary to read next; it signs out.
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
