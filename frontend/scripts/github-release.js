/**
 * Publishing a release to GitHub, in the order that keeps every installed copy
 * safe while it happens.
 *
 * A release is two steps:
 *
 * 1. **The files**, in a release of their own (`web-1.0.140`, `android-…`,
 *    `desktop-…`), made as a draft and published only once every file is up.
 *    A draft is invisible, so a slow or failed upload is never seen by anyone.
 * 2. **The manifest**, swapped into the feed release (`feed`, a pre-release
 *    that holds the three manifests and nothing else). Until it names the new
 *    version, that version does not exist as far as any installed copy is
 *    concerned -- the same rule as the bucket's "manifest last".
 *
 * The manifest goes up under a temporary name and is renamed over the old one,
 * so the moment with no manifest at all is two API calls long. An app that
 * asks then gets a 404 and asks again at its next check.
 *
 * Needs a token in `GITHUB_TOKEN` with write access to the repository's
 * contents. It is read from the environment and never printed.
 */

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

const FEED_NOTES =
  'The update feed: the manifests installed copies of the app read to find new versions. ' +
  'Nothing here is for installing by hand -- the apps are in the other releases.';

class ReleaseError extends Error {}

/** The GitHub REST calls this needs, over the given fetch. */
const githubClient = ({ owner, repo, token, fetchImpl = fetch }) => {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tvinto-publish'
  };
  const base = `${API}/repos/${owner}/${repo}`;

  const call = async (method, url, body, extraHeaders = {}) => {
    // The token goes to GitHub and nowhere else, whatever a response names as the next address.
    if (!url.startsWith(`${API}/`) && !url.startsWith(`${UPLOADS}/`)) {
      throw new ReleaseError(`Refusing to send the token outside GitHub (${new URL(url).host}).`);
    }
    const response = await fetchImpl(url, {
      method,
      headers: { ...headers, ...extraHeaders },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
    });
    if (response.status === 404 && method === 'GET') {
      return null;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ReleaseError(`GitHub answered ${response.status} to ${method} ${url.replace(API, '')}: ${text.slice(0, 300)}`);
    }
    return response.status === 204 ? {} : response.json();
  };

  return {
    releaseByTag: tag => call('GET', `${base}/releases/tags/${encodeURIComponent(tag)}`),
    createRelease: fields => call('POST', `${base}/releases`, fields),
    updateRelease: (id, fields) => call('PATCH', `${base}/releases/${id}`, fields),
    upload: (release, name, bytes, contentType) =>
      call(
        'POST',
        `${release.upload_url.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(name)}`,
        bytes,
        { 'Content-Type': contentType }
      ),
    renameAsset: (id, name) => call('PATCH', `${base}/releases/assets/${id}`, { name }),
    deleteAsset: id => call('DELETE', `${base}/releases/assets/${id}`)
  };
};

/**
 * Publishes `files` as release `tag`, then swaps `manifest` into the feed.
 *
 * - `files`: `[{ name, bytes, contentType }]`, uploaded to the new release.
 * - `manifest`: `{ name, bytes, contentType }`, put into the feed last.
 * - `latest`: whether this release becomes the one GitHub calls Latest -- an
 *   installer or an APK, which a person downloads; never a web bundle.
 * - `commit`: what the tag points at.
 */
const publishRelease = async ({ target, tag, title, notes, latest, commit, files, manifest, token, fetchImpl, log = console.info }) => {
  if (!token) {
    throw new ReleaseError('Set GITHUB_TOKEN to a token that may write to the repository. Nothing was uploaded.');
  }
  const github = githubClient({ owner: target.owner, repo: target.repo, token, fetchImpl });

  if (await github.releaseByTag(tag)) {
    throw new ReleaseError(`A release named ${tag} already exists. Bump the version. Nothing was uploaded.`);
  }

  const draft = await github.createRelease({
    tag_name: tag,
    target_commitish: commit,
    name: title,
    body: notes,
    draft: true
  });
  for (const file of files) {
    log(`  uploading ${file.name} (${(file.bytes.length / 1048576).toFixed(1)} MB)`);
    await github.upload(draft, file.name, file.bytes, file.contentType);
  }
  log(`  publishing release ${tag}`);
  await github.updateRelease(draft.id, { draft: false, make_latest: latest ? 'true' : 'false' });

  let feed = await github.releaseByTag(target.tag);
  if (!feed) {
    log(`  making the feed release, ${target.tag}`);
    feed = await github.createRelease({
      tag_name: target.tag,
      target_commitish: commit,
      name: 'Update feed',
      body: FEED_NOTES,
      prerelease: true,
      make_latest: 'false'
    });
  }

  log(`  putting ${manifest.name} in the feed`);
  const staged = `${manifest.name}.next`;
  for (const asset of feed.assets ?? []) {
    if (asset.name === staged) {
      await github.deleteAsset(asset.id);
    }
  }
  const uploaded = await github.upload(feed, staged, manifest.bytes, manifest.contentType);
  for (const asset of feed.assets ?? []) {
    if (asset.name === manifest.name) {
      await github.deleteAsset(asset.id);
    }
  }
  await github.renameAsset(uploaded.id, manifest.name);
};

module.exports = { publishRelease, ReleaseError };
