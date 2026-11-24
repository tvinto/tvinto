const { DEFAULT_UPDATES_URL, updatesUrl, githubFeed, releaseTarget, fileAddress } = require('./feed');
const { publishRelease } = require('./github-release');

/**
 * Where a build looks for updates and where its release goes, which must be
 * the same place: a build checking one feed and a release sent to another is
 * an update nobody receives.
 */

describe('the feed', () => {
  it('is the project’s releases unless config.local.json names another', () => {
    expect(updatesUrl({})).toBe(DEFAULT_UPDATES_URL);
    expect(updatesUrl({ updatesUrl: 'https://sync.example/updates/' })).toBe('https://sync.example/updates');
  });

  it('must be https', () => {
    expect(() => updatesUrl({ updatesUrl: 'http://sync.example/updates' })).toThrow('https');
  });

  it('publishes to GitHub for a release feed and to a bucket for anything else', () => {
    expect(releaseTarget(DEFAULT_UPDATES_URL)).toMatchObject({ kind: 'github', owner: 'tvinto', repo: 'tvinto', tag: 'feed' });
    expect(releaseTarget('https://sync.example/updates')).toMatchObject({ kind: 'bucket' });
    expect(githubFeed('https://github.com/tvinto/tvinto/releases/latest/download')).toBeNull();
  });

  it('names a file by its release on GitHub, and beside the manifest in a bucket', () => {
    expect(fileAddress(releaseTarget(DEFAULT_UPDATES_URL), 'web-1.0.140', 'tvinto-web-1.0.140.zip')).toBe(
      'https://github.com/tvinto/tvinto/releases/download/web-1.0.140/tvinto-web-1.0.140.zip'
    );
    expect(fileAddress(releaseTarget('https://sync.example/updates'), 'web-1.0.140', 'tvinto-web-1.0.140.zip')).toBe(
      'tvinto-web-1.0.140.zip'
    );
  });
});

describe('publishing a release on GitHub', () => {
  const target = releaseTarget(DEFAULT_UPDATES_URL);

  /** A GitHub that keeps releases and assets, recording every call in order. */
  const fakeGitHub = (existing = {}) => {
    const releases = { ...existing };
    const calls = [];
    let nextId = 100;
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

    const fetchImpl = async (url, { method, body }) => {
      const path = url.replace('https://api.github.com/repos/tvinto/tvinto', '').replace('https://uploads.github.com/repos/tvinto/tvinto', '');
      calls.push(`${method} ${path}`);
      const tagged = /^\/releases\/tags\/(.+)$/.exec(path);
      if (method === 'GET' && tagged) {
        const release = releases[decodeURIComponent(tagged[1])];
        return release ? json(200, release) : json(404, {});
      }
      if (method === 'POST' && path === '/releases') {
        const fields = JSON.parse(body);
        const id = nextId++;
        releases[fields.tag_name] = { id, ...fields, assets: [], upload_url: `https://uploads.github.com/repos/tvinto/tvinto/releases/${id}/assets{?name,label}` };
        return json(201, releases[fields.tag_name]);
      }
      const upload = /^\/releases\/(\d+)\/assets\?name=(.+)$/.exec(path);
      if (method === 'POST' && upload) {
        const release = Object.values(releases).find(r => r.id === Number(upload[1]));
        const asset = { id: nextId++, name: decodeURIComponent(upload[2]) };
        release.assets.push(asset);
        return json(201, asset);
      }
      const asset = /^\/releases\/assets\/(\d+)$/.exec(path);
      if (asset) {
        for (const release of Object.values(releases)) {
          const found = release.assets.find(a => a.id === Number(asset[1]));
          if (found && method === 'DELETE') {
            release.assets = release.assets.filter(a => a !== found);
          }
          if (found && method === 'PATCH') {
            found.name = JSON.parse(body).name;
          }
        }
        return method === 'DELETE' ? { ok: true, status: 204 } : json(200, {});
      }
      const patched = /^\/releases\/(\d+)$/.exec(path);
      if (method === 'PATCH' && patched) {
        const release = Object.values(releases).find(r => r.id === Number(patched[1]));
        Object.assign(release, JSON.parse(body));
        return json(200, release);
      }
      return json(500, { path });
    };
    return { releases, calls, fetchImpl };
  };

  const release = (github, overrides = {}) =>
    publishRelease({
      target,
      tag: 'web-1.0.140',
      title: 'Web bundle 1.0.140',
      notes: '',
      latest: false,
      commit: 'abc123',
      files: [{ name: 'tvinto-web-1.0.140.zip', bytes: Buffer.from('zip'), contentType: 'application/zip' }],
      manifest: { name: 'android-latest.json', bytes: Buffer.from('{}'), contentType: 'application/json' },
      token: 'test-token',
      fetchImpl: github.fetchImpl,
      log: () => {},
      ...overrides
    });

  it('uploads into a draft, publishes it, and only then changes the feed', async () => {
    const github = fakeGitHub();
    await release(github);

    expect(github.calls).toEqual([
      'GET /releases/tags/web-1.0.140',
      'POST /releases',
      'POST /releases/100/assets?name=tvinto-web-1.0.140.zip',
      'PATCH /releases/100',
      'GET /releases/tags/feed',
      'POST /releases',
      'POST /releases/102/assets?name=android-latest.json.next',
      'PATCH /releases/assets/103'
    ]);
    expect(github.releases['web-1.0.140']).toMatchObject({ draft: false, make_latest: 'false' });
    expect(github.releases.feed).toMatchObject({ prerelease: true });
    expect(github.releases.feed.assets.map(a => a.name)).toEqual(['android-latest.json']);
  });

  it('replaces the manifest already in the feed, and leaves the others', async () => {
    const github = fakeGitHub({
      feed: {
        id: 1,
        tag_name: 'feed',
        upload_url: 'https://uploads.github.com/repos/tvinto/tvinto/releases/1/assets{?name,label}',
        assets: [{ id: 2, name: 'android-latest.json' }, { id: 3, name: 'latest.yml' }]
      }
    });
    await release(github);

    expect(github.releases.feed.assets.map(a => a.name).sort()).toEqual(['android-latest.json', 'latest.yml']);
    expect(github.releases.feed.assets.find(a => a.name === 'android-latest.json').id).not.toBe(2);
  });

  it('refuses a version that already has a release, before uploading anything', async () => {
    const github = fakeGitHub({ 'web-1.0.140': { id: 1, assets: [] } });
    await expect(release(github)).rejects.toThrow('already exists');
    expect(github.calls).toEqual(['GET /releases/tags/web-1.0.140']);
  });

  it('never sends the token to an upload address outside GitHub', async () => {
    const github = fakeGitHub();
    const fetchImpl = github.fetchImpl;
    github.fetchImpl = async (url, init) => {
      const answer = await fetchImpl(url, init);
      if (init.method === 'POST' && url.endsWith('/releases')) {
        const body = await answer.json();
        return { ...answer, json: async () => ({ ...body, upload_url: 'https://evil.example/upload{?name}' }) };
      }
      return answer;
    };
    await expect(release(github)).rejects.toThrow('outside GitHub');
    expect(github.calls).toEqual(['GET /releases/tags/web-1.0.140', 'POST /releases']);
  });

  it('refuses without a token', async () => {
    await expect(release(fakeGitHub(), { token: undefined })).rejects.toThrow('GITHUB_TOKEN');
  });
});
