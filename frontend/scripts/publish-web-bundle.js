#!/usr/bin/env node
/**
 * Publish the web bundle the Android app will replace itself with.
 *
 *   npx ng build
 *   node scripts/publish-web-bundle.js --dry-run
 *   node scripts/publish-web-bundle.js
 *
 * What goes up is the contents of the Angular build, zipped, plus a manifest
 * naming it. The phone checks the manifest on every launch, and takes the
 * bundle if it is newer, if its `minNative` is met, and if it has not already
 * failed to start. Those rules are in `src/app/utils/web-update.utils.ts`.
 *
 * This end is the guards. Every one of them exists because the failure it
 * prevents is silent on a phone that may be nowhere near anybody:
 *
 * - a manifest offering a version no installed app could ever take;
 * - a bundle built against a newer APK than the one people have;
 * - a bundle pointing at a backend on somebody's laptop;
 * - a manifest published before the file it names.
 */

const { createHash } = require('crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { basename, join, resolve } = require('path');

const { zipDirectory } = require('./zip');
const { publish, addressFor, checkBuiltConfig } = require('./publish');

const FRONTEND = resolve(__dirname, '..');

/** Where the built zip and its manifest are put before they are uploaded. */
const OUT = join(FRONTEND, 'dist-updates');

const dryRun = process.argv.includes('--dry-run');

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

const version = require(join(FRONTEND, 'package.json')).version;

/**
 * The APK this bundle was built against.
 *
 * Taken from the Android project rather than written by hand, because a number
 * kept in two places is a number that will disagree -- and the disagreement
 * shows up as a phone that either refuses every update or takes one it cannot
 * run.
 */
const apkVersion = readValue(
  join(FRONTEND, 'android/app/build.gradle'),
  /versionName\s+"([^"]+)"/,
  'versionName'
);

/**
 * The oldest APK this bundle will run on.
 *
 * By default the APK it was built with, which is safe -- and meant a web-only
 * fix never reached a device on the previous APK: a phone on 1.0.30 went
 * without the landscape layout and the subtitle settings, which needed nothing
 * native. `--min-native 1.0.24` says the web code runs that far back, which it
 * must genuinely do: where it uses a newer plugin it has to fall back (the
 * in-player channel switching and the app updater both do). Never above the
 * APK being built, which could then not take the bundle it carries.
 */
const flagAt = process.argv.indexOf('--min-native');
const minNative = flagAt === -1 ? apkVersion : process.argv[flagAt + 1] || '';

if (!/^\d+(\.\d+)*$/.test(minNative)) {
  die(`--min-native needs a version, like 1.0.24. Got: ${minNative || 'nothing'}`);
}

/** Where `ng build` puts the app. Read from the Capacitor config, not guessed. */
const webDir = readValue(
  join(FRONTEND, 'capacitor.config.ts'),
  /webDir:\s*'([^']+)'/,
  'webDir'
);

const built = join(FRONTEND, webDir);

if (!existsSync(join(built, 'index.html'))) {
  die(`No build in ${webDir}. Run \`npx ng build\` first.`);
}

const asNumbers = text => text.split('.').map(Number);

const newer = (a, b) => {
  const left = asNumbers(a);
  const right = asNumbers(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }

  return false;
};

if (newer(minNative, apkVersion)) {
  die(`--min-native ${minNative} is newer than the APK being built (${apkVersion}), which could not take this bundle.`);
}

// A bundle has to be newer than the APKs it is offered to. With --min-native
// below the APK, the APK's own version is enough: that APK carries the code,
// and the older ones take it.
const lowered = newer(apkVersion, minNative);
if (!newer(version, minNative) || (!lowered && !newer(version, apkVersion))) {
  // The APK ships with the bundle of its own version, so a bundle that is not
  // newer than the APK is one nothing would ever take. Publishing it would
  // look like a release and change nothing.
  die(
    version === apkVersion
      ? `The APK is ${version} and already carries this web code, so no bundle is needed for it. ` +
          `For a web-only change after it, bump "version" in package.json past ${apkVersion}, ` +
          `or pass --min-native with an older APK to offer this code to.`
      : `This bundle is ${version} and the APK is ${apkVersion}. ` +
          `Bump "version" in package.json to something higher.`
  );
}

/**
 * Where the app in this bundle will look for its account and its updates.
 * A bundle carries `config.js`, the one line of the build that is
 * configuration rather than code; publish.js says what it refuses.
 */
const configured = checkBuiltConfig(readFileSync(join(built, 'config.js'), 'utf8'), 'config.js in the build', die);

const file = `tvinto-web-${version}.zip`;

mkdirSync(OUT, { recursive: true });

console.log(`\n  Building ${file} from ${webDir}`);

const archive = zipDirectory(built);
const sha256 = createHash('sha256').update(archive).digest('hex');

writeFileSync(join(OUT, file), archive);
writeFileSync(
  join(OUT, 'android-latest.json'),
  `${JSON.stringify({ version, file: addressFor('bundle', version, file), sha256, minNative }, null, 2)}\n`
);

console.log(`  ${(archive.length / 1048576).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}…`);
console.log(`  needs an APK of at least ${minNative}; ${configured}`);

/**
 * The bundle first, the manifest last, and never the other way round
 * (publish.js). The manifest is the only thing a phone asks for unprompted, so
 * until it names a version, that version does not exist to any phone.
 */
publish({
  kind: 'bundle',
  version,
  files: [{ name: file, path: join(OUT, file), contentType: 'application/zip' }],
  manifest: { name: 'android-latest.json', path: join(OUT, 'android-latest.json'), contentType: 'application/json' },
  dryRun,
  die
}).then(() => {
  if (!dryRun) {
    console.info(`\n  ${version} is live. Phones will take it on their next launch.\n`);
  }
});
