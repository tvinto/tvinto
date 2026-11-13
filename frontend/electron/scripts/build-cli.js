#!/usr/bin/env node
/**
 * Builds tvinto (../../cli) for the desktop app to carry.
 *
 *   node scripts/build-cli.js
 *
 * electron-builder copies cli/dist/tvinto.js and the credential store's
 * native module from cli/node_modules into the app (electron-builder.config.js),
 * so both have to be there first. Installs cli's packages only when they are
 * missing -- `npm ci` would empty a folder somebody is using -- and refuses to
 * go on when what the app needs is not there afterwards, so an installer
 * without tvinto is never made quietly.
 */

const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

const cli = path.resolve(__dirname, '..', '..', '..', 'cli');
const npm = (args) => {
  // npm is a .cmd on Windows, which Node starts only through a shell; the
  // arguments are this script's own.
  const result = spawnSync(`npm ${args.join(' ')}`, { cwd: cli, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`npm ${args.join(' ')} failed in ${cli}`);
    process.exit(result.status || 1);
  }
};

const needed = [
  'node_modules/esbuild',
  'node_modules/@napi-rs/keyring',
  `node_modules/@napi-rs/keyring-${process.platform}-${process.arch}-msvc`
];

if (!needed.every(file => existsSync(path.join(cli, file)))) {
  npm(['install', '--no-audit', '--no-fund']);
}
npm(['run', 'build']);

for (const file of ['dist/tvinto.js', ...needed.slice(1)]) {
  if (!existsSync(path.join(cli, file))) {
    console.error(`cli/${file} is missing, and the desktop app would ship without tvinto.`);
    process.exit(1);
  }
}
console.info('tvinto built for the desktop app.');
