import { Category, Stream, StreamType } from '../types';
import { M3uEntry, M3uHeader, M3uItem } from './m3uReader';

/**
 * A playlist as the app's libraries: categories and streams per type.
 *
 * An M3U has no ids, no libraries and no catch-up API -- a list of names and
 * addresses, grouped by `group-title`. This gives it the shape an Xtream
 * provider has, so everything past the catalogue works on it unchanged.
 */

/** How a stream of a playlist is reached, which an Xtream row never needs. */
export interface M3uStreamFields {
  /** The address to play. It may carry the playlist's credentials; it stays on the device. */
  source_url: string;
  /** `default`, `append`, `shift`, `flussonic` or `xc`, when the playlist offers catch-up. */
  catchup_mode?: string;
  /** The catch-up address template, for the modes that take one. */
  catchup_source?: string;
}

export type M3uStream = Stream & M3uStreamFields;

export interface M3uPlaylist {
  guideUrls: string[];
  categories: Record<StreamType, Category[]>;
  /** Keyed by category id within each type, in playlist order. */
  streams: Record<StreamType, Map<string, M3uStream[]>>;
}

/** The category for entries whose playlist gave them no group. */
export const UNGROUPED_CATEGORY_ID = 'ungrouped';

const FILE_EXTENSIONS = /\.(mp4|mkv|avi|mov|m4v|wmv|flv|webm|mpg|mpeg)$/i;
const FILM_PATH = /\/(movie|movies|vod|series)\//i;

/**
 * Films from channels.
 *
 * By the address, which is what a playlist reliably has: an Xtream-made M3U
 * puts films under `/movie/` and shows under `/series/`, and a file with a
 * film's extension is not a live channel whatever it is called. Shows are
 * filed as films for now -- an M3U lists episodes one by one, and gathering
 * them into shows is its own job.
 */
export function m3uStreamType(url: string): StreamType {
  const path = url.split(/[?#]/)[0];
  return FILM_PATH.test(path) || FILE_EXTENSIONS.test(path) ? 'vod' : 'live';
}

/**
 * A short stable id from text, FNV-1a in base 36.
 *
 * From the group and the name rather than the address: a playlist's addresses
 * carry its password, and a renewed subscription must not turn every
 * favourite into a stranger.
 */
export function stableId(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const extensionOf = (url: string): string | undefined =>
  url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();

/**
 * Builds a playlist from its items as they are read.
 *
 * Incremental so that a caller streaming a large playlist holds the result
 * and one line, never the text as well.
 */
export class M3uPlaylistBuilder {
  private header: M3uHeader | null = null;
  private readonly categories: Record<StreamType, Map<string, Category>> = {
    live: new Map(),
    vod: new Map(),
    series: new Map()
  };
  private readonly streams: Record<StreamType, Map<string, M3uStream[]>> = {
    live: new Map(),
    vod: new Map(),
    series: new Map()
  };
  private readonly usedIds = new Set<string>();
  private count = 0;

  add(item: M3uItem): void {
    if (item.kind === 'header') {
      this.header = item;
    } else {
      this.addEntry(item);
    }
  }

  result(): M3uPlaylist {
    return {
      guideUrls: this.header?.guideUrls ?? [],
      categories: {
        live: [...this.categories.live.values()],
        vod: [...this.categories.vod.values()],
        series: [...this.categories.series.values()]
      },
      streams: this.streams
    };
  }

  private addEntry(entry: M3uEntry): void {
    const type = m3uStreamType(entry.url);
    const group = entry.group;
    const categoryId = group ? `g${stableId(group)}` : UNGROUPED_CATEGORY_ID;

    if (!this.categories[type].has(categoryId)) {
      this.categories[type].set(categoryId, {
        category_id: categoryId,
        category_name: group,
        parent_id: '0'
      });
      this.streams[type].set(categoryId, []);
    }

    const tvgId = entry.attributes['tvg-id'] ?? '';
    let id = `m${stableId(`${type}|${group}|${entry.name}|${tvgId}`)}`;
    // The same channel twice in a group is common (an HD and an SD line with
    // one name). Each keeps a place, numbered in playlist order.
    for (let copy = 2; this.usedIds.has(id); copy++) {
      id = `m${stableId(`${type}|${group}|${entry.name}|${tvgId}|${copy}`)}`;
    }
    this.usedIds.add(id);

    const catchUp = this.catchUpOf(entry);
    const logo = entry.attributes['tvg-logo'] ?? '';
    const stream: M3uStream = {
      stream_id: id,
      name: entry.name,
      icon: logo,
      stream_icon: logo,
      category_id: categoryId,
      epg_channel_id: tvgId || undefined,
      stream_type: type === 'live' ? 'live' : 'movie',
      added: '0',
      source_url: entry.url,
      ...catchUp
    };
    const extension = extensionOf(entry.url);
    if (type !== 'live' && extension) {
      (stream as unknown as Record<string, unknown>)['container_extension'] = extension;
    }
    (stream as unknown as Record<string, unknown>)['num'] = ++this.count;

    this.streams[type].get(categoryId)!.push(stream);
  }

  /**
   * Catch-up, from the entry or the playlist's defaults.
   *
   * The attributes IPTVnator reads: `catchup` (the mode), `catchup-source`
   * (the template) and `catchup-days`; `timeshift` and `tvg-rec` are older
   * spellings of the days. A mode with no days is taken as none, and so is
   * a mode of "0" or "none", which some playlists use to turn one entry off.
   */
  private catchUpOf(entry: M3uEntry): Partial<M3uStream> {
    const defaults = this.header?.attributes ?? {};
    const pick = (name: string) => entry.attributes[name] ?? defaults[name];

    const days = Number.parseInt(
      pick('catchup-days') ?? pick('timeshift') ?? pick('tvg-rec') ?? '',
      10
    );
    const mode = (pick('catchup') ?? pick('catchup-type') ?? '').toLowerCase();

    const off = ['0', 'false', 'no', 'none', 'off'].includes(mode);
    if (off || !Number.isFinite(days) || days <= 0 || (!mode && !pick('timeshift'))) {
      return { tv_archive: 0, tv_archive_duration: 0 };
    }

    const source = pick('catchup-source');
    return {
      tv_archive: 1,
      tv_archive_duration: days,
      catchup_mode: mode || 'shift',
      ...(source ? { catchup_source: source } : {})
    };
  }
}

/** A whole playlist from its items -- for text already in memory. */
export function playlistOf(items: Iterable<M3uItem>): M3uPlaylist {
  const builder = new M3uPlaylistBuilder();
  for (const item of items) {
    builder.add(item);
  }
  return builder.result();
}
