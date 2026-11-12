import { compareVersions, decideUpdate, momentToApply, parseBundleManifest } from './web-update.utils';

/**
 * The rules for replacing the app with a copy downloaded from the internet.
 *
 * Worth testing more than most things here, because the thing being decided is
 * which code runs, and because every wrong answer is quiet: a bundle that is
 * not newer replaces the app with itself, one built against an APK this phone
 * has not got fails at whatever feature needs the missing plugin, and one that
 * has already white-screened comes straight back.
 */

const MANIFEST = {
  version: '1.1.0',
  file: 'xtream-web-1.1.0.zip',
  sha256: 'a'.repeat(64),
  minNative: '1.0.0'
};

describe('compareVersions', () => {
  it('reads numbers as numbers', () => {
    // The one a string comparison gets backwards, and the reason this function
    // exists rather than `>`.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBe(1);
  });

  it('orders the ordinary cases', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('parseBundleManifest', () => {
  it('takes one that is well formed', () => {
    expect(parseBundleManifest(MANIFEST)).toEqual(MANIFEST);
  });

  it('refuses a file name the update route would not serve', () => {
    // The rule is written out in two programs, which is a disagreement waiting
    // to happen -- so the device checks before asking, rather than discovering
    // it as a 404 that repeats forever.
    expect(parseBundleManifest({ ...MANIFEST, file: 'bundles/web.zip' })).toBeNull();
    expect(parseBundleManifest({ ...MANIFEST, file: '../latest.yml' })).toBeNull();
  });

  it('takes a file by its https address, where the feed keeps files apart from manifests', () => {
    const address = 'https://github.com/tvinto/tvinto/releases/download/web-1.1.0/tvinto-web-1.1.0.zip';
    expect(parseBundleManifest({ ...MANIFEST, file: address })?.file).toBe(address);
    expect(parseBundleManifest({ ...MANIFEST, file: 'http://github.com/x.zip' })).toBeNull();
    expect(parseBundleManifest({ ...MANIFEST, file: 'https://user:pass@github.com/x.zip' })).toBeNull();
    expect(parseBundleManifest({ ...MANIFEST, file: 'javascript:alert(1)' })).toBeNull();
  });

  it('refuses a hash that is not one', () => {
    expect(parseBundleManifest({ ...MANIFEST, sha256: 'nope' })).toBeNull();
    expect(parseBundleManifest({ ...MANIFEST, sha256: 'A'.repeat(64) })).toBeNull();
  });

  it('refuses a version that is not a version', () => {
    expect(parseBundleManifest({ ...MANIFEST, version: 'latest' })).toBeNull();
    expect(parseBundleManifest({ ...MANIFEST, minNative: '' })).toBeNull();
  });

  it('refuses anything that is not an object at all', () => {
    // What a proxy, a captive portal or a misconfigured host answers with.
    for (const raw of [null, 'not json', 42, []]) {
      expect(parseBundleManifest(raw)).toBeNull();
    }
  });
});

describe('decideUpdate', () => {
  const decide = (over: Partial<Parameters<typeof decideUpdate>[0]> = {}) =>
    decideUpdate({ manifest: MANIFEST, running: '1.0.0', app: '1.0.0', refused: null, ...over });

  it('takes a newer bundle the installed app can run', () => {
    expect(decide()).toEqual({ take: true, manifest: MANIFEST });
  });

  it('leaves the same version alone', () => {
    // Not a no-op if it got this wrong: it would download and swap the app for
    // a copy of itself on every launch.
    expect(decide({ running: '1.1.0' })).toEqual({ take: false, because: 'not-newer' });
    expect(decide({ running: '1.2.0' })).toEqual({ take: false, because: 'not-newer' });
  });

  it('refuses one that needs native code this phone has not got', () => {
    // The failure this prevents does not happen at install. It happens later,
    // at whatever screen calls the plugin that is not there, and looks like
    // anything but an update.
    expect(decide({ manifest: { ...MANIFEST, minNative: '1.1.0' }, app: '1.0.0' })).toEqual({
      take: false,
      because: 'needs-a-newer-app'
    });
  });

  it('takes one whose minimum the app exactly meets', () => {
    expect(decide({ manifest: { ...MANIFEST, minNative: '1.0.0' }, app: '1.0.0' }).take).toBe(true);
  });

  it('does not offer back a version that already failed to start', () => {
    // Without this the phone downloads the bad bundle, white-screens, rolls
    // back, and downloads it again -- for ever.
    expect(decide({ refused: '1.1.0' })).toEqual({ take: false, because: 'refused-before' });
  });

  it('does not fetch again a bundle already waiting for the next launch', () => {
    expect(decide({ running: '1.0.0', pending: '1.1.0' })).toEqual({ take: false, because: 'not-newer' });
  });

  it('still takes something newer than the bundle that is waiting', () => {
    expect(decide({ running: '1.0.0', pending: '1.0.5' }).take).toBe(true);
  });

  it('ignores a waiting bundle older than the one running', () => {
    expect(decide({ running: '1.1.0', pending: '1.0.5' })).toEqual({ take: false, because: 'not-newer' });
  });

  it('says so plainly when there is nothing published', () => {
    expect(decide({ manifest: null })).toEqual({ take: false, because: 'nothing-published' });
  });
});

describe('when a waiting update is taken without asking', () => {
  const base = { waiting: true, playing: false, returnedAfterMs: null, idleMs: 0, visible: true };

  it('takes it on coming back after a while away, before anything is pressed', () => {
    expect(momentToApply({ ...base, returnedAfterMs: 16 * 60 * 1000 })).toBe('returned');
  });

  it('leaves a short absence alone -- the player closing, a quick look at another app', () => {
    expect(momentToApply({ ...base, returnedAfterMs: 2 * 60 * 1000 })).toBeNull();
  });

  it('takes it when the app has been left untouched for a long time', () => {
    expect(momentToApply({ ...base, idleMs: 31 * 60 * 1000 })).toBe('idle');
  });

  it('never while something plays, out of sight, or with nothing waiting', () => {
    const due = { ...base, idleMs: 60 * 60 * 1000, returnedAfterMs: 60 * 60 * 1000 };
    expect(momentToApply({ ...due, playing: true })).toBeNull();
    expect(momentToApply({ ...due, visible: false })).toBeNull();
    expect(momentToApply({ ...due, waiting: false })).toBeNull();
  });

  it('never in the middle of somebody using it', () => {
    expect(momentToApply({ ...base, idleMs: 20 * 1000 })).toBeNull();
  });
});
