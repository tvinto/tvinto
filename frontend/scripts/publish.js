/**
 * Sends a release to wherever this build's feed is (feed.js): GitHub Releases,
 * or the R2 bucket of a sync service. The three publish scripts check what they
 * are publishing; this only sends it, files first and the manifest last.
 */

const { execFileSync } = require('child_process');
const { readFileSync, statSync } = require('fs');
const { releaseTarget, fileAddress } = require('./feed');
const { publishRelease } = require('./github-release');

/** Each kind's release: its tag, its title, and whether a person downloads it. */
const KINDS = {
  bundle: { prefix: 'web', title: 'Web bundle', latest: false, notes: 'The web code the Android app replaces its own with. It arrives by itself; nothing to install.' },
  apk: { prefix: 'android', title: 'Android', latest: true, notes: 'For Android phones, tablets and TV. Allow installing from unknown sources when asked.' },
  desktop: { prefix: 'desktop', title: 'Windows', latest: true, notes: 'The Windows installer. Windows warns about an unknown publisher because it is not signed: More info, then Run anyway.' }
};

const tagFor = (kind, version) => `${KINDS[kind].prefix}-${version}`;

/** What the manifest should call a file, for the target this build publishes to. */
const addressFor = (kind, version, name, target = releaseTarget()) => fileAddress(target, tagFor(kind, version), name);

/**
 * Reads the config.js a build carries and refuses one that would send the
 * devices taking it somewhere wrong. Returns what it found, for printing.
 *
 * - **It must update from the feed it is published to.** A build checking
 *   another feed is installed once and then never hears of a new version.
 * - **On the project's releases it names no sync service.** Everybody installs
 *   these; a server written into one would send every device that took it to
 *   somebody's own.
 * - **Into a bucket it names an https one**, as before: a build made while
 *   pointed at a laptop sends every phone to a machine that is not on.
 */
const checkBuiltConfig = (text, what, die) => {
  const target = releaseTarget();
  // Only lines that run: a build with no server carries the setting as a
  // commented-out example.
  const updates = /^\s*window\.__TVINTO_UPDATES_URL__\s*=\s*'([^']+)'/m.exec(text);
  if (!updates || updates[1] !== target.url) {
    die(`${what} updates from ${updates ? updates[1] : 'nowhere'}, not from ${target.url}, where it is being published. Rebuild.`);
  }
  const api = /^\s*window\.__XTREAM_API_URL__\s*=\s*'([^']+)'/m.exec(text);
  if (target.kind === 'github' && api) {
    die(`${what} names a sync service (${api[1]}), and a build on GitHub is everybody's. Build it without apiUrl in config.local.json.`);
  }
  if (target.kind === 'bucket' && (!api || !api[1].startsWith('https://'))) {
    die(`${what} does not point at an https service. Found: ${api ? api[1] : 'nothing'}`);
  }
  return api ? `points at ${api[1]}` : 'names no sync service';
};

const headCommit = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

/**
 * - `files`: `[{ name, path, contentType }]`
 * - `manifest`: `{ name, path, contentType }`
 */
const publish = async ({ kind, version, files, manifest, dryRun, die }) => {
  const target = releaseTarget();
  const where = target.kind === 'github' ? `GitHub ${target.owner}/${target.repo}` : `the bucket ${target.bucket}`;
  console.info(`\n  Publishing to ${where}\n`);

  if (dryRun) {
    for (const file of files) {
      console.info(`  would upload ${file.name} (${(statSync(file.path).size / 1048576).toFixed(1)} MB)`);
    }
    if (target.kind === 'github') {
      console.info(`  as release ${tagFor(kind, version)}, then put ${manifest.name} in the ${target.tag} release`);
    } else {
      console.info(`  then ${manifest.name}`);
    }
    console.info('\n  Nothing was uploaded.\n');
    return;
  }

  if (target.kind === 'bucket') {
    const { putObject } = require('./wrangler');
    for (const file of [...files, manifest]) {
      console.info(`  uploading ${file.name}`);
      const sent = putObject(target.bucket, file.name, file.path, file.contentType);
      if (!sent.ok) {
        die(`Uploading ${file.name} failed: ${sent.why}. Nothing after it was uploaded.`);
      }
    }
    return;
  }

  if (!process.env.GITHUB_TOKEN) {
    die('Set GITHUB_TOKEN to a token that may write to the repository. Nothing was uploaded.');
  }
  const read = file => ({ name: file.name, contentType: file.contentType, bytes: readFileSync(file.path) });
  try {
    await publishRelease({
      target,
      tag: tagFor(kind, version),
      title: `${KINDS[kind].title} ${version}`,
      notes: KINDS[kind].notes,
      latest: KINDS[kind].latest,
      commit: headCommit(),
      files: files.map(read),
      manifest: read(manifest),
      token: process.env.GITHUB_TOKEN
    });
  } catch (error) {
    die(
      `${error.message}\n  Stopped there. The feed changes only at the last step, renaming ${manifest.name} into place, ` +
        `so unless that step was reached no installed copy is offered this version. A release left as a draft can be deleted on GitHub.`
    );
  }
};

module.exports = { publish, addressFor, tagFor, checkBuiltConfig };
