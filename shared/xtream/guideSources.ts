import { guideSourceId } from './guideSourceId';

/**
 * The guides an account has chosen, and which stream each one describes.
 *
 * Account state rather than device state, which is the whole point: signing in
 * somewhere new should offer the guides you already use rather than send you
 * looking for the URL again. What each device has actually downloaded is its
 * own business and stays there.
 *
 * Pure and separate from where it is kept, because where it is kept is about
 * to change -- today localStorage beside the other account data, and a
 * Cloudflare Worker once there is one. A guide's URL is treated as a
 * credential, because a provider's guide URL carries the subscription's login.
 */

export interface GuideSource {
  /** Derived from the URL, so re-adding the same feed is not a second copy. */
  id: string;
  /** What to call it on screen. */
  label: string;
  url: string;
  /** Whether it is consulted. Kept rather than deleted, so it can come back. */
  enabled: boolean;
  addedAt: string;
  /**
   * When it last changed, which is what two devices reconcile on.
   *
   * Optional because state written before sources travelled has none, and
   * `sourceStamp` falls back to `addedAt` for those.
   */
  updatedAt?: string;
}

/**
 * One stream tied to one guide channel, by hand.
 *
 * For where automatic matching cannot reach: a provider filling in no channel
 * id at all, or filling in one no feed has heard of. Nearly half a real
 * line-up is in that state.
 *
 * The source is recorded alongside the channel because the same channel id can
 * exist in several guides, and choosing which guide to believe is part of what
 * was decided.
 */
export interface ChannelMapping {
  streamId: string;
  channelId: string;
  sourceId: string;
  mappedAt: string;
}

export interface GuideSourceState {
  sources: GuideSource[];
  /** Keyed by stream id, because that is how it is always read. */
  mappings: Record<string, ChannelMapping>;
}

export const emptyGuideSources = (): GuideSourceState => ({ sources: [], mappings: {} });

/**
 * Whether text can be a guide's address: http or https, with a host. "not a
 * url" was taken as one, and on the desktop fetched the app's own page and
 * reported a guide of nothing (11 October).
 */
