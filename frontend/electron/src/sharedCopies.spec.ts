import { readFileSync } from 'fs';
import { join } from 'path';

// The main process carries copies of a few shared/ files (scripts/copy-shared.js).
// A copy that drifted would clean reports differently from the apps.
const HEADER = '// Copied from shared/ by scripts/copy-shared.js. Change it there, then run that.\n';

describe('copies of shared/', () => {
  it.each(['errorReports.ts'])('src/shared/%s is shared/%s as it is now', file => {
    const original = readFileSync(join(__dirname, '..', '..', '..', 'shared', file), 'utf8');
    const copy = readFileSync(join(__dirname, 'shared', file), 'utf8');
    expect(copy).toBe(HEADER + original);
  });
});
