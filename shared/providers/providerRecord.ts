import { fnv1aHex, subscriptionId } from '../xtream/guideSourceId';

/**
 * One provider on an account: an Xtream login, an M3U playlist or a Stalker
 * (MAC) portal.
 *
 * This is what is sealed into a `provider_accounts` row, which the sync
 * service stores and cannot read. Each record
 * holds a slot `tag`, which is what the provider's ids are written under
 * everywhere else in the app -- favourites, history, order, guide matches,
 * hidden and locked categories. A replaced login keeps its slot's tag, which
 * is how a renewed subscription keeps all of that.
 *
 * The subscription an account had before there could be several is the
 * untagged slot, so none of what was already stored changes.
 */
interface RecordBase {
  /** '' for the first slot; a few lower-case letters and digits for the rest. */
  tag: string;
  /** What the category list's group header says. */
  label: string;
  /** Switched off: kept, and shown nowhere. */
  enabled: boolean;
  /** The username of the family manager whose subscription this is, when it was shared. */
  sharedBy?: string;
}

export interface XtreamRecord extends RecordBase {
  kind: 'xtream';
  serverUrl: string;
  username: string;
  password: string;
}

export interface M3uRecord extends RecordBase {
  kind: 'm3u';
  url: string;
}

/**
 * A Stalker portal: an address and the MAC address the provider registered
 * (shared/stalker). The MAC is a password, sealed like one. A few portals
 * ask for a login and password after the MAC as well.
 */
export interface StalkerRecord extends RecordBase {
  kind: 'stalker';
  portalUrl: string;
  mac: string;
  username?: string;
  password?: string;
}

export type ProviderRecord = XtreamRecord | M3uRecord | StalkerRecord;

/**
 * A sealed record, opened: the current shape, or the one from before there
 * could be several -- `{ serverUrl, username, password }` -- as the first
 * slot's Xtream login. Null for anything else.
 */
export function readProviderRecord(opened: string | null | undefined): ProviderRecord | null {
  if (!opened) {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(opened) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const text = (key: string) => (typeof parsed[key] === 'string' ? (parsed[key] as string) : '');
  const tag = isTag(text('tag')) ? text('tag') : '';
  const enabled = parsed['enabled'] !== false;
  const sharedBy = text('sharedBy') ? { sharedBy: text('sharedBy') } : {};

  if (parsed['kind'] === 'stalker') {
    const portalUrl = text('portalUrl');
    const mac = text('mac');
    if (!portalUrl || !mac) {
      return null;
    }
    const login = text('username') ? { username: text('username'), password: text('password') } : {};
    return { kind: 'stalker', tag, label: text('label') || hostOf(portalUrl), enabled, portalUrl, mac, ...login, ...sharedBy };
  }

  if (parsed['kind'] === 'm3u') {
    const url = text('url');
    return url ? { kind: 'm3u', tag, label: text('label') || hostOf(url), enabled, url, ...sharedBy } : null;
  }

  const serverUrl = text('serverUrl');
  const username = text('username');
  const password = text('password');
  if (!serverUrl || !username || !password) {
    return null;
  }
  return {
    kind: 'xtream',
    tag,
    label: text('label') || hostOf(serverUrl),
    enabled,
    serverUrl,
    username,
    password,
    ...sharedBy
  };
}

/**
 * The server's id for a record's row.
 *
 * An Xtream login keeps the id it always had, worked out from the address and
 * the username, so the row the account already has is the same row. A
 * playlist's is from its slot, since its address changes with its password.
 */
export function recordId(record: ProviderRecord): string {
  if (record.kind === 'xtream') {
    return subscriptionId(record.serverUrl, record.username);
  }
  // A portal's from the address and the MAC, as an Xtream login's is from its address and username.
  return record.kind === 'stalker'
    ? `portal-${record.tag || fnv1aHex(`${record.portalUrl}|${record.mac.toUpperCase()}`)}`
    : `m3u-${record.tag || fnv1aHex(record.url)}`;
}

// --- Tagged ids ----------------------------------------------------------------

export const TAG_SEPARATOR = '~';

/**
 * The category id of a provider's "All channels" row (TV-21), under the
 * provider's tag like any other. No provider numbers a category this way.
 */
export const ALL_CHANNELS_ID = '__all__';

/**
 * A provider's name as a card can carry it (TV-25): for an address, the part
 * that names it -- "bestplaylist" from "bestplaylist.example", "someprovider" from
 * "mag.someprovider.tv", not the "mag" in front -- and at most twelve characters,
 * since it is always the short part of a line that gives way.
 */
export function shortProviderName(label: string): string {
  const trimmed = label.trim();
  let name = trimmed;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(trimmed)) {
    const parts = trimmed.split('.');
    parts.pop();
    // "co.uk", "com.hr": a short second level belongs to the ending too.
    if (parts.length > 1 && parts[parts.length - 1].length <= 3) {
      parts.pop();
    }
    name = parts[parts.length - 1];
  }
  return name.length > 12 ? `${name.slice(0, 11)}…` : name;
}

const TAG_PATTERN = /^[a-z0-9]{2,8}$/;

const isTag = (text: string): boolean => TAG_PATTERN.test(text);

/** An id as the rest of the app stores it: untouched for the first slot. */
export function tagged(tag: string, id: string | number): string {
  return tag ? `${tag}${TAG_SEPARATOR}${id}` : String(id);
}

/** Which slot an id belongs to, and the provider's own id within it. */
export function untagged(id: string | number): { tag: string; id: string } {
  const text = String(id);
  const at = text.indexOf(TAG_SEPARATOR);
  if (at > 0 && isTag(text.slice(0, at))) {
    return { tag: text.slice(0, at), id: text.slice(at + 1) };
  }
  return { tag: '', id: text };
}

/** A tag no other slot on the account has. */
export function newTag(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken);
  for (;;) {
    const tag = `p${Math.floor(random() * 36 ** 3).toString(36).padStart(3, '0')}`;
    if (!used.has(tag)) {
      return tag;
    }
  }
}

/** Where a provider is: the server, the playlist or the portal. */
export function recordAddress(record: ProviderRecord | { kind: 'xtream'; serverUrl: string } | { kind: 'm3u'; url: string } | { kind: 'stalker'; portalUrl: string }): string {
  return record.kind === 'xtream' ? record.serverUrl : record.kind === 'm3u' ? record.url : record.portalUrl;
}

/** The host of an address, for a label nobody has given. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url.replace(/^\w+:\/\//, '').split(/[/?#:]/)[0] || url;
  }
}
