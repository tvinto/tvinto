#!/usr/bin/env node
/**
 * Publishes tvinto to npm, so that `npx tvinto` works without the source.
 *
 *   npm run publish:cli            # builds, tests, and shows what would be sent
 *   npm run publish:cli -- --yes   # the same, then really publishes
 *
 * Without --yes it ends at `npm publish --dry-run`: the list of files and the
 * size, nothing sent. Each step stops the run when it fails, so nothing is
 * published that did not build, pass its tests and type-check.
 *
 * The tests run in the backend's Jest (backend/package.json), which finds no
 * tests under a folder whose name starts with a dot -- run this from a
 * checkout, not a worktree under .claude.
 */

const { spawnSync } = require('child_process');
const { copyFileSync } = require('fs');
const path = require('path');

const cli = path.resolve(__dirname, '..');
const root = path.resolve(cli, '..');
const backend = path.join(root, 'backend');
const really = process.argv.includes('--yes');

const step = (title, command, cwd) => {
  console.info(`\n== ${title}\n   ${command}`);
  // A shell for npm and npx, which are .cmd files on Windows; the commands
  // are this script's own.
  const result = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\nStopped: ${title} failed. Nothing was published.`);
    process.exit(result.status || 1);
  }
};

step('Build', 'npm run build', cli);
// Patterns, matched against the path with either separator: cli/src, shared.
step('Tests', 'npx jest cli.src shared', backend);
step('Types', `${path.join('node_modules', '.bin', 'tsc')} -p ${path.join('..', 'cli')}`, backend);
// npm puts a LICENSE beside package.json in the package; the repository has
// one, at its root.
copyFileSync(path.join(root, 'LICENSE'), path.join(cli, 'LICENSE'));
step(really ? 'Publish' : 'Publish (dry run)', really ? 'npm publish' : 'npm publish --dry-run', cli);

if (!really) {
  console.info('\nNothing was sent. To publish this: npm run publish:cli -- --yes');
}
