#!/usr/bin/env node
/**
 * Builds tvinto-player.exe (native/tvinto-player.cpp) into resources/mpv/,
 * beside the libmpv-2.dll that scripts/fetch-mpv.js puts there.
 *
 *   node scripts/build-player.js
 *
 * The compiler is Zig's (clang with the MinGW-w64 headers and libraries,
 * D3D11 included), fetched from ziglang.org at a pinned version and checked
 * against its published hash, like mpv: nothing to install, and the same
 * compiler on every machine that builds the app. Kept outside the repository
 * in %LOCALAPPDATA%\tvinto-build, since it is 300 MB unpacked.
 */

const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } = require('fs');
const { join, resolve } = require('path');

const ZIG_VERSION = '0.17.1';
const ZIG_ARCHIVE = `zig-x86_64-windows-${ZIG_VERSION}.zip`;
const ZIG_URL = `https://ziglang.org/download/${ZIG_VERSION}/${ZIG_ARCHIVE}`;
/** From https://ziglang.org/download/index.json. */
const ZIG_SHA256 = 'b03f477a1943673e02aca0f570e8030dffd536ce1f45cbc4d3326ec31159562e';

const APP = resolve(__dirname, '..');
const SOURCE = join(APP, 'native', 'tvinto-player.cpp');
const TARGET = join(APP, 'resources', 'mpv', 'tvinto-player.exe');
const TOOLS = join(process.env.LOCALAPPDATA ?? APP, 'tvinto-build');
const ZIG = join(TOOLS, `zig-x86_64-windows-${ZIG_VERSION}`, 'zig.exe');

const die = message => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

const fetchZig = async () => {
  if (existsSync(ZIG)) {
    return;
  }
  console.log(`\n  Fetching Zig ${ZIG_VERSION} (100 MB), for compiling tvinto-player`);
  const response = await fetch(ZIG_URL);
  if (!response.ok) {
    die(`The download answered ${response.status}.`);
  }
  mkdirSync(TOOLS, { recursive: true });
  const archive = join(TOOLS, ZIG_ARCHIVE);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const got = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (got !== ZIG_SHA256) {
    rmSync(archive, { force: true });
    die(`That is not the Zig this expects.\n  wanted ${ZIG_SHA256}\n  got    ${got}`);
  }
  const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const unpacked = spawnSync(bsdtar, ['-xf', archive, '-C', TOOLS], { stdio: 'inherit', windowsHide: true });
  rmSync(archive, { force: true });
  if (unpacked.status !== 0) {
    die('Could not unpack Zig.');
  }
};

const main = async () => {
  if (process.platform !== 'win32') {
    console.log('\n  tvinto-player is Windows only; nothing to build here.\n');
    return;
  }
  if (!existsSync(join(APP, 'resources', 'mpv', 'libmpv-2.dll'))) {
    die('No resources/mpv/libmpv-2.dll. Run `npm run fetch:mpv` first.');
  }
  if (existsSync(TARGET) && statSync(TARGET).mtimeMs > statSync(SOURCE).mtimeMs) {
    console.log('\n  tvinto-player.exe is up to date.\n');
    return;
  }
  await fetchZig();
  const built = spawnSync(
    ZIG,
    [
      'c++',
      '-target', 'x86_64-windows-gnu',
      '-O2',
      '-std=c++17',
      // A program of the Windows subsystem: started by the app, a console one
      // would open a console window on the viewer's screen.
      '-municode',
      '-Wl,--subsystem,windows',
      '-I', join(APP, 'native', 'include'),
      '-o', TARGET,
      SOURCE,
      '-ld3d11',
      '-ldxgi',
      '-lshell32'
    ],
    { stdio: 'inherit', windowsHide: true }
  );
  if (built.status !== 0) {
    die('tvinto-player did not build.');
  }
  rmSync(TARGET.replace(/\.exe$/, '.pdb'), { force: true });
  console.log(`\n  ${(statSync(TARGET).size / 1024).toFixed(0)} KB in resources/mpv/tvinto-player.exe\n`);
};

main().catch(error => die(error.message));
