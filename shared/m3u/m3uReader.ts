/**
 * The entries of an M3U playlist, one at a time, from its bytes as they arrive.
 *
 * A playlist with films in it runs to tens of megabytes, and a television does
 * not survive holding one as a single string -- the lesson `jsonArrayStream`
 * was written from. Only the line being read is ever held here.
 *
 * What is read is the extended M3U that IPTV playlists use:
 *
 *   #EXTM3U x-tvg-url="http://guide.example/epg.xml.gz"
 *   #EXTINF:-1 tvg-id="HRT1.hr" tvg-logo="http://..." group-title="Croatia",HRT 1
 *   #EXTGRP:Croatia
 *   http://line.example/live/1.ts
 *
 * The `#EXTINF` line describes the next address line; `#EXTGRP` names a group
 * for an entry whose `#EXTINF` has none. Every other directive (`#KODIPROP`,
 * `#EXTVLCOPT` and the rest) is skipped: they tune a player, and ours choose
 * for themselves. An address with no `#EXTINF` before it -- a plain M3U -- is
 * still an entry, named after its address.
 */

/** The playlist's own header: where its guide is, when it says. */
export interface M3uHeader {
  kind: 'header';
  /** `x-tvg-url` and `url-tvg`, each of which may list several, comma-separated. */
  guideUrls: string[];
  /** Catch-up defaults for every entry, which an entry's own attributes override. */
  attributes: Record<string, string>;
}

export interface M3uEntry {
  kind: 'entry';
  /** The display name: the text after the `#EXTINF` line's first unquoted comma. */
  name: string;
  url: string;
  /** Lower-cased attribute names, as the playlist spelled their values. */
  attributes: Record<string, string>;
  /** `group-title`, or the `#EXTGRP` before it; empty when neither is given. */
  group: string;
  /** The `#EXTINF` duration: -1 for a stream that does not end, as live ones say. */
  duration: number;
}

export type M3uItem = M3uHeader | M3uEntry;

export async function* m3uItems(chunks: AsyncIterable<Uint8Array>): AsyncIterable<M3uItem> {
  const decoder = new TextDecoder('utf-8');
  const reader = new M3uLineReader();
  let rest = '';

  for await (const chunk of chunks) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split(/\r?\n|\r/);
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const item = reader.line(line);
      if (item) {
        yield item;
      }
    }
  }

  rest += decoder.decode();
  for (const line of rest.split(/\r?\n|\r/)) {
    const item = reader.line(line);
    if (item) {
      yield item;
    }
  }
}

/** The same, over text already in memory -- a small playlist, or a test. */
export function m3uItemsOf(text: string): M3uItem[] {
  const reader = new M3uLineReader();
  const items: M3uItem[] = [];
  for (const line of text.split(/\r?\n|\r/)) {
    const item = reader.line(line);
    if (item) {
      items.push(item);
    }
  }
  return items;
}

/** Line by line, holding only the description waiting for its address. */
class M3uLineReader {
  private info: { name: string; attributes: Record<string, string>; duration: number } | null = null;
  private groupLine = '';
  private first = true;

  line(raw: string): M3uItem | null {
    // A byte-order mark is common at the very start and invisible in an editor.
    const line = (this.first ? raw.replace(/^﻿/, '') : raw).trim();
    this.first = false;
    if (!line) {
      return null;
    }

    if (line.startsWith('#')) {
      const upper = line.slice(0, 8).toUpperCase();
      if (upper.startsWith('#EXTM3U')) {
        const attributes = attributesOf(line.slice(7));
        const guideUrls = [attributes['x-tvg-url'], attributes['url-tvg']]
          .filter((value): value is string => !!value)
          .flatMap(value => value.split(','))
          .map(value => value.trim())
          .filter(Boolean);
        return { kind: 'header', guideUrls: [...new Set(guideUrls)], attributes };
      }
      if (upper.startsWith('#EXTINF')) {
        this.info = parseExtinf(line);
        return null;
      }
      if (upper.startsWith('#EXTGRP')) {
        this.groupLine = line.slice(line.indexOf(':') + 1).trim();
      }
      return null;
    }

    const info = this.info;
    const group = info?.attributes['group-title'] ?? this.groupLine;
    this.info = null;
    this.groupLine = '';

    return {
      kind: 'entry',
      name: info?.name || info?.attributes['tvg-name']?.trim() || nameFromUrl(line),
      url: line,
      attributes: info?.attributes ?? {},
      group: group.trim(),
      duration: info?.duration ?? -1
    };
  }
}

/** `#EXTINF:-1 key="value" key2="value, with comma",Display name`. */
function parseExtinf(line: string): { name: string; attributes: Record<string, string>; duration: number } {
  const body = line.slice(line.indexOf(':') + 1);

  // The name follows the first comma outside quotes: attribute values carry
  // commas of their own ("Sport, News") often enough to matter.
  let quote: string | null = null;
  let comma = -1;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ',') {
      comma = i;
      break;
    }
  }

  const head = comma < 0 ? body : body.slice(0, comma);
  const name = comma < 0 ? '' : body.slice(comma + 1).trim();
  const duration = Number.parseFloat(head.trim().split(/\s+/)[0] ?? '');

  return {
    name,
    attributes: attributesOf(head),
    duration: Number.isFinite(duration) ? duration : -1
  };
}

/** `key="value"`, `key='value'` and `key=value`, names lower-cased. */
export function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    attributes[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4] ?? '').trim();
  }
  return attributes;
}

/** The last part of an address's path, for an entry that gave no name. */
function nameFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '');
  const last = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last) || url;
  } catch {
    return last || url;
  }
}
