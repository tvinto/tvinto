import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { open } from '../../shared/auth/secretBox';
import { XtreamClient } from '../../shared/xtream/client';
import { XtreamError } from '../../shared/xtream/protocol';
import { XtreamResponse, XtreamTransport, noResponse, timedOut } from '../../shared/xtream/transport';
import { ProviderRecord, readProviderRecord, recordId, tagged, untagged } from '../../shared/providers/providerRecord';
import { m3uItems } from '../../shared/m3u/m3uReader';
import { M3uPlaylistBuilder } from '../../shared/m3u/m3uPlaylist';
import { Category, StreamType } from '../../shared/types';
import { StalkerPortal, StalkerSend } from '../../shared/stalker/client';
import { StalkerSource } from '../../shared/stalker/stalkerSource';
import { Session, Untrusted, untrusted } from './account';
import { homeDir } from './store';

/**
 * Categories and channels, from the provider itself.
 *
 * The provider allows one connection and is never swept: one request per
 * list, kept for a day on this machine and never synced. The login is opened
 * in this process to make the request and goes nowhere else -- not into the
 * cache, not into any output. Names come from the provider and are untrusted.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** A category as tvinto shows it: the id the app stores, and its name. */
export interface CategoryView {
  /** Tagged with the provider's slot, as hidden and locked categories store it. */
  id: string;
  name: Untrusted;
  provider: Untrusted;
}

/** Fetch, with a timeout, and nothing logged: the URL holds the login. */
export class FetchTransport implements XtreamTransport {
  constructor(
    private readonly fetch: (url: string, init?: RequestInit) => Promise<Response>,
    private readonly defaultTimeoutMs = 20_000
  ) {}

  async get(url: string, params: Record<string, unknown>, timeoutMs?: number): Promise<XtreamResponse> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        query.set(key, String(value));
      }
    }
    const abort = new AbortController();
    const expiry = setTimeout(() => abort.abort(), timeoutMs ?? this.defaultTimeoutMs);
    try {
      const response = await this.fetch(`${url}?${query.toString()}`, { signal: abort.signal });
      const body = await response.text();
      let data: unknown = null;
      try {
        data = body ? JSON.parse(body) : null;
      } catch {
        data = null;
      }
      return { status: response.status, data };
    } catch (error) {
      // Never the error's own message: it can carry the URL, and the URL the login.
      throw abort.signal.aborted ? timedOut() : error instanceof XtreamError ? error : noResponse();
    } finally {
      clearTimeout(expiry);
    }
  }
}

/** The account's providers, opened. Never shown: they hold logins. */
export async function openProviders(current: Session): Promise<ProviderRecord[]> {
  const me = await current.service.me();
  const records: ProviderRecord[] = [];
  for (const row of me.providers) {
    const record = readProviderRecord(await open(row.payload, current.enc));
    if (record) {
      records.push(record);
    }
  }
  return records;
}

/** Where something is cached: named by a hash, so the file name says nothing either. */
export const cacheFile = (key: string): string =>
  path.join(homeDir(), 'cache', `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`);

/** What is cached under a key, while it is less than a day old. */
export function cached<T>(key: string, now: number): T | null {
  try {
    const kept = JSON.parse(fs.readFileSync(cacheFile(key), 'utf8')) as { at: number; data: T };
    return now - kept.at < DAY_MS ? kept.data : null;
  } catch {
    return null;
  }
}

/** Keeps something for a day. Only ids and names ever go in: nothing of a login. */
export function keep(key: string, now: number, data: unknown): void {
  const file = cacheFile(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: now, data }));
}

/** A channel as tvinto shows it: the id the app stores and matches by, its name, the guide id its provider gives. */
export interface ChannelView {
  /** Tagged with the provider's slot, as the app's lists and matches store it. */
  id: string;
  name: Untrusted;
  /** The provider's own guide channel id, which the app matches by when nobody matched by hand. */
  guideId: Untrusted | null;
}

/** A channel as cached: ids and names. */
/**
 * A Stalker portal (shared/stalker), asked through Node's fetch, which sets
 * the cookie and user agent a portal reads -- a browser's would not. The MAC
 * goes in that cookie and nowhere in what is printed.
 */
function portalOf(record: Extract<ProviderRecord, { kind: 'stalker' }>, fetch: Fetcher): StalkerSource {
  const send: StalkerSend = async request => {
    const url = new URL(request.url);
    Object.entries(request.query).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url.toString(), { headers: request.headers, signal: AbortSignal.timeout(request.timeoutMs) });
    return { status: response.status, text: await response.text() };
  };
  const login = record.username ? { login: { username: record.username, password: record.password ?? '' } } : {};
  return new StalkerSource(new StalkerPortal(send, record.portalUrl, record.mac, login));
}

interface ChannelRow {
  stream_id: string;
  name: string;
  epg_channel_id?: string;
}

/**
 * An M3U playlist, read once a day: its categories of each kind, and its
 * live channels by category. Never the addresses -- an entry's address can
 * carry the playlist's login.
 */
interface PlaylistDigest {
  categories: Record<StreamType, { category_id: string; category_name: string }[]>;
  live: Record<string, ChannelRow[]>;
}

const rowOf = (stream: { stream_id: string | number; name: string; epg_channel_id?: string }): ChannelRow => ({
  stream_id: String(stream.stream_id),
  name: stream.name,
  ...(stream.epg_channel_id ? { epg_channel_id: stream.epg_channel_id } : {})
});

