import { Category, Stream, StreamType } from '../types';
import { CatalogueSource } from '../xtream/source';
import { M3uItem } from './m3uReader';
import { M3uPlaylist, M3uPlaylistBuilder } from './m3uPlaylist';

/**
 * An M3U playlist as a catalogue source.
 *
 * There is no asking a playlist for one category: it is one file, fetched
 * whole. So the first question reads it, and every question after that in
 * this session is answered from what was read. `Catalogue` keeps what it is
 * given, which is what spares the next launch the download.
 *
 * How the bytes arrive is the caller's (`read`): a television streams them
 * through a file so that the text is never held whole (see `m3uItems`).
 */
export class M3uSource implements CatalogueSource {
  private loading: Promise<M3uPlaylist> | null = null;
  private failure: { at: number; error: unknown } | null = null;

  constructor(
    private readonly read: () => AsyncIterable<M3uItem>,
    /**
     * How long a failed read is taken as the answer. Every list on every
     * screen asks, and a playlist host that is down would otherwise be tried
     * -- and waited on -- by each of them in turn.
     */
    private readonly retryAfterMs = 120_000,
    private readonly now: () => number = Date.now
  ) {}

  /** The playlist, read once; a failed read is tried again after a while. */
  playlist(): Promise<M3uPlaylist> {
    if (!this.loading && this.failure && this.now() - this.failure.at < this.retryAfterMs) {
      return Promise.reject(this.failure.error);
    }
    this.loading ??= this.load().then(
      playlist => {
        this.failure = null;
        return playlist;
      },
      error => {
        this.loading = null;
        this.failure = { at: this.now(), error };
        throw error;
      }
    );
    return this.loading;
  }

  /** Forgets what was read, for a playlist that has changed. */
  refresh(): void {
    this.loading = null;
    this.failure = null;
  }

  async getCategories(type: StreamType): Promise<Category[]> {
    return (await this.playlist()).categories[type];
  }

  async getStreams(type: StreamType, categoryId?: string): Promise<Stream[]> {
    const streams = (await this.playlist()).streams[type];
    if (categoryId !== undefined) {
      return streams.get(categoryId) ?? [];
    }
    return [...streams.values()].flat();
  }

  async guideUrls(): Promise<string[]> {
    return (await this.playlist()).guideUrls;
  }

  private async load(): Promise<M3uPlaylist> {
    const builder = new M3uPlaylistBuilder();
    for await (const item of this.read()) {
      builder.add(item);
    }
    return builder.result();
  }
}
