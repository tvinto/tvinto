/**
 * Where installed copies look for new versions, and where a release goes.
 *
 * One answer for everything that needs it: `write-config.mjs` puts it in
 * `config.js` for the web code (the Android update checks), the desktop's
 * `electron-builder.config.js` bakes it into `app-update.yml`, and the publish
 * scripts read it to know where to upload. Kept in one place because a build
 * that checks one feed and a script that publishes to another is a release
 * nobody receives, with no error anywhere.
 *
 * The project's own feed is a GitHub release named `feed` holding the three
 * manifests and nothing else. A fork sets `updatesUrl` in
 * `config.local.json` to its own repository's, or to a sync service's
 * `/updates` to publish into its R2 bucket as before.
 */

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

/** The project's feed. */
const DEFAULT_UPDATES_URL = 'https://github.com/tvinto/tvinto/releases/download/feed';

/** The three manifests a feed holds: the web bundle's, the APK's and the desktop's. */
const MANIFESTS = {
  bundle: 'android-latest.json',
  apk: 'android-apk.json',
  desktop: 'latest.yml'
};

const LOCAL_CONFIG = join(__dirname, '..', 'config.local.json');

const readLocal = (file = LOCAL_CONFIG) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});

/** The feed this build uses: `updatesUrl` from config.local.json, else the project's. */
const updatesUrl = (local = readLocal()) => {
  const chosen = typeof local.updatesUrl === 'string' && local.updatesUrl.trim() ? local.updatesUrl.trim() : DEFAULT_UPDATES_URL;
  const url = chosen.replace(/\/+$/, '');
  if (!/^https:\/\/[^\s'"\\]+$/.test(url)) {
    throw new Error(`config.local.json: updatesUrl must be an https address: ${url}`);
  }
  return url;
};

/** The repository a GitHub feed belongs to, or null for any other feed. */
const githubFeed = url => {
  const found = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/([\w.-]+)$/.exec(url);
  return found ? { owner: found[1], repo: found[2], tag: found[3] } : null;
};

/**
 * Where a release goes: a GitHub repository's releases, or the R2 bucket a
 * sync service serves `/updates/` from.
 */
const releaseTarget = (url = updatesUrl()) => {
  const github = githubFeed(url);
  if (github) {
    return { kind: 'github', url, ...github };
  }
  return { kind: 'bucket', url, bucket: process.env.UPDATE_BUCKET || 'xtream-updates' };
};

/**
 * What a manifest calls a file. In a bucket, its name beside the manifest; on
 * GitHub, the full address in the release that holds it -- the feed release
 * holds manifests only.
 */
const fileAddress = (target, tag, name) =>
  target.kind === 'github'
    ? `https://github.com/${target.owner}/${target.repo}/releases/download/${tag}/${encodeURIComponent(name)}`
    : name;

module.exports = { DEFAULT_UPDATES_URL, MANIFESTS, readLocal, updatesUrl, githubFeed, releaseTarget, fileAddress };
