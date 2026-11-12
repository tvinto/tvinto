// Builds server/, the sync service as anybody can deploy it with the
// "Deploy to Cloudflare" button (server/README.md).
//
// The button deploys one folder on its own, and worker/ is not on its own:
// it imports the sync protocol, the sealing and the family rules from
// ../shared. So server/src/worker.js is worker/ with those bundled in,
// unminified, and worker/ stays the only place the service is written.
// A test (worker/src/server.test.ts) fails when the two have drifted.
//
//   node worker/scripts/build-server.mjs
import { build } from 'esbuild';
import { existsSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(worker, '..', 'server');

/** What esbuild is asked, here and by the test that checks the bundle. */
export const bundleOptions = {
  entryPoints: [join(worker, 'src', 'index.ts')],
  // The paths in its comments are from here, wherever it is run from.
  absWorkingDir: worker,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // As wrangler resolves for a Worker.
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['browser', 'module', 'main'],
  external: ['cloudflare:*', 'node:*'],
  legalComments: 'none',
  banner: {
    js: '// Generated from worker/ by worker/scripts/build-server.mjs.\n// Do not edit: change worker/ and build again.'
  }
};

/** The files `tvinto server init` writes, besides the migrations. */
const SERVER_FILES = ['wrangler.json', 'package.json', '.gitignore', 'README.md', 'src/worker.js'];

const CLI_FILES = join(worker, '..', 'cli', 'src', 'serverFiles.generated.ts');

/** server/ for the CLI, as one TypeScript file: `tvinto server init` carries it wherever it runs. */
const cliFiles = () => {
  const migrations = readdirSync(join(server, 'migrations'))
    .filter(name => /^\d{4}_.*\.sql$/.test(name))
    .sort();
  const files = Object.fromEntries(
    [...SERVER_FILES, ...migrations.map(name => `migrations/${name}`)].map(path => [path, readFileSync(join(server, path), 'utf8')])
  );
  return `// Generated from server/ by worker/scripts/build-server.mjs. Do not edit.\n\nexport const SERVER_FILES: Readonly<Record<string, string>> = ${JSON.stringify(files, null, 2)};\n`;
};

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--check')) {
  // Whether server/src/worker.js is what worker/ builds to now, and the
  // CLI's copy is what server/ holds: exit 1 if not.
  const built = await build({ ...bundleOptions, write: false, outfile: join(server, 'src', 'worker.js') });
  const current = readFileSync(join(server, 'src', 'worker.js'), 'utf8');
  const same = built.outputFiles[0].text === current && existsSync(CLI_FILES) && readFileSync(CLI_FILES, 'utf8') === cliFiles();
  console.log(same ? 'server/ is up to date' : 'server/ is out of date: node worker/scripts/build-server.mjs');
  process.exit(same ? 0 : 1);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(server, 'src'), { recursive: true });
  await build({ ...bundleOptions, outfile: join(server, 'src', 'worker.js') });

  // The first migration is the whole schema as it stood when server/ began,
  // and is never rewritten: D1 records a migration as applied by its name, so
  // a changed 0001 would never reach a database that already ran it. A later
  // change to schema.sql goes in as the next numbered file, by hand.
  mkdirSync(join(server, 'migrations'), { recursive: true });
  const first = join(server, 'migrations', '0001_schema.sql');
  if (!existsSync(first)) {
    copyFileSync(join(worker, 'schema.sql'), first);
  }
  writeFileSync(CLI_FILES, cliFiles());
  console.log('server/ built');
}