async function playlistOf(record: ProviderRecord & { kind: 'm3u' }, fetch: Fetcher, fresh: boolean, now: number): Promise<PlaylistDigest> {
  const key = `${recordId(record)}|playlist`;
  const kept = fresh ? null : cached<PlaylistDigest>(key, now);
  if (kept) {
    return kept;
  }
  let response: Response;
  try {
    response = await fetch(record.url);
  } catch {
    // Never the error's own message: it can carry the address, and the address the login.
    throw new Error(`The playlist "${record.label}" could not be reached.`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`The playlist "${record.label}" answered ${response.status}.`);
  }
  const builder = new M3uPlaylistBuilder();
  for await (const item of m3uItems(response.body as unknown as AsyncIterable<Uint8Array>)) {
    builder.add(item);
  }
  const playlist = builder.result();
  const pick = (list: Category[]) => list.map(({ category_id, category_name }) => ({ category_id, category_name }));
  const digest: PlaylistDigest = {
    categories: { live: pick(playlist.categories.live), vod: pick(playlist.categories.vod), series: pick(playlist.categories.series) },
    live: {}
  };
  for (const [categoryId, streams] of playlist.streams.live) {
    digest.live[categoryId] = streams.map(rowOf);
  }
  keep(key, now, digest);
  return digest;
}

const xtreamClient = (record: ProviderRecord & { kind: 'xtream' }, fetch: Fetcher) =>
  new XtreamClient(new FetchTransport(fetch), {
    serverUrl: record.serverUrl,
    username: record.username,
    password: record.password
  });

/**
 * One kind of category across the account's switched-on providers: an
 * Xtream provider's list, or an M3U playlist's groups.
 *
 * `fresh` skips the cache, for a person who knows the provider changed.
 */
export async function categories(
  current: Session,
  type: StreamType,
  fetch: Fetcher,
  options: { fresh?: boolean; now?: number } = {}
): Promise<{ categories: CategoryView[] }> {
  const now = options.now ?? Date.now();
  const shown: CategoryView[] = [];

  for (const record of await openProviders(current)) {
    if (!record.enabled) {
      continue;
    }

    let list: { category_id: string; category_name: string }[];
    if (record.kind === 'm3u') {
      list = (await playlistOf(record, fetch, Boolean(options.fresh), now)).categories[type];
    } else if (record.kind === 'stalker') {
      const key = `${recordId(record)}|${type}`;
      const kept = options.fresh ? null : cached<{ category_id: string; category_name: string }[]>(key, now);
      list = kept ?? (await portalOf(record, fetch).getCategories(type));
      if (!kept) {
        keep(key, now, list.map(({ category_id, category_name }) => ({ category_id, category_name })));
      }
    } else {
      const key = `${recordId(record)}|${type}`;
      const kept = options.fresh ? null : cached<{ category_id: string; category_name: string }[]>(key, now);
      list = kept ?? (await xtreamClient(record, fetch).getCategories(type));
      if (!kept) {
        keep(key, now, list.map(({ category_id, category_name }) => ({ category_id, category_name })));
      }
    }

    for (const category of list) {
      shown.push({
        id: tagged(record.tag, category.category_id),
        name: untrusted(category.category_name),
        provider: untrusted(record.label)
      });
    }
  }
  return { categories: shown };
}

/**
 * The live channels of one category, by the id `tvinto categories live`
 * gave: one request to its provider, kept a day; an M3U playlist's from the
 * playlist read for its categories.
 */
export async function channels(
  current: Session,
  categoryId: string,
  fetch: Fetcher,
  options: { fresh?: boolean; now?: number } = {}
): Promise<ChannelView[]> {
  const now = options.now ?? Date.now();
  const { tag, id } = untagged(categoryId);
  const notFound = () => new Error(`No category ${categoryId}. tvinto categories live lists them with their ids.`);
  const record = (await openProviders(current)).find(candidate => candidate.tag === tag && candidate.enabled);
  if (!record) {
    throw notFound();
  }

  let rows: ChannelRow[] | undefined;
  if (record.kind === 'm3u') {
    rows = (await playlistOf(record, fetch, Boolean(options.fresh), now)).live[id];
  } else if (record.kind === 'stalker') {
    const key = `${recordId(record)}|live|${id}`;
    rows = (options.fresh ? null : cached<ChannelRow[]>(key, now)) ?? undefined;
    if (!rows) {
      rows = (await portalOf(record, fetch).getStreams('live', id)).map(rowOf);
      keep(key, now, rows);
    }
  } else {
    // An Xtream provider answers an unknown category with an empty list, not
    // a refusal; its category list, kept a day already, says which it is.
    if (!(await categories(current, 'live', fetch, { now })).categories.some(category => category.id === categoryId)) {
      throw notFound();
    }
    const key = `${recordId(record)}|live|${id}`;
    rows = (options.fresh ? null : cached<ChannelRow[]>(key, now)) ?? undefined;
    if (!rows) {
      rows = (await xtreamClient(record, fetch).getStreams('live', id)).map(rowOf);
      keep(key, now, rows);
    }
  }
  if (!rows) {
    throw notFound();
  }

  // Remembered by id, so that a match's preview can name the channel.
  const namesKey = `${current.config.server}|${current.config.username}|channel-names`;
  const names = cached<Record<string, string>>(namesKey, now) ?? {};
  for (const row of rows) {
    names[tagged(record.tag, row.stream_id)] = row.name;
  }
  keep(namesKey, now, names);

  return rows.map(row => ({
    id: tagged(record.tag, row.stream_id),
    name: untrusted(row.name),
    guideId: row.epg_channel_id ? untrusted(row.epg_channel_id) : null
  }));
}

/** A channel's name, if tvinto listed its category in the last day. */
export function channelName(current: Session, id: string, now = Date.now()): string | null {
  return cached<Record<string, string>>(`${current.config.server}|${current.config.username}|channel-names`, now)?.[id] ?? null;
}
