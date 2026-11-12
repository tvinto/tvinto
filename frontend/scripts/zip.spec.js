const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const JSZip = require('jszip');

const { readFromZip, zipDirectory } = require('./zip');

/**
 * The archive the phone downloads, read back by something that is not us.
 *
 * A zip written by hand is a hundred bytes of little-endian headers per file,
 * and every field that is wrong is wrong silently -- the archive opens, and a
 * file is missing, or truncated, or named in mojibake. So it is unpacked here
 * by an independent implementation, and the contents compared byte for byte.
 *
 * The Croatian file name is not decoration. This app's catalogue is Croatian,
 * and a zip that does not set the UTF-8 flag has its names read in whatever
 * the unpacker guesses -- which is exactly the class of fault this repository
 * has been bitten by before, in a different file format.
 */

const sample = () => {
  const root = mkdtempSync(join(tmpdir(), 'xtream-zip-'));

  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Xtream</title>');
  writeFileSync(join(root, 'config.js'), 'window.__XTREAM_API_URL__ = "https://sync.example/api";');
  writeFileSync(join(root, 'Đakovački-kanal.txt'), 'Prva HTV — informativni program');

  mkdirSync(join(root, 'assets', 'icons'), { recursive: true });
  writeFileSync(join(root, 'assets', 'icons', 'star.svg'), '<svg/>');
  writeFileSync(join(root, 'assets', 'big.bin'), Buffer.alloc(200_000, 7));

  return root;
};

describe('zipDirectory', () => {
  let root;
  let unpacked;

  beforeAll(async () => {
    root = sample();
    unpacked = await JSZip.loadAsync(zipDirectory(root));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('puts the app at the root of the archive, not in a folder', async () => {
    // The phone unpacks straight into the directory it will serve and looks
    // for index.html in it. One folder deep and the bundle is refused.
    expect(unpacked.file('index.html')).not.toBeNull();
  });

  it('carries nested files under their own path', async () => {
    expect(await unpacked.file('assets/icons/star.svg').async('string')).toBe('<svg/>');
  });

  it('keeps a name that is not ASCII', async () => {
    expect(await unpacked.file('Đakovački-kanal.txt').async('string')).toBe(
      'Prva HTV — informativni program'
    );
  });

  it('gives back exactly what went in, for something bigger than a buffer', async () => {
    const out = await unpacked.file('assets/big.bin').async('nodebuffer');

    expect(out.length).toBe(200_000);
    expect(out.equals(Buffer.alloc(200_000, 7))).toBe(true);
  });

  it('holds every file and nothing else', async () => {
    expect(Object.keys(unpacked.files).sort()).toEqual([
      'assets/big.bin',
      'assets/icons/star.svg',
      'config.js',
      'index.html',
      'Đakovački-kanal.txt'
    ].sort());
  });

  it('writes the same bytes twice from the same files', async () => {
    // So that "is this the bundle I built" has an answer. Timestamps are the
    // usual reason it does not; every entry here is stamped 1980.
    expect(zipDirectory(root).equals(zipDirectory(root))).toBe(true);
  });
});

/**
 * The reader, checked against archives this did not write.
 *
 * It exists to look inside an APK, which is written by Gradle and signed by
 * apksigner, so proving it can read its own output would prove very little.
 * JSZip writes the archives here, and one of them stores a file rather than
 * deflating it -- which is what an APK does to anything already compressed,
 * and a case a reader that only ever met its own output would never see.
 */
describe('readFromZip', () => {
  const written = async files => {
    const zip = new JSZip();

    for (const [name, { contents, store }] of Object.entries(files)) {
      zip.file(name, contents, store ? { compression: 'STORE' } : { compression: 'DEFLATE' });
    }

    return zip.generateAsync({ type: 'nodebuffer' });
  };

  let archive;

  beforeAll(async () => {
    archive = await written({
      'assets/public/config.js': { contents: "window.__XTREAM_API_URL__ = 'https://sync';" },
      'Đakovački.txt': { contents: 'Prva HTV — informativni program' },
      'resources.arsc': { contents: Buffer.alloc(5000, 3), store: true }
    });
  });

  it('finds a file by its full path inside the archive', async () => {
    expect(readFromZip(archive, 'assets/public/config.js').toString('utf8')).toBe(
      "window.__XTREAM_API_URL__ = 'https://sync';"
    );
  });

  it('reads an entry that was stored rather than compressed', () => {
    // What an APK does with anything already compressed. A reader that assumed
    // deflate would throw here rather than answer wrongly, which is the good
    // failure -- but it would still refuse to check an APK.
    expect(readFromZip(archive, 'resources.arsc').equals(Buffer.alloc(5000, 3))).toBe(true);
  });

  it('matches a name that is not ASCII', () => {
    expect(readFromZip(archive, 'Đakovački.txt').toString('utf8')).toBe(
      'Prva HTV — informativni program'
    );
  });

  it('answers nothing for a name that is not in there', () => {
    // Not an exception: "the APK has no config.js" is a thing the publishing
    // script has something to say about.
    expect(readFromZip(archive, 'assets/public/missing.js')).toBeNull();
  });

  it('reads back what this wrote, which is the only round trip either way', () => {
    const root = sample();

    try {
      expect(readFromZip(zipDirectory(root), 'assets/icons/star.svg').toString('utf8')).toBe(
        '<svg/>'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says it is not a zip rather than reading rubbish', () => {
    expect(() => readFromZip(Buffer.alloc(2000, 9), 'anything')).toThrow(/not a zip/i);
  });
});
