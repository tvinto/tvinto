// Writes src/config.js -- where this build finds its sync service -- before a
// build or `ng serve`.
//
// The address used to be written into src/config.js itself, which put one
// person's server into every copy of the code. Now src/config.js is made here
// and not committed: from config.local.json beside this package, if there is
// one (it is not committed either), else with no server at all. A build with
// no server asks for one at sign-in, and works without an account.
//
//   config.local.json   { "apiUrl": "https://sync.example.workers.dev/api",
//                         "updatesUrl": "https://sync.example.workers.dev/updates" }
//
//   "errorReportsDsn": "https://<key>@<org>.ingest.sentry.io/<project>"
//                       Official builds only: where error reports go
//                       (docs/error-reports.md). Without it this build sends
//                       none, so a fork or a build of one's own reports nothing.
//
// See config.example.json. Without `updatesUrl` the app updates from the
// project's releases on GitHub (feed.js, which the desktop build and the
// publish scripts read as well).
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { readLocal, updatesUrl } = require('./feed.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = readLocal();
const updates = updatesUrl(local);
const apiUrl = typeof local.apiUrl === 'string' && local.apiUrl.trim() ? local.apiUrl.trim() : null;

const dsn = typeof local.errorReportsDsn === 'string' && local.errorReportsDsn.trim() ? local.errorReportsDsn.trim() : null;
// The same test as shared/errorReports.ts isReportAddress: it is written into a script.
if (dsn && !/^https?:\/\/[A-Za-z0-9]+@[^\s/'"\\]+\/\d+$/.test(dsn)) {
  throw new Error('config.local.json: errorReportsDsn is not a Sentry DSN');
}
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (apiUrl && !/^https?:\/\/[^\s'"\\]+$/.test(apiUrl)) {
  throw new Error(`config.local.json: apiUrl is not an address: ${apiUrl}`);
}

const lines = [
  '// Where this copy of the app finds its sync service. Written by',
  '// scripts/write-config.mjs from config.local.json before each build; not',
  '// committed. A plain file beside the bundle, so it can be changed without a',
  '// rebuild: editing it takes effect on reload.',
  '//',
  apiUrl
    ? `window.__XTREAM_API_URL__ = '${apiUrl}';`
    : '// No sync service: the app works without an account, and asks for a server at sign-in.\n// window.__XTREAM_API_URL__ = \'https://sync.example.workers.dev/api\';',
  '// Where the Android app looks for new versions of itself.',
  `window.__TVINTO_UPDATES_URL__ = '${updates}';`,
  '// Where error reports go: official builds only (docs/error-reports.md).',
  dsn ? `window.__TVINTO_ERROR_REPORTS__ = '${dsn}';` : '// None: this build sends no error reports.',
  "// The web app's version, which error reports are grouped by.",
  `window.__TVINTO_VERSION__ = '${version}';`,
  ''
];
writeFileSync(join(root, 'src', 'config.js'), lines.join('\n'));
// Never the address itself: a log is no place for it.
console.info(`config.js: ${apiUrl ? 'the sync service from config.local.json' : 'no sync service'}; updates from ${updates}; error reports ${dsn ? 'on' : 'off (no address)'}`);
