const { deflateRawSync, inflateRawSync } = require('zlib');
const { readFileSync, readdirSync, statSync } = require('fs');
const { join, posix } = require('path');

/**
 * A zip file, written out by hand.
 *
 * There is a library for this in the tree already, and it is there because
 * something else depends on it -- which is not the same as it being a
 * dependency of ours. This writes about a hundred bytes of header per file and
 * hands the compression to zlib, and `zip.spec.js` unpacks the result with an
 * independent implementation to prove it is a zip.
 *
 * What is deliberately absent:
 *
 * - **Directory entries.** The unpacker on the phone makes parent directories
 *   for every file it writes, so entries for the directories themselves would
 *   be nothing but names to validate.
 * - **Data descriptors.** Every file is read whole before it is written, so
 *   the sizes and the checksum are known when the header goes out, which is
 *   the case zip was designed around.
 * - **Timestamps.** Every entry is stamped 1980, the earliest a zip can hold.
 *   The same input then gives byte-for-byte the same archive, which is what
 *   makes "is this the bundle I built" a question with an answer.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

/** Names are UTF-8. Croatian is all over this app, and so is its catalogue. */
const UTF8_NAMES = 0x0800;
const STORED = 0;
const DEFLATED = 8;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);

  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }

  return table;
})();

const crc32 = buffer => {
  let crc = -1;

  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }

  return (crc ^ -1) >>> 0;
};

/** Every file under a directory, as paths relative to it, in a fixed order. */
const filesUnder = (root, prefix = '') => {
  const found = [];

  for (const name of readdirSync(join(root, prefix)).sort()) {
    const relative = prefix ? posix.join(prefix, name) : name;

    if (statSync(join(root, relative)).isDirectory()) {
      found.push(...filesUnder(root, relative));
    } else {
      found.push(relative);
    }
  }

  return found;
};

/**
 * Zips the contents of a directory, so the archive's root is the directory's.
 *
 * That matters on the other end: the phone unpacks straight into the directory
 * it will serve, and looks for `index.html` in it. An archive holding one
 * folder holding the app would unpack to a folder holding the app, and the
 * bundle would be refused for having no index.
 */
const zipDirectory = root => {
  const entries = [];
  const parts = [];
  let offset = 0;

  for (const name of filesUnder(root)) {
    const contents = readFileSync(join(root, name));
    const deflated = deflateRawSync(contents);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4); // the version needed to read it
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x0021, 12); // date: 1 January 1980
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra fields

    parts.push(local, nameBytes, deflated);

    entries.push({ nameBytes, crc, compressed: deflated.length, size: contents.length, offset });
    offset += local.length + nameBytes.length + deflated.length;
  }

  const directory = [];
  let directoryLength = 0;

  for (const entry of entries) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL, 0);
    header.writeUInt16LE(20, 4); // the version that wrote it
    header.writeUInt16LE(20, 6); // the version needed to read it
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(DEFLATED, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x0021, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // the disk it is on, of which there is one
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(entry.offset, 42);

    directory.push(header, entry.nameBytes);
    directoryLength += header.length + entry.nameBytes.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment

  return Buffer.concat([...parts, ...directory, end]);
};

/**
 * Reads one named file out of an archive, or `null` if it is not in there.
 *
 * The other direction, and here for one caller: an APK is a zip, and the one
 * thing worth checking before publishing one is the `config.js` inside it --
 * which says where every phone that installs it will look for the account. An
 * APK built while pointed at this laptop is indistinguishable from a good one
 * from the outside, and is discovered by a television that cannot sign in.
 *
 * It reads the central directory rather than scanning for local headers,
 * because that is the only part of a zip that is authoritative about what is
 * in it -- and because an APK signed for release has a block of its own
 * between the files and the directory, which a scan would walk straight into.
 *
 * Nothing here handles zip64. It says so rather than guessing: an archive of
 * more than 65,535 files or more than 4 GB is not a mistake this project can
 * make quietly, but it is one it could make.
 */
const readFromZip = (archive, wanted) => {
  const end = endOfCentralDirectory(archive);
  const wantedBytes = Buffer.from(wanted, 'utf8');

  let at = end.directoryOffset;

  for (let i = 0; i < end.entries; i++) {
    if (archive.readUInt32LE(at) !== CENTRAL) {
      throw new Error(`Not a central directory entry at ${at}. Is this a zip?`);
    }

    const method = archive.readUInt16LE(at + 10);
    const compressed = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const localOffset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength);

    if (name.equals(wantedBytes)) {
      return contentsAt(archive, localOffset, compressed, method);
    }

    at += 46 + nameLength + extraLength + commentLength;
  }

  return null;
};

/**
 * The record at the very end, found by looking backwards for its signature.
 *
 * It is last, and it may be followed by a comment of up to 64 KB, so there is
 * no arithmetic that finds it -- every zip reader searches, and so does this.
 */
const endOfCentralDirectory = archive => {
  const earliest = Math.max(0, archive.length - 22 - 0xffff);

  for (let at = archive.length - 22; at >= earliest; at--) {
    if (archive.readUInt32LE(at) !== END) {
      continue;
    }

    const entries = archive.readUInt16LE(at + 10);
    const directoryOffset = archive.readUInt32LE(at + 16);

    if (entries === 0xffff || directoryOffset === 0xffffffff) {
      throw new Error('This archive is zip64, which this cannot read.');
    }

    return { entries, directoryOffset };
  }

  throw new Error('No end-of-central-directory record. This is not a zip.');
};

/**
 * The bytes of one entry, given where its local header starts.
 *
 * The name and extra lengths are read again from the local header rather than
 * reused from the central one: the two are allowed to differ, and where the
 * data begins depends on the local header's.
 */
const contentsAt = (archive, localOffset, compressed, method) => {
  if (archive.readUInt32LE(localOffset) !== LOCAL) {
    throw new Error(`No local header at ${localOffset}. Is this a zip?`);
  }

  const nameLength = archive.readUInt16LE(localOffset + 26);
  const extraLength = archive.readUInt16LE(localOffset + 28);
  const from = localOffset + 30 + nameLength + extraLength;
  const bytes = archive.subarray(from, from + compressed);

  if (method === DEFLATED) {
    return inflateRawSync(bytes);
  }

  if (method === STORED) {
    return Buffer.from(bytes);
  }

  throw new Error(`Compression method ${method} is not one this can read.`);
};

module.exports = { zipDirectory, readFromZip, crc32 };
