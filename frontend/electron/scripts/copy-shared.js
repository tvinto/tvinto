// Copies the files the main process shares with the apps from shared/ into
// src/shared/, because this build's rootDir cannot reach outside the folder.
// Run it after changing shared/errorReports.ts; electron/src/sharedCopies.spec.ts
// fails while a copy differs.
const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const FILES = ['errorReports.ts'];
const HEADER = '// Copied from shared/ by scripts/copy-shared.js. Change it there, then run that.\n';

const from = join(__dirname, '..', '..', '..', 'shared');
const to = join(__dirname, '..', 'src', 'shared');
mkdirSync(to, { recursive: true });
for (const file of FILES) {
  writeFileSync(join(to, file), HEADER + readFileSync(join(from, file), 'utf8'));
  console.info(`src/shared/${file}: copied`);
}

module.exports = { FILES, HEADER };
