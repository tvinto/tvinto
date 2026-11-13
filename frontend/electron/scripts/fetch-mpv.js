#!/usr/bin/env node
/**
 * Puts mpv where the packaged app will look for it.
 *
 *   node scripts/fetch-mpv.js
 *
 * The desktop build exists because Chromium has no HEVC decoder unless Windows
 * supplies one, and a great many of this provider's films are 4K HEVC. mpv
 * carries its own decoders, so it plays them on a machine with nothing
 * installed -- but only if it is *there*, and until now it was found on the
 * PATH or in Program Files, which is fine for running from source and useless
 * for an installer somebody downloads.
 *
 * 115 MB of binary, so it is not in the repository. This is how a clone gets
 * one, and why it is a script rather than a line in a README: the version is
 * pinned and the download is checked against a hash written down here. A build
 * tool that fetches an executable over the network and runs it unverified is
 * not a build tool anybody should trust.
 */

const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} = require('fs');
const { tmpdir } = require('os');
const { join, resolve } = require('path');

/**
 * The build, pinned.
 *
 * shinchiro's builds are what mpv's own site points Windows users to, and what
 * the `shinchiro.mpv` winget package installs. Pinned rather than "latest"
 * because a release that changes underneath a build is a build that cannot be
 * repeated -- and because the hashes below would then be wrong every day.
 *
 * shinchiro keeps only about thirty days of releases. The previous pin,
 * 20260903, was deleted by 13 November and this script answered 404, so a pin
 * here goes stale within a month: move it forward (both hashes) before an
 * `electron:make`, or keep a copy of the archive somewhere of the project's own.
 */
const RELEASE = '20261111';
const BASE = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${RELEASE}`;

const APP = resolve(__dirname, '..');

/**
 * What comes from where, and what must come back: each archive and the one
 * file taken out of it are checked against these before anything is unpacked
 * or run.
 *
 * - mpv.exe, mpv in a window of its own: the player as it was, and the
 *   fallback when tvinto-player cannot start.
 * - libmpv-2.dll, from the same build's `mpv-dev` archive: the same mpv as a
 *   library, which tvinto-player (native/, scripts/build-player.js) draws
 *   into the app's window with.
 *
 * Both land in `resources/mpv/`, which is what a build from source finds --
 * see `findMpv` in src/player.ts -- and what electron-builder copies into the
 * packaged app's own resources directory.
 */
const PIECES = [
  {
    archive: `mpv-x86_64-${RELEASE}-git-bcde6b93cc.7z`,
    archiveSha256: 'f259b5fd4b5c395617c948a4fadcdf55bba1c5282fb7c13e88626b3f71072baf',
    file: 'mpv.exe',
    fileSha256: '3ea89fe7a4284b25dff3c72e1bde83e27324c90cfc4a074fe679293d19ee7c85'
  },
  {
    archive: `mpv-dev-x86_64-${RELEASE}-git-bcde6b93cc.7z`,
    archiveSha256: '273c079b11ea5575822f972756f4c9a71149a5c10130353abeb8586738938452',
    file: 'libmpv-2.dll',
    fileSha256: '88504ee5560942a955405e99dfb5971368e4cf851321f36565bf2a667271db1b'
  }
];

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

const die = message => {
  console.error(`
  ${message}
`);
  process.exit(1);
};

const fetchPiece = async ({ archive: name, archiveSha256, file, fileSha256 }) => {
  const target = join(APP, 'resources', 'mpv', file);
  if (existsSync(target) && sha256(target) === fileSha256) {
    console.log(`
  ${file} from mpv ${RELEASE} is already in place.`);
    return;
  }

  console.log(`
  Fetching ${name}`);

  const response = await fetch(`${BASE}/${name}`);
  if (!response.ok) {
    die(`The download answered ${response.status}.`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'xtream-mpv-'));
  const archive = join(scratch, name);

  try {
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

    const got = sha256(archive);
    if (got !== archiveSha256) {
      // Before it is unpacked, and long before it is run. This is the only
      // thing standing between "somebody replaced that file" and an installer
      // that ships whatever they replaced it with.
      die(`That is not the archive this expects.
  wanted ${archiveSha256}
  got    ${got}`);
    }

    // Windows' own tar is libarchive, which reads 7z. Named explicitly because
    // in a Git Bash shell `tar` is GNU tar, which does not.
    const bsdtar = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe');

    const unpacked = spawnSync(bsdtar, ['-xf', archive, '-C', scratch, file], {
      stdio: 'inherit'
    });

    if (unpacked.error || unpacked.status !== 0) {
      die(`Could not unpack it: ${unpacked.error ? unpacked.error.message : unpacked.status}`);
    }

    const extracted = join(scratch, file);
    if (sha256(extracted) !== fileSha256) {
      die(`The ${file} inside the archive is not the one this expects.`);
    }

    mkdirSync(join(APP, 'resources', 'mpv'), { recursive: true });
    copyFileSync(extracted, target);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`  ${(statSync(target).size / 1048576).toFixed(0)} MB in resources/mpv/${file}`);
};

const main = async () => {
  for (const piece of PIECES) {
    await fetchPiece(piece);
  }
  console.log('');
};

main().catch(error => die(error.message));
