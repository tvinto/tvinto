#!/usr/bin/env node
/**
 * Put a built APK where a phone or a television can be pointed at it.
 *
 *   node scripts/publish-apk.js --dry-run
 *   node scripts/publish-apk.js
 *   node scripts/publish-apk.js --file path/to/app-release.apk
 *
 * This is the one file in the update machinery that is not an update: an
 * installed app replaces its own web bundle over the air, and only needs a new
 * APK when native code changed. So this runs rarely, which is exactly why the
 * checks are worth having -- there is no muscle memory to catch a mistake, and
 * the thing it publishes is what a wiped television will install months from
 * now.
 *
 * The guards, and the silent failure each one exists to stop:
 *
 * - **An APK built before the version was bumped**, published under a version
 *   it does not contain. `versionCode` is what makes a phone throw away a
 *   downloaded bundle, so a file offered as 1.0.2 that is really 1.0.1 leaves
 *   every device on the bundle it already had, looking like nothing happened.
 * - **An APK pointed at this laptop.** `config.js` travels inside it and says
 *   where the account lives. There is no way to tell a good one from the
 *   outside; it is discovered by a television that cannot sign in.
 * - **A manifest published before the file it names**, which is the same
 *   ordering rule as everywhere else here.
 */

const { createHash } = require('crypto');
const { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('fs');
const { basename, join, resolve, sep } = require('path');

const { readFromZip } = require('./zip');
const { publish, addressFor, checkBuiltConfig } = require('./publish');

const FRONTEND = resolve(__dirname, '..');

/** Where the manifest is written before it is uploaded. The APK is not copied. */
const OUT = join(FRONTEND, 'dist-updates');

const GRADLE = join(FRONTEND, 'android/app/build.gradle');

/** What `gradlew assembleDebug` writes, which is the only build this has. */
const DEBUG_APK = join(FRONTEND, 'android/app/build/outputs/apk/debug/app-debug.apk');

const dryRun = process.argv.includes('--dry-run');

const chosenFile = () => {
  const at = process.argv.indexOf('--file');
  return at === -1 ? DEBUG_APK : resolve(process.argv[at + 1] || '');
};

const die = message => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

/** Read a single value out of a file, or stop. */
const readValue = (file, pattern, what) => {
  const found = pattern.exec(readFileSync(file, 'utf8'));

  if (!found) {
    die(`Could not find ${what} in ${basename(file)}.`);
  }

  return found[1];
};

const apk = chosenFile();

if (!existsSync(apk)) {
  die(`No APK at ${apk}. Build one with \`gradlew assembleDebug\` in frontend/android.`);
}

const version = readValue(GRADLE, /versionName\s+"([^"]+)"/, 'versionName');
const versionCode = readValue(GRADLE, /versionCode\s+(\d+)/, 'versionCode');

/**
 * The APK's version must be the version of the web code inside it.
 *
 * A phone takes a published bundle when its version is higher than what it is
 * running, and an APK running its own bundle counts as its `versionName`. They
 * drifted apart -- APK 1.0.4 carrying the code of bundle 1.0.20 -- so a fresh
 * APK took whatever bundle was published at its first launch and ran that from
 * its second, older code or not, and nothing said so. Kept equal, an APK is
 * never "older" than the code it ships.
 */
const webVersion = require(join(FRONTEND, 'package.json')).version;

if (version !== webVersion) {
  die(
    `build.gradle says versionName ${version} but package.json says ${webVersion}. ` +
      `They must be the same: set versionName to ${webVersion} (and bump versionCode), then rebuild.`
  );
}

/**
 * The build must be at least as new as the version it will be published under.
 *
 * Bumping a version and forgetting to rebuild is the ordinary mistake here,
 * and the only evidence of it on disk is which file was written last. The
 * desktop script catches the same thing by comparing its manifest against
 * `package.json`; an APK carries its version in binary XML, so this compares
 * the clock instead.
 */
if (statSync(apk).mtimeMs < statSync(GRADLE).mtimeMs) {
  die(
    `${basename(apk)} is older than build.gradle, which says ${version}. ` +
      `Rebuild before publishing, or this offers a version the file does not contain.`
  );
}

/**
 * Where every device that installs this will look for the account.
 *
 * Read out of the APK rather than off disk: what matters is what was packaged,
 * not what the working tree happens to say now.
 */
const bytes = readFileSync(apk);
const configured = readFromZip(bytes, 'assets/public/config.js');

if (!configured) {
  die(
    'That APK has no assets/public/config.js in it. ' +
      'Run `npx ng build` and `npx cap sync android` before building it.'
  );
}

/*
 * Not the emulator's x86_64: 62 MB that no phone or television box can use,
 * in every download (build.gradle, `-PforDevices`). A test build has it, so
 * publishing one by mistake is the easy slip; --with-emulator allows it.
 */
if (bytes.includes('lib/x86_64/') && !process.argv.includes('--with-emulator')) {
  die(
    'That APK carries x86_64, which only the emulators use. Build the one to publish with ' +
      '`tools/build-apk.cmd -PforDevices` (or pass --with-emulator).'
  );
}

const pointsAt = checkBuiltConfig(configured.toString('utf8'), 'The config.js inside that APK', die);

const sha256 = createHash('sha256').update(bytes).digest('hex');
const file = `tvinto-${version}.apk`;

mkdirSync(OUT, { recursive: true });

writeFileSync(
  join(OUT, 'android-apk.json'),
  `${JSON.stringify(
    { version, versionCode: Number(versionCode), file: addressFor('apk', version, file), sha256, size: bytes.length },
    null,
    2
  )}\n`
);

console.log(`\n  ${file}: ${(bytes.length / 1048576).toFixed(0)} MB, versionCode ${versionCode}`);
console.log(`  sha256 ${sha256.slice(0, 16)}…; ${pointsAt}`);

if (apk.includes(`${sep}debug${sep}`)) {
  // Said rather than refused: a debug APK is what this project builds, and it
  // installs and runs. What it cannot do is upgrade a copy signed with any
  // other key -- so the day a release key appears, every device has to
  // uninstall first, and that is a thing to know in advance rather than to
  // discover on a television.
  console.log('  This is a debug build, signed with the debug key.');
}

/**
 * The APK first, the manifest last (publish.js).
 *
 * The manifest is what the apps and `/a` read, so until it names a version,
 * that version does not exist to anybody with a remote control in their hand.
 * A hundred megabytes takes a while and can fail; this is what stops that
 * being visible as a broken download.
 */
publish({
  kind: 'apk',
  version,
  files: [{ name: file, path: apk, contentType: 'application/vnd.android.package-archive' }],
  manifest: { name: 'android-apk.json', path: join(OUT, 'android-apk.json'), contentType: 'application/json' },
  dryRun,
  die
}).then(() => {
  if (!dryRun) {
    console.info(`\n  ${version} is live. The apps offer it, and /a fetches it.\n`);
  }
});