export const isGuideAddress = (text: string): boolean => {
  try {
    const parsed = new URL(text.trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
  } catch {
    return false;
  }
};

/** A label worth showing when the person did not give one. */
export const labelFor = (url: string): string => {
  try {
    const parsed = new URL(url);
    const file = parsed.pathname.split('/').filter(Boolean).pop();
    // The host says more than `xmltv.php` does, and a guide URL's path is
    // frequently just that.
    return file && !/^(xmltv|epg)\.(php|xml|gz)$/i.test(file)
      ? `${parsed.hostname} (${file})`
      : parsed.hostname;
  } catch {
    return 'Guide';
  }
};

/**
 * Adds a source, or updates the one already there for that URL.
 *
 * Adding the same feed twice is a mistake rather than an intention, and the id
 * being derived from the URL is what makes it recognisable as one. A repeat
 * keeps the original's place in the list and takes the new label.
 */
export const addSource = (
  state: GuideSourceState,
  url: string,
  options: { label?: string; now?: () => Date } = {}
): GuideSourceState => {
  const trimmed = url.trim();
  if (!trimmed) {
    return state;
  }

  const id = guideSourceId(trimmed);
  const label = options.label?.trim() || labelFor(trimmed);
  const now = (options.now ?? (() => new Date()))().toISOString();

  const existing = state.sources.find(source => source.id === id);
  if (existing) {
    return {
      ...state,
      sources: state.sources.map(source =>
        source.id === id ? { ...source, label, url: trimmed, updatedAt: now } : source
      )
    };
  }

  return {
    ...state,
    sources: [
      ...state.sources,
      { id, label, url: trimmed, enabled: true, addedAt: now, updatedAt: now }
    ]
  };
};

/**
 * Removes a source, and every mapping that pointed into it.
 *
 * Leaving the mappings would leave rows pointing at a guide that is no longer
 * consulted -- which reads as a channel mapped to nothing, and cannot be
 * corrected because the thing it names is gone.
 */
export const removeSource = (state: GuideSourceState, sourceId: string): GuideSourceState => {
  const mappings: Record<string, ChannelMapping> = {};
  for (const [streamId, mapping] of Object.entries(state.mappings)) {
    if (mapping.sourceId !== sourceId) {
      mappings[streamId] = mapping;
    }
  }

  return { sources: state.sources.filter(source => source.id !== sourceId), mappings };
};

export const setSourceEnabled = (
  state: GuideSourceState,
  sourceId: string,
  enabled: boolean,
  now: () => Date = () => new Date()
): GuideSourceState => ({
  ...state,
  sources: state.sources.map(source =>
    source.id === sourceId ? { ...source, enabled, updatedAt: now().toISOString() } : source
  )
});

/** The sources actually consulted, in the order they were added. */
export const enabledSources = (state: GuideSourceState): GuideSource[] =>
  state.sources.filter(source => source.enabled);

/**
 * Records that a stream is described by a particular guide channel.
 *
 * One channel per stream. Two would mean two schedules on one row with nothing
 * to say which is right, and the person choosing has already answered that.
 */
export const mapChannel = (
  state: GuideSourceState,
  streamId: string,
  channelId: string,
  sourceId: string,
  now: () => Date = () => new Date()
): GuideSourceState => ({
  ...state,
  mappings: {
    ...state.mappings,
    [String(streamId)]: {
      streamId: String(streamId),
      channelId,
      sourceId,
      mappedAt: now().toISOString()
    }
  }
});

/**
 * Forgets a mapping, returning the stream to automatic matching.
 *
 * Which is not the same as mapping it to nothing. Someone undoing a choice
 * wants the guess back, not an empty row.
 */
export const unmapChannel = (state: GuideSourceState, streamId: string): GuideSourceState => {
  const mappings = { ...state.mappings };
  delete mappings[String(streamId)];
  return { ...state, mappings };
};

/**
 * When a source last changed, for reconciling two devices.
 *
 * Falls back to when it was added, because state written before sources
 * travelled has no other stamp -- and "when I added it" is the only honest
 * answer available for one of those.
 */
export const sourceStamp = (source: GuideSource): string => source.updatedAt ?? source.addedAt;

/**
 * Marks a source as written now, without changing anything about it.
 *
 * For repair rather than editing. A guide travels sealed, and a device that
 * finds the sealed copy unreadable -- because the account's key has changed
 * since it was sealed -- can only mend it by sending its own copy again. That
 * is a new write and has to be stamped as one: reconciliation is
 * last-write-wins, so a repair carrying the original stamp would lose to the
 * unreadable copy it is meant to replace.
 */
export const touchSource = (
  state: GuideSourceState,
  sourceId: string,
  now: () => Date = () => new Date()
): GuideSourceState => ({
  ...state,
  sources: state.sources.map(source =>
    source.id === sourceId ? { ...source, updatedAt: now().toISOString() } : source
  )
});

/** What another device says about this account's guides. */
export interface IncomingGuides {
  sources: Array<{ change: { id: string; updatedAt: string }; source?: GuideSource }>;
  mappings: Array<{ streamId: string; sourceId: string; channelId: string; updatedAt: string }>;
  deletions: Array<{ kind: string; key: string; deletedAt: string }>;
}

/**
 * Folds what other devices did into what this one holds.
 *
 * Last-write-wins on the same timestamps the servers compare, so both ends
 * reach the same answer from the same facts rather than one deferring to the
 * other. Deletions are applied first, for the same reason a push sends them
 * first: a batch that both removes and re-adds means the re-add is the later
 * intent.
 *
 * A source whose payload could not be opened arrives with `source` absent. It
 * is skipped rather than treated as a removal -- this device cannot read it,
 * which is not the same as it not existing.
 */
export const mergeIncoming = (
  state: GuideSourceState,
  incoming: IncomingGuides
): GuideSourceState => {
  let sources = [...state.sources];
  const mappings = { ...state.mappings };

  for (const deletion of incoming.deletions) {
    if (deletion.kind === 'guideSource') {
      const held = sources.find(source => source.id === deletion.key);
      if (held && sourceStamp(held) <= deletion.deletedAt) {
        sources = sources.filter(source => source.id !== deletion.key);
        for (const [streamId, mapping] of Object.entries(mappings)) {
          if (mapping.sourceId === deletion.key) {
            delete mappings[streamId];
          }
        }
      }
    } else if (deletion.kind === 'channelMapping') {
      const held = mappings[deletion.key];
      if (held && held.mappedAt <= deletion.deletedAt) {
        delete mappings[deletion.key];
      }
    }
  }

  for (const { change, source } of incoming.sources) {
    if (!source) {
      continue;
    }

    const held = sources.find(candidate => candidate.id === change.id);
    if (held && sourceStamp(held) >= change.updatedAt) {
      continue;
    }

    const arriving = { ...source, updatedAt: change.updatedAt };
    sources = held
      ? sources.map(candidate => (candidate.id === change.id ? arriving : candidate))
      : [...sources, arriving];
  }

  for (const mapping of incoming.mappings) {
    const held = mappings[mapping.streamId];
    if (held && held.mappedAt >= mapping.updatedAt) {
      continue;
    }

    mappings[mapping.streamId] = {
      streamId: mapping.streamId,
      channelId: mapping.channelId,
      sourceId: mapping.sourceId,
      mappedAt: mapping.updatedAt
    };
  }

  return { sources, mappings };
};
