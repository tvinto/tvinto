import { Category, Stream, StreamType } from '@shared/types';
import { CatalogueStore } from '@shared/xtream/catalogue';
import { searchable } from '@shared/xtream/channelNames';

/**
 * A catalogue that lasts as long as the window does.
 *
 * The desktop's answer to the same problem the phone solves with SQLite, and a
 * deliberately smaller one. The plugin that gives Electron a database wants
 * better-sqlite3-multiple-ciphers, a native module needing node-gyp and a
 * rebuild against Electron's own ABI -- a great deal of machinery for a cache
 * of something the provider will hand over again on request.
 *
 * What it costs is one request per category, once per launch, instead of once
 * ever. That is well within what the provider tolerates: the rule that matters
 * is never to sweep, and this does not -- it fills one category at a time,
 * exactly as the lazy policy above it decides.
 *
 * What it buys is the thing worth having on the desktop: the catalogue comes
 * from the provider rather than from a backend, so nothing of ours need be
 * running.
 */
export class MemoryCatalogueStore implements CatalogueStore {
  private readonly categories = new Map<StreamType, Category[]>();
  private readonly streams = new Map<string, Stream[]>();
  private readonly attempts = new Map<string, string>();

  async readCategories(type: StreamType): Promise<Category[]> {
    return this.categories.get(type) ?? [];
  }

  async writeCategories(type: StreamType, categories: Category[]): Promise<void> {
    this.categories.set(type, categories);
  }

  async readStreams(type: StreamType, categoryId: string): Promise<Stream[]> {
    return this.streams.get(this.key(type, categoryId)) ?? [];
  }

  async writeStreams(type: StreamType, categoryId: string, streams: Stream[]): Promise<void> {
    this.streams.set(this.key(type, categoryId), streams);
  }

  /**
   * Still recorded, and still for the same reason.
   *
   * Within one session an empty category would otherwise be asked about on
   * every visit, and 54% of live categories are empty. That this is forgotten
   * on exit only means the first visit after a launch pays for it again.
   */
  async lastFetchedAt(type: StreamType, categoryId: string): Promise<string | null> {
    return this.attempts.get(this.key(type, categoryId)) ?? null;
  }

  /** Any of the words (Catalogue.findTitles). */
  async findStreamsWithAny(type: StreamType, words: string[], limit: number): Promise<Stream[]> {
    const found: Stream[] = [];
    for (const [key, streams] of this.streams) {
      if (!key.startsWith(type + ':')) {
        continue;
      }
      for (const stream of streams) {
        const name = (stream.name ?? '').toLowerCase();
        if (words.some(word => name.includes(word))) {
          found.push(stream);
          if (found.length >= limit) {
            return found;
          }
        }
      }
    }
    return found;
  }

  /**
   * Every stream held for this type whose name contains all the words.
   *
   * A scan, because there is no index to consult: this store is a Map that
   * lives as long as the window. The cost is bounded by what has been browsed
   * in one session, which on the desktop is a few thousand rows at the very
   * most -- less work than the render that follows it.
   */
  async findStreams(type: StreamType, words: string[], limit: number, joined = false): Promise<Stream[]> {
    const found: Stream[] = [];

    for (const [key, streams] of this.streams) {
      if (!key.startsWith(type + ':')) {
        continue;
      }
      for (const stream of streams) {
        const name = joined ? searchable(stream.name ?? '') : (stream.name ?? '').toLowerCase();
        if (words.every(word => name.includes(word))) {
          found.push(stream);
          if (found.length >= limit) {
            return found;
          }
        }
      }
    }

    return found;
  }

  async recentlyAdded(type: StreamType, limit: number): Promise<Stream[]> {
    const all: Stream[] = [];
    for (const [key, streams] of this.streams) {
      if (key.startsWith(type + ':')) {
        const categoryId = key.slice(type.length + 1);
        for (const stream of streams) {
          all.push({ ...stream, category_id: categoryId } as Stream);
        }
      }
    }
    return all
      .filter(stream => Number(stream.added) > 0)
      .sort((a, b) => Number(b.added) - Number(a.added))
      .slice(0, limit);
  }

  async markFetched(type: StreamType, categoryId: string, at: string): Promise<void> {
    this.attempts.set(this.key(type, categoryId), at);
  }

  private key(type: StreamType, categoryId: string): string {
    return `${type}:${categoryId}`;
  }
}
