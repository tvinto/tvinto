import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SERVER_FILES } from './serverFiles.generated';
import { Fetch } from './service';

/**
 * `tvinto server init`: a sync service of one's own on one's own Cloudflare
 * account, the same one the "Deploy to Cloudflare" button makes
 * (server/README.md), from a terminal.
 *
 * It writes the service into a folder and runs `wrangler`, Cloudflare's own
 * tool, there, with the person at the terminal: wrangler signs in to
 * Cloudflare in the browser and keeps its own login. tvinto never sees a
 * Cloudflare token. Run again in the same folder,
 * it brings the service up to the version this tvinto carries.
 *
 * The one secret it makes, ACCOUNT_SALT_SECRET, goes straight to wrangler and
 * is neither shown nor kept.
 */

/** Runs a program in a folder; `input`, if given, is its stdin, and nothing is echoed. */
export type Runner = (
  command: string,
  args: string[],
  options: { cwd: string; input?: string }
) => Promise<{ code: number; output: string }>;

/** The wrangler server/ was built and tested with, and no other. */
export const WRANGLER = 'wrangler@4.127.1';

const wrangler = (run: Runner, cwd: string, args: string[], input?: string) => run('npx', ['--yes', WRANGLER, ...args], { cwd, input });

export interface ServerInitDeps {
  run: Runner;
  fetch: Fetch;
  write(text: string): void;
}

/** What is already in the folder: nothing, a service this made before, or something else. */
const whatIsIn = (folder: string): 'empty' | 'ours' | 'other' => {
  if (!fs.existsSync(folder) || fs.readdirSync(folder).length === 0) {
    return 'empty';
  }
  try {
    const config = JSON.parse(fs.readFileSync(path.join(folder, 'wrangler.json'), 'utf8')) as { main?: string };
    return config.main === 'src/worker.js' && fs.existsSync(path.join(folder, 'src', 'worker.js')) ? 'ours' : 'other';
  } catch {
    return 'other';
  }
};

/**
 * Writes the service's files. Once deployed, wrangler.json is wrangler's: it
 * wrote the new database's id into it, and the person may have changed the
 * name or registration there. So an update leaves it as it is.
 */
const writeFiles = (folder: string, update: boolean): void => {
  for (const [name, text] of Object.entries(SERVER_FILES)) {
    if (update && name === 'wrangler.json') {
      continue;
    }
    const target = path.join(folder, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
};

/** The service's address, from what `wrangler deploy` said. */
const addressIn = (output: string): string | null => /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(output)?.[0] ?? null;

const must = (step: string, result: { code: number }): void => {
  if (result.code !== 0) {
    throw new Error(`${step} did not finish (wrangler said why, above). Run tvinto server init again once that is sorted.`);
  }
};

export async function serverInit(folderArg: string | undefined, deps: ServerInitDeps): Promise<number> {
  const folder = path.resolve(folderArg || 'tvinto-server');
  const found = whatIsIn(folder);
  if (found === 'other') {
    throw new Error(`${folder} already holds something else. Give tvinto server init an empty folder, or the one it made before.`);
  }
  const update = found === 'ours';

  writeFiles(folder, update);
  deps.write(update ? `Updated the service in ${folder}.\n` : `Wrote the service to ${folder}.\n`);

  // Signed in to Cloudflare? wrangler keeps its own login; this only asks it.
  const who = await wrangler(deps.run, folder, ['whoami']);
  if (who.code !== 0 || /not authenticated|not logged in/i.test(who.output)) {
    deps.write('Signing in to Cloudflare: wrangler opens it in your browser.\n');
    must('Signing in to Cloudflare', await wrangler(deps.run, folder, ['login']));
  }

  let address: string | null;
  if (update) {
    // Tables before the code that needs them.
    must('Bringing the database up to date', await wrangler(deps.run, folder, ['d1', 'migrations', 'apply', 'DB', '--remote']));
    const deployed = await wrangler(deps.run, folder, ['deploy']);
    must('Deploying', deployed);
    address = addressIn(deployed.output);
  } else {
    // The first deploy makes the database (wrangler writes its id into
    // wrangler.json); its tables and the secret follow at once.
    const deployed = await wrangler(deps.run, folder, ['deploy']);
    must('Deploying', deployed);
    address = addressIn(deployed.output);
    must('Making the database', await wrangler(deps.run, folder, ['d1', 'migrations', 'apply', 'DB', '--remote']));
    must('Setting its secret', await wrangler(deps.run, folder, ['secret', 'put', 'ACCOUNT_SALT_SECRET'], crypto.randomBytes(32).toString('hex')));
  }

  if (!address) {
    deps.write('Deployed. Its address is in what wrangler printed above, ending in workers.dev.\n');
    return 0;
  }
  let registration = '';
  try {
    const health = (await (await deps.fetch(`${address}/api/health`)).json()) as { data?: { registration?: string } };
    registration = health.data?.registration ?? '';
  } catch {
    // A brand-new Worker can take a few seconds to answer everywhere.
  }
  deps.write(
    [
      '',
      `Your sync service: ${address}`,
      'In the Tvinto app, on the sign-in page: Server, Change, then that address.',
      registration === 'open' ? 'The first account made there needs no invite code; everyone after it does.' : '',
      'Descriptions and subtitles need keys of your own: README.md in that folder says where they go.',
      ''
    ]
      .filter((line, index, lines) => line !== '' || index === 0 || index === lines.length - 1)
      .join('\n')
  );
  return 0;
}
