import fs from 'fs';
import path from 'path';

/**
 * Guards the source files against having their encoding mangled.
 *
 * This has now happened twice, both times from a tool rather than from code:
 * reading a UTF-8 file as though it were a single-byte encoding and writing it
 * back turns each two-byte character into two wrong ones. PowerShell's
 * Get-Content/Set-Content pair does it silently, and so does anything else
 * that guesses at an encoding.
 *
 * It matters here more than in most projects. Much of what this app displays
 * is Croatian, the tests proving the guide decodes correctly are written in
 * Croatian, and a mangled *test* passes against mangled *code* -- so the
 * damage can hide behind a green suite.
 *
 * The examples are described rather than written out, because a file
 * containing them cannot be checked by the rule it is explaining, as this test
 * discovered by failing against itself twice.
 */

const REPOSITORY = path.resolve(__dirname, '../../..');

const SEARCHED = ['shared', 'backend/src', 'frontend/src', 'worker/src'];

const SKIPPED = new Set(['node_modules', 'dist', 'build', '.angular', 'coverage', 'www']);

const EXTENSIONS = new Set(['.ts', '.js', '.html', '.scss', '.json', '.md']);

/**
 * The signature of UTF-8 misread as a single-byte encoding.
 *
 * A multi-byte character begins with a byte that Latin-1 renders as one of
 * C2-C5 or E2, and is followed by another byte outside ASCII.
 *
 * Built from escapes rather than from the characters themselves: a pattern
 * spelled out in the bytes it hunts for matches the file that defines it.
 */
const MOJIBAKE = new RegExp('[\\u00C2-\\u00C5\\u00E2][\\u0080-\\u00FF]');

/**
 * One deliberate exception.
 *
 * shared/xtream/epg.ts explains the bug it exists to prevent by showing a
 * mangled character beside its correct form, which is worth more there than
 * anywhere else: it is the file whose whole job is not producing them.
 */
const ALLOWED = new Set([path.join('shared', 'xtream', 'epg.ts')]);

const sourceFiles = (directory: string): string[] => {
  const absolute = path.join(REPOSITORY, directory);
  if (!fs.existsSync(absolute)) {
    return [];
  }

  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) {
        continue;
      }

      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (EXTENSIONS.has(path.extname(entry.name))) {
        found.push(full);
      }
    }
  };

  walk(absolute);
  return found;
};

describe('source file encoding', () => {
  const files = SEARCHED.flatMap(sourceFiles);

  it('finds files to check, so a passing run means something', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no file whose UTF-8 was read as something else', () => {
    const damaged: string[] = [];

    for (const file of files) {
      const relative = path.relative(REPOSITORY, file);
      if (ALLOWED.has(relative)) {
        continue;
      }

      const contents = fs.readFileSync(file, 'utf8');
      const match = MOJIBAKE.exec(contents);
      if (match) {
        const line = contents.slice(0, match.index).split('\n').length;
        damaged.push(`${relative}:${line}`);
      }
    }

    expect(damaged).toEqual([]);
  });

  /**
   * The other way a tool can quietly change what a file says.
   *
   * A NUL byte is invisible in every editor and does not stop TypeScript
   * compiling: inside a string it is simply a character nobody can see. Two of
   * them had landed where spaces belonged inside template literals, which is
   * the worst place for it -- ``${kind} ${key}`` and ``${kind}<NUL>${key}``
   * build different keys from the same-looking source, so a lookup misses and
   * a tombstone silently stops matching the thing it was meant to bury.
   *
   * Nothing legitimate in this repository has one, so the rule is simply that
   * there are none.
   */
  it('has no file with a NUL byte hiding in it', () => {
    const damaged: string[] = [];

    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8');
      const at = contents.indexOf(String.fromCharCode(0));

      if (at !== -1) {
        const line = contents.slice(0, at).split('\n').length;
        damaged.push(`${path.relative(REPOSITORY, file)}:${line}`);
      }
    }

    expect(damaged).toEqual([]);
  });
});
