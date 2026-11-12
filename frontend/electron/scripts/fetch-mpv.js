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
 */
const RELEASE = '20260903';
const ARCHIVE = `mpv-x86_64-${RELEASE}-git-69e63f425a.7z`;
const URL = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${RELEASE}/${ARCHIVE}`;

/** What must come back. Checked before anything is extracted or run. */
const ARCHIVE_SHA256 = '418dbfb5feb851cbed33d6c05d8481ba71802621bfd6efe8974522b28d42ac97';
const MPV_SHA256 = '4a0bc712bc98e6f80cd980930b74b6ac202b8ccf2041e887adab69906f82731c';

const APP = resolve(__dirname, '..');

/**
 * Where it goes.
 *
 * `resources/mpv/mpv.exe` is both what a build from source finds -- see
 * `findMpv` in src/player.ts -- and what electron-builder copies into the
 * packaged app's own resources directory.
 */
const TARGET = join(APP, 'resources', 'mpv', 'mpv.exe');

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

const die = message => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

const main = async () => {
  if (existsSync(TARGET) && sha256(TARGET) === MPV_SHA256) {
    console.log(`\n  mpv ${RELEASE} is already in place.\n`);
    return;
  }

  console.log(`\n  Fetching ${ARCHIVE} (32 MB)`);

  const response = await fetch(URL);
  if (!response.ok) {
    die(`The download answered ${response.status}.`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'xtream-mpv-'));
  const archive = join(scratch, ARCHIVE);

  try {
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

    const got = sha256(archive);
    if (got !== ARCHIVE_SHA256) {
      // Before it is unpacked, and long before it is run. This is the only
      // thing standing between "somebody replaced that file" and an installer
      // that ships whatever they replaced it with.
      die(`That is not the archive this expects.\n  wanted ${ARCHIVE_SHA256}\n  got    ${got}`);
    }

    // Windows' own tar is libarchive, which reads 7z. Named explicitly because
    // in a Git Bash shell `tar` is GNU tar, which does not.
    const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

    const unpacked = spawnSync(bsdtar, ['-xf', archive, '-C', scratch, 'mpv.exe'], {
      stdio: 'inherit'
    });

    if (unpacked.error || unpacked.status !== 0) {
      die(`Could not unpack it: ${unpacked.error ? unpacked.error.message : unpacked.status}`);
    }

    const extracted = join(scratch, 'mpv.exe');
    if (sha256(extracted) !== MPV_SHA256) {
      die('The mpv.exe inside the archive is not the one this expects.');
    }

    mkdirSync(join(APP, 'resources', 'mpv'), { recursive: true });
    copyFileSync(extracted, TARGET);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(
    `  ${(statSync(TARGET).size / 1048576).toFixed(0)} MB in resources/mpv/mpv.exe\n`
  );
};

main().catch(error => die(error.message));
