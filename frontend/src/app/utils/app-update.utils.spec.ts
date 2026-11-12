import { megabytes, newerApp, parseApkManifest } from './app-update.utils';

const SHA = 'a'.repeat(64);
const PUBLISHED = { version: '1.0.32', versionCode: 12, file: 'xtream-1.0.32.apk', sha256: SHA, size: 176_591_614 };

describe('parseApkManifest', () => {
  it('reads what publish-apk writes', () => {
    expect(parseApkManifest(PUBLISHED)).toEqual({ version: '1.0.32', file: 'xtream-1.0.32.apk', sha256: SHA, size: 176_591_614 });
  });

  it('refuses a file name the update route would not serve', () => {
    expect(parseApkManifest({ ...PUBLISHED, file: '../xtream.apk' })).toBeNull();
  });

  it('refuses a manifest without a usable version or checksum', () => {
    expect(parseApkManifest({ ...PUBLISHED, version: 'latest' })).toBeNull();
    expect(parseApkManifest({ ...PUBLISHED, sha256: 'abc' })).toBeNull();
    expect(parseApkManifest(null)).toBeNull();
  });
});

describe('newerApp', () => {
  const manifest = parseApkManifest(PUBLISHED);

  it('offers an app newer than the one installed', () => {
    expect(newerApp(manifest, '1.0.31')?.version).toBe('1.0.32');
    expect(newerApp(manifest, '1.0.9')?.version).toBe('1.0.32');
  });

  it('offers nothing when the installed app is as new or newer', () => {
    expect(newerApp(manifest, '1.0.32')).toBeNull();
    expect(newerApp(manifest, '1.1.0')).toBeNull();
  });

  it('offers nothing when either side is unknown', () => {
    expect(newerApp(null, '1.0.31')).toBeNull();
    expect(newerApp(manifest, null)).toBeNull();
  });
});

describe('megabytes', () => {
  it('rounds to whole megabytes and says nothing for an unknown size', () => {
    expect(megabytes(176_591_614)).toBe('168 MB');
    expect(megabytes(0)).toBe('');
  });
});
