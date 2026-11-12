import {
  GuideSource,
  GuideSourceState,
  addSource,
  emptyGuideSources,
  enabledSources,
  isGuideAddress,
  labelFor,
  mapChannel,
  mergeIncoming,
  removeSource,
  setSourceEnabled,
  sourceStamp,
  touchSource,
  unmapChannel
} from './guideSources';

const at = (iso: string) => () => new Date(iso);
const NOW = at('2026-08-30T12:00:00Z');

const FEED = 'https://epgshare01.online/epgshare01/epg_ripper_HR1.xml.gz';
const PROVIDER = 'http://mag.example/xmltv.php?username=c0ffee&password=hunter2';

describe('addSource', () => {
  it('adds a source with an id derived from its URL', () => {
    const state = addSource(emptyGuideSources(), FEED, { now: NOW });

    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].url).toBe(FEED);
    expect(state.sources[0].enabled).toBe(true);
    expect(state.sources[0].addedAt).toBe('2026-08-30T12:00:00.000Z');
  });

  // Adding the same feed twice is a mistake rather than an intention, and the
  // id being derived from the URL is what makes it recognisable as one.
  it('does not add the same feed twice', () => {
    let state = addSource(emptyGuideSources(), FEED, { now: NOW });
    state = addSource(state, FEED, { now: NOW });

    expect(state.sources).toHaveLength(1);
  });

  it('keeps the original position and takes the new label on a repeat', () => {
    let state = addSource(emptyGuideSources(), FEED, { label: 'First', now: NOW });
    state = addSource(state, 'http://other.example/epg.xml', { now: NOW });
    state = addSource(state, FEED, { label: 'Renamed', now: NOW });

    expect(state.sources.map(s => s.label)).toEqual(['Renamed', 'other.example']);
  });

  it('ignores an empty URL', () => {
    expect(addSource(emptyGuideSources(), '   ').sources).toHaveLength(0);
  });

  it('trims what was pasted', () => {
    expect(addSource(emptyGuideSources(), `  ${FEED}  `).sources[0].url).toBe(FEED);
  });
});

describe('labelFor', () => {
  it('names a feed by its host and file', () => {
    expect(labelFor(FEED)).toBe('epgshare01.online (epg_ripper_HR1.xml.gz)');
  });

  // A guide URL's path is frequently just `xmltv.php`, which says nothing that
  // the host has not already said.
  it('names a provider guide by its host alone', () => {
    expect(labelFor(PROVIDER)).toBe('mag.example');
  });

  it('falls back rather than throwing on something that is not a URL', () => {
    expect(labelFor('not a url')).toBe('Guide');
  });
});

describe('setSourceEnabled and enabledSources', () => {
  it('leaves a disabled source in place rather than removing it', () => {
    let state = addSource(emptyGuideSources(), FEED, { now: NOW });
    const id = state.sources[0].id;
    state = setSourceEnabled(state, id, false);

    expect(state.sources).toHaveLength(1);
    expect(enabledSources(state)).toEqual([]);
  });

  it('brings it back', () => {
    let state = addSource(emptyGuideSources(), FEED, { now: NOW });
    const id = state.sources[0].id;
    state = setSourceEnabled(state, id, false);
    state = setSourceEnabled(state, id, true);

    expect(enabledSources(state)).toHaveLength(1);
  });

  it('keeps the order they were added in', () => {
    let state = addSource(emptyGuideSources(), 'http://a.example/1.xml', { now: NOW });
    state = addSource(state, 'http://b.example/2.xml', { now: NOW });

    expect(enabledSources(state).map(s => s.url)).toEqual([
      'http://a.example/1.xml',
      'http://b.example/2.xml'
    ]);
  });
});

describe('removeSource', () => {
  it('removes the source', () => {
    let state = addSource(emptyGuideSources(), FEED, { now: NOW });
    state = removeSource(state, state.sources[0].id);

    expect(state.sources).toEqual([]);
  });

  // Otherwise the mapping points into a guide that is no longer there, which
  // reads as a channel mapped to nothing and cannot be corrected.
  it('takes the mappings that pointed into it', () => {
    let state = addSource(emptyGuideSources(), FEED, { now: NOW });
    const gone = state.sources[0].id;
    state = addSource(state, 'http://other.example/epg.xml', { now: NOW });
    const kept = state.sources[1].id;

    state = mapChannel(state, '101', 'HTV1.HD.hr', gone, NOW);
    state = mapChannel(state, '102', 'Doma.TV.hr', kept, NOW);

    state = removeSource(state, gone);

    expect(Object.keys(state.mappings)).toEqual(['102']);
  });
});

