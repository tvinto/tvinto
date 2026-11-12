import { open } from '../../shared/auth/secretBox';
import { hostOf } from '../../shared/providers/providerRecord';
import { guideTextFromBytes } from '../../shared/xtream/guideBytes';
import { KnownChannel } from '../../shared/xtream/guide';
import { parseXmltv } from '../../shared/xtream/xmltv';
import { PullResult } from '../../shared/sync';
import { Session } from './account';
import { cached, keep } from './provider';

/**
 * A guide's channels, for matching by hand.
 *
 * A guide is tens of megabytes, nearly all of it programmes. XMLTV lists its
 * channels first, so the download is stopped at the first programme: what is
 * read is the channel list and little more. Kept a day, ids and names only --
 * an Xtream guide's address holds the provider's login, and it goes nowhere.
 */

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** The most text read looking for the end of the channel list. */
const MAX_CHARS = 32 * 1024 * 1024;

/** A guide of the account, opened: its id, name, address and whether it is on. */
export interface OpenedGuide {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
}

export async function openedGuides(current: Session, pulled: PullResult): Promise<OpenedGuide[]> {
  const shown: OpenedGuide[] = [];
  for (const source of pulled.guideSources ?? []) {
    const opened = await open(source.payload, current.enc);
    if (!opened) {
      continue;
    }
    try {
      const details = JSON.parse(opened) as { label?: unknown; url?: unknown; enabled?: unknown };
      if (typeof details.url === 'string') {
        shown.push({
          id: source.id,
          label: typeof details.label === 'string' && details.label ? details.label : hostOf(details.url),
          url: details.url,
          enabled: details.enabled !== false
        });
      }
    } catch {
      // Not a guide this version can read; left out.
    }
  }
  return shown;
}

/** The `<channel>` elements of what has been read, and whether the programmes have begun. */
const CHANNEL = /<channel\b[^>]*?(?:\/>|>[\s\S]*?<\/channel>)/g;

/** The channels a guide lists, read from its start and kept a day. */
export async function guideChannels(
  guide: OpenedGuide,
  fetch: Fetcher,
  options: { fresh?: boolean; now?: number } = {}
): Promise<KnownChannel[]> {
  const now = options.now ?? Date.now();
  const key = `${guide.id}|guide-channels`;
  const kept = options.fresh ? null : cached<{ id: string; name: string }[]>(key, now);
  if (kept) {
    return kept.map(channel => ({ ...channel, sourceId: guide.id }));
  }

  const abort = new AbortController();
  let response: Response;
  try {
    response = await fetch(guide.url, { signal: abort.signal });
  } catch {
    // Never the error's own message: it can carry the address, and the address the login.
    throw new Error(`The guide "${guide.label}" could not be reached.`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`The guide "${guide.label}" answered ${response.status}.`);
  }

  let text = '';
  try {
    for await (const chunk of guideTextFromBytes(response.body as unknown as AsyncIterable<Uint8Array>, { maxChars: MAX_CHARS })) {
      text += chunk;
      const programmes = text.indexOf('<programme');
      if (programmes >= 0) {
        text = text.slice(0, programmes);
        break;
      }
    }
  } finally {
    // The rest of the guide is programmes: not downloaded.
    abort.abort();
  }

  const elements = text.match(CHANNEL) ?? [];
  const channels = parseXmltv(`<tv>${elements.join('')}</tv>`).channels.map(channel => ({ id: channel.id, name: channel.name || channel.id }));
  if (!channels.length) {
    throw new Error(`The guide "${guide.label}" lists no channels.`);
  }
  keep(key, now, channels);
  return channels.map(channel => ({ ...channel, sourceId: guide.id }));
}
