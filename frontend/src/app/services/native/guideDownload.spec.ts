import { GuideDownloadPlugin, downloadedGuideBytes } from './guideDownload';

/**
 * Reading a downloaded guide back from Android in chunks.
 *
 * The plugin is faked over an in-memory file, so what is checked is the part
 * that is easy to get subtly wrong: every byte arrives once and in order,
 * whatever the chunk size, and the file is deleted however the read ends.
 */

const fakePlugin = (file: Uint8Array) => {
  const discarded: string[] = [];
  const reads: number[] = [];

  const plugin: GuideDownloadPlugin = {
    download: jest.fn(async () => ({ id: 'a', bytes: file.length })),
    read: jest.fn(async ({ offset, length }) => {
      reads.push(offset);
      const chunk = file.subarray(offset, offset + length);
      return { data: Buffer.from(chunk).toString('base64'), eof: offset + chunk.length >= file.length };
    }),
    discard: jest.fn(async ({ id }) => {
      discarded.push(id);
    })
  };

  return { plugin, discarded, reads };
};

const collect = async (chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) {
    parts.push(chunk);
  }
  return Uint8Array.from(Buffer.concat(parts));
};

// Every byte value, so a decode that went through text would show.
const FILE = Uint8Array.from({ length: 10_000 }, (_, index) => (index * 31) % 256);

describe('downloadedGuideBytes', () => {
  it('yields every byte once, in order, across chunks that do not divide the file', async () => {
    const { plugin, reads } = fakePlugin(FILE);

    const bytes = await collect(downloadedGuideBytes(plugin, 'http://guide.example/x', { chunkBytes: 3_000 }));

    expect(Buffer.from(bytes).equals(Buffer.from(FILE))).toBe(true);
    expect(reads).toEqual([0, 3_000, 6_000, 9_000]);
  });

  it('never holds more than one chunk', async () => {
    const { plugin } = fakePlugin(FILE);
    const sizes: number[] = [];

    for await (const chunk of downloadedGuideBytes(plugin, 'http://guide.example/x', { chunkBytes: 1_024 })) {
      sizes.push(chunk.length);
    }

    expect(Math.max(...sizes)).toBe(1_024);
  });

  it('deletes the file when the read finishes', async () => {
    const { plugin, discarded } = fakePlugin(FILE);

    await collect(downloadedGuideBytes(plugin, 'http://guide.example/x'));

    expect(discarded).toEqual(['a']);
  });

  // A parser that fails half way stops reading; the file must still go.
  it('deletes the file when the reader stops early', async () => {
    const { plugin, discarded } = fakePlugin(FILE);

    for await (const chunk of downloadedGuideBytes(plugin, 'http://guide.example/x', { chunkBytes: 1_000 })) {
      void chunk;
      break;
    }

    expect(discarded).toEqual(['a']);
  });

  it('deletes the file when a read fails', async () => {
    const { plugin, discarded } = fakePlugin(FILE);
    (plugin.read as jest.Mock).mockRejectedValueOnce(new Error('gone'));

    await expect(collect(downloadedGuideBytes(plugin, 'http://guide.example/x'))).rejects.toThrow('gone');
    expect(discarded).toEqual(['a']);
  });

  it('stops rather than looping on an empty chunk that is not marked as the end', async () => {
    const { plugin } = fakePlugin(FILE);
    (plugin.read as jest.Mock).mockResolvedValue({ data: '', eof: false });

    expect((await collect(downloadedGuideBytes(plugin, 'http://guide.example/x'))).length).toBe(0);
  });

  it('handles an empty guide', async () => {
    const { plugin, discarded } = fakePlugin(new Uint8Array());

    expect((await collect(downloadedGuideBytes(plugin, 'http://guide.example/x'))).length).toBe(0);
    expect(discarded).toEqual(['a']);
  });
});