describe('mapChannel and unmapChannel', () => {
  it('records the channel, the source and when', () => {
    const state = mapChannel(emptyGuideSources(), '101', 'HTV1.HD.hr', 'src-1', NOW);

    expect(state.mappings['101']).toEqual({
      streamId: '101',
      channelId: 'HTV1.HD.hr',
      sourceId: 'src-1',
      mappedAt: '2026-08-30T12:00:00.000Z'
    });
  });

  // Two would be two schedules on one row with nothing to say which is right,
  // and the person choosing has already answered that.
  it('keeps one channel per stream, replacing an earlier choice', () => {
    let state = mapChannel(emptyGuideSources(), '101', 'HTV1.HD.hr', 'src-1', NOW);
    state = mapChannel(state, '101', 'HTV2.HD.hr', 'src-2', NOW);

    expect(state.mappings['101'].channelId).toBe('HTV2.HD.hr');
    expect(Object.keys(state.mappings)).toHaveLength(1);
  });

  it('accepts a numeric stream id and keys it as a string', () => {
    const state = mapChannel(emptyGuideSources(), 101 as unknown as string, 'a', 'src-1', NOW);

    expect(state.mappings['101']).toBeDefined();
  });

  // Undoing a choice should give the guess back, not an empty row.
  it('forgets a mapping so automatic matching resumes', () => {
    let state = mapChannel(emptyGuideSources(), '101', 'HTV1.HD.hr', 'src-1', NOW);
    state = unmapChannel(state, '101');

    expect(state.mappings['101']).toBeUndefined();
  });

  it('leaves the other mappings alone', () => {
    let state = mapChannel(emptyGuideSources(), '101', 'a', 'src-1', NOW);
    state = mapChannel(state, '102', 'b', 'src-1', NOW);
    state = unmapChannel(state, '101');

    expect(Object.keys(state.mappings)).toEqual(['102']);
  });

  it('does not mind being asked to forget one that was never there', () => {
    expect(unmapChannel(emptyGuideSources(), '999').mappings).toEqual({});
  });
});

describe('the state as a whole', () => {
  // It is about to be written to storage and, later, to a Worker.
  it('survives a round trip through JSON', () => {
    let state = addSource(emptyGuideSources(), FEED, { now: NOW });
    state = mapChannel(state, '101', 'HTV1.HD.hr', state.sources[0].id, NOW);

    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('never mutates what it was given', () => {
    const original = addSource(emptyGuideSources(), FEED, { now: NOW });
    const copy = structuredClone(original);

    mapChannel(original, '101', 'a', 'src-1', NOW);
    removeSource(original, original.sources[0].id);
    setSourceEnabled(original, original.sources[0].id, false);

    expect(original).toEqual(copy);
  });
});

describe('mergeIncoming', () => {
  // Named `hour` rather than `at`, which this file already uses for something
  // else: a factory returning a Date, where these are ISO strings.
  const hour = (h: number) => `2026-08-30T${String(h).padStart(2, '0')}:00:00.000Z`;

  const source = (id: string, label: string, updatedAt: string): GuideSource => ({
    id,
    label,
    url: `http://a.example/${id}.xml`,
    enabled: true,
    addedAt: updatedAt,
    updatedAt
  });

  const held = (): GuideSourceState => ({
    sources: [source('src-a', 'Mine', hour(10))],
    mappings: {
      '101': { streamId: '101', channelId: 'HTV1.hr', sourceId: 'src-a', mappedAt: hour(10) }
    }
  });

  const nothing = { sources: [], mappings: [], deletions: [] };

  it('takes a guide this device has never seen', () => {
    const merged = mergeIncoming(held(), {
      ...nothing,
      sources: [{ change: { id: 'src-b', updatedAt: hour(11) }, source: source('src-b', 'Theirs', hour(11)) }]
    });

    expect(merged.sources.map(s => s.id).sort()).toEqual(['src-a', 'src-b']);
  });

  it('takes a newer version of one it has', () => {
    const merged = mergeIncoming(held(), {
      ...nothing,
      sources: [{ change: { id: 'src-a', updatedAt: hour(12) }, source: source('src-a', 'Renamed', hour(12)) }]
    });

    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0].label).toBe('Renamed');
  });

  it('keeps its own when the arriving one is older', () => {
    const merged = mergeIncoming(held(), {
      ...nothing,
      sources: [{ change: { id: 'src-a', updatedAt: hour(8) }, source: source('src-a', 'Stale', hour(8)) }]
    });

    expect(merged.sources[0].label).toBe('Mine');
  });

  it('skips one it cannot open rather than treating it as gone', () => {
    const merged = mergeIncoming(held(), {
      ...nothing,
      sources: [{ change: { id: 'src-a', updatedAt: hour(12) }, source: undefined }]
    });

    // Unreadable is not the same as absent: the password changed elsewhere and
    // this device still holds the old key.
    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0].label).toBe('Mine');
  });

  it('removes a guide, and the mappings that pointed into it', () => {
    const merged = mergeIncoming(held(), {
      ...nothing,
      deletions: [{ kind: 'guideSource', key: 'src-a', deletedAt: hour(11) }]
    });

    // A mapping left behind names a guide that is no longer consulted, which
    // reads as a channel mapped to nothing and cannot be corrected.
    expect(merged.sources).toEqual([]);
    expect(merged.mappings).toEqual({});
  });

  it('ignores a removal older than the guide it names', () => {
    const merged = mergeIncoming(held(), {
      ...nothing,
      deletions: [{ kind: 'guideSource', key: 'src-a', deletedAt: hour(9) }]
    });

    expect(merged.sources).toHaveLength(1);
  });

  it('lets a removal and a later re-add settle on the re-add', () => {
    const merged = mergeIncoming(held(), {
      sources: [{ change: { id: 'src-a', updatedAt: hour(13) }, source: source('src-a', 'Back', hour(13)) }],
      mappings: [],
      deletions: [{ kind: 'guideSource', key: 'src-a', deletedAt: hour(11) }]
    });

    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0].label).toBe('Back');
  });

  it('takes a newer mapping and refuses an older one', () => {
    const newer = mergeIncoming(held(), {
      ...nothing,
      mappings: [
        { streamId: '101', sourceId: 'src-a', channelId: 'HTV1.HD.hr', updatedAt: hour(12) }
      ]
    });
    const older = mergeIncoming(held(), {
      ...nothing,
      mappings: [{ streamId: '101', sourceId: 'src-a', channelId: 'Wrong.hr', updatedAt: hour(8) }]
    });

    // Work done by hand on two devices must not be lost to whichever synced
    // second.
    expect(newer.mappings['101'].channelId).toBe('HTV1.HD.hr');
    expect(older.mappings['101'].channelId).toBe('HTV1.hr');
  });

  it('removes a mapping that was unmapped elsewhere', () => {
    const merged = mergeIncoming(held(), {
      ...nothing,
      deletions: [{ kind: 'channelMapping', key: '101', deletedAt: hour(11) }]
    });

    expect(merged.mappings).toEqual({});
  });

  it('leaves everything alone when there is nothing to fold in', () => {
    expect(mergeIncoming(held(), nothing)).toEqual(held());
  });

  it('reconciles a source written before sources travelled', () => {
    // No updatedAt at all, which is what older storage holds. It falls back to
    // when it was added, so an arriving change still resolves rather than
    // comparing against undefined.
    const old: GuideSourceState = {
      sources: [{ id: 'src-a', label: 'Old', url: 'http://a', enabled: true, addedAt: hour(10) }],
      mappings: {}
    };

    const merged = mergeIncoming(old, {
      ...nothing,
      sources: [{ change: { id: 'src-a', updatedAt: hour(12) }, source: source('src-a', 'New', hour(12)) }]
    });

    expect(merged.sources[0].label).toBe('New');
  });
});

describe('touchSource', () => {
  const held = (): GuideSourceState => ({
    sources: [
      {
        id: 'src-a',
        label: 'A guide',
        url: FEED,
        enabled: true,
        addedAt: '2026-08-30T10:00:00.000Z',
        updatedAt: '2026-08-30T10:00:00.000Z'
      }
    ],
    mappings: {}
  });

  it('makes the stamp newer without changing anything else', () => {
    // What a repair needs. The sealed copy on the service cannot be opened,
    // and reconciliation is last-write-wins -- so sending this device's copy
    // back under the original stamp would lose to the copy it is mending.
    const touched = touchSource(held(), 'src-a', at('2026-08-31T09:00:00Z'));

    expect(sourceStamp(touched.sources[0])).toBe('2026-08-31T09:00:00.000Z');
    expect({ ...touched.sources[0], updatedAt: undefined }).toEqual({
      ...held().sources[0],
      updatedAt: undefined
    });
  });

  it('leaves the other sources alone', () => {
    const two: GuideSourceState = {
      ...held(),
      sources: [
        ...held().sources,
        { id: 'src-b', label: 'B', url: PROVIDER, enabled: false, addedAt: '2026-08-30T11:00:00.000Z' }
      ]
    };

    const touched = touchSource(two, 'src-a', at('2026-08-31T09:00:00Z'));

    expect(touched.sources[1]).toEqual(two.sources[1]);
  });

  it('does nothing for an id it has never heard of', () => {
    expect(touchSource(held(), 'src-nope', at('2026-08-31T09:00:00Z'))).toEqual(held());
  });
});

describe('isGuideAddress', () => {
  it('takes an http or https address with a host', () => {
    expect(isGuideAddress('http://epg.example/guide.xml.gz')).toBe(true);
    expect(isGuideAddress('  https://epgshare01.online/epgshare01/epg_ripper_HR1.xml.gz ')).toBe(true);
  });

  it('refuses what is not one', () => {
    // "not a url" fetched the app's own page on the desktop (11 October).
    for (const text of ['not a url', '', 'epg.example/guide.xml', 'ftp://epg.example/guide.xml', 'file:///guide.xml', 'http://']) {
      expect(isGuideAddress(text)).toBe(false);
    }
  });
});
