import {
  GuideChannel,
  GuideLoadSummary,
  GuideHit,
  GuideProgramme,
  GuideStore,
  GuideTotals,
  EmptyGuide,
  KnownChannel,
  loadGuide
} from './guide';

/** A store that records what it was told, in the order it was told. */
class RecordingStore implements GuideStore {
  readonly calls: string[] = [];
  channelRows: GuideChannel[] = [];
  programmeRows: GuideProgramme[] = [];
  loadedAt: string | null = null;

  async beginLoad(): Promise<void> {
    this.calls.push('begin');
    this.channelRows = [];
    this.programmeRows = [];
  }

  async writeChannels(_sourceId: string, channels: GuideChannel[]): Promise<void> {
    this.calls.push(`channels:${channels.length}`);
    this.channelRows.push(...channels);
  }

  async writeProgrammes(_sourceId: string, programmes: GuideProgramme[]): Promise<void> {
    this.calls.push(`programmes:${programmes.length}`);
    this.programmeRows.push(...programmes);
  }

  async finishLoad(_sourceId: string, at: string, totals?: GuideTotals): Promise<void> {
    this.calls.push('finish');
    this.loadedAt = at;
    this.summary = totals ? { ...totals, loadedAt: at } : null;
  }

  async lastLoadedAt(): Promise<string | null> {
    return this.loadedAt;
  }

  async loadSummary(): Promise<GuideLoadSummary | null> {
    return this.summary;
  }

  async runsOutAt(): Promise<number | null> {
    return this.programmeRows.length ? Math.max(...this.programmeRows.map(row => row.stop)) : null;
  }

  summary: GuideLoadSummary | null = null;

  async channels(): Promise<GuideChannel[]> {
    return this.channelRows;
  }

  async allChannels(): Promise<KnownChannel[]> {
    return this.channelRows.map(channel => ({ ...channel, sourceId: 'src' }));
  }

  async programmesFor(): Promise<GuideProgramme[]> {
    return this.programmeRows;
  }

  async searchProgrammes(): Promise<GuideHit[]> {
    return [];
  }

  async prune(): Promise<void> {
    this.calls.push('prune');
  }
}

const bytes = async function* (text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
};

const document = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><tv>${inner}</tv>`;

const guide = document(
  '<channel id="hrt1"><display-name>HRT 1</display-name></channel>' +
    '<programme channel="hrt1" start="20260827180000 +0200" stop="20260827190000 +0200">' +
    '<title>Dnevnik</title><desc>Vijesti</desc></programme>' +
    '<programme channel="hrt1" start="20260827190000 +0200" stop="20260827200000 +0200">' +
    '<title>Čudnovate zgode</title></programme>'
);

const at = (iso: string) => () => new Date(iso);

describe('loadGuide', () => {
  it('reads channels and programmes into the store', async () => {
    const store = new RecordingStore();
    const report = await loadGuide('src', bytes(guide), store, {
      now: at('2026-08-27T12:00:00Z')
    });

    expect(report).toEqual({
      channels: 1,
      programmes: 2,
      dropped: 0,
      loadedAt: '2026-08-27T12:00:00.000Z'
    });
    expect(store.channelRows).toEqual([{ id: 'hrt1', name: 'HRT 1' }]);
    expect(store.programmeRows[0]).toEqual({
      channel: 'hrt1',
      start: Date.parse('2026-08-27T16:00:00Z'),
      stop: Date.parse('2026-08-27T17:00:00Z'),
      title: 'Dnevnik',
      description: 'Vijesti',
      category: ''
    });
  });

  it('leaves out programmes starting at or after `until` (card 42)', async () => {
    const store = new RecordingStore();
    await loadGuide('src', bytes(guide), store, { until: Date.parse('2026-08-27T17:00:00Z') });

    expect(store.programmeRows.map(row => row.title)).toEqual(['Dnevnik']);
  });

  // The feed is the truth about its own channels, so a programme withdrawn
  // upstream should disappear rather than linger because nothing overwrote it.
  it('clears the source before writing, and marks it loaded after', async () => {
    const store = new RecordingStore();
    await loadGuide('src', bytes(guide), store);

    expect(store.calls[0]).toBe('begin');
    expect(store.calls[store.calls.length - 1]).toBe('finish');
  });

  it('converts times once, on the way in', async () => {
    const store = new RecordingStore();
    await loadGuide('src', bytes(guide), store);

    for (const programme of store.programmeRows) {
      expect(typeof programme.start).toBe('number');
      expect(programme.stop).toBeGreaterThan(programme.start);
    }
  });

  // Counted rather than swallowed: a feed dropping a handful is normal, one
  // dropping everything is broken in a way the person who added it can act on.
  it('drops programmes whose times will not read, and says how many', async () => {
    const store = new RecordingStore();
    const report = await loadGuide(
      'src',
      bytes(
        document(
          '<programme channel="a" start="20260827180000" stop="20260827190000"><title>Good</title></programme>' +
            '<programme channel="a" start="tomorrow" stop="later"><title>No times</title></programme>' +
            '<programme channel="a" stop="20260827190000"><title>No start</title></programme>'
        )
      ),
      store
    );

    expect(report.programmes).toBe(1);
    expect(report.dropped).toBe(2);
    expect(store.programmeRows.map(p => p.title)).toEqual(['Good']);
  });

  it('drops a programme that stops before it starts', async () => {
    const store = new RecordingStore();
    const report = await loadGuide(
      'src',
      bytes(
        document(
          '<channel id="a"><display-name>A</display-name></channel><programme channel="a" start="20260827190000" stop="20260827180000"><title>Backwards</title></programme>'
        )
      ),
      store
    );

    expect(report.programmes).toBe(0);
    expect(report.dropped).toBe(1);
  });

  it('drops a programme with no channel to attach it to', async () => {
    const store = new RecordingStore();
    const report = await loadGuide(
      'src',
      bytes(
        document(
          '<channel id="a"><display-name>A</display-name></channel><programme start="20260827180000" stop="20260827190000"><title>Orphan</title></programme>'
        )
      ),
      store
    );

    expect(report.programmes).toBe(0);
    expect(report.dropped).toBe(1);
  });

  it('drops a channel with no id', async () => {
    const store = new RecordingStore();
    const report = await loadGuide(
      'src',
      bytes(document('<channel id="a"><display-name>A</display-name></channel><channel><display-name>Nameless</display-name></channel>')),
      store
    );

    expect(report.channels).toBe(1);
    expect(report.dropped).toBe(1);
  });

  it('writes in batches rather than all at once', async () => {
    const many = document(
      Array.from(
        { length: 7 },
        (_unused, index) =>
          `<programme channel="a" start="2026082718${String(index).padStart(2, '0')}00" ` +
          `stop="2026082719${String(index).padStart(2, '0')}00"><title>P${index}</title></programme>`
      ).join('')
    );

    const store = new RecordingStore();
    await loadGuide('src', bytes(many), store, { batchSize: 3 });

    expect(store.calls.filter(call => call.startsWith('programmes:'))).toEqual([
      'programmes:3',
      'programmes:3',
      'programmes:1'
    ]);
  });

  it('reports progress as it goes', async () => {
    const seen: number[] = [];
    await loadGuide('src', bytes(guide), new RecordingStore(), {
      batchSize: 1,
      onProgress: progress => seen.push(progress.programmes)
    });

    expect(seen).toContain(1);
    expect(seen[seen.length - 1]).toBe(2);
  });

  it('refuses a guide with nothing in it, keeping what the source held', async () => {
    // A web page or an error where the guide should be, read as XML with
    // nothing in it: finishing would have replaced a working guide with it.
    const store = new RecordingStore();

    await expect(loadGuide('src', bytes(document('')), store)).rejects.toBeInstanceOf(EmptyGuide);

    expect(store.calls).toEqual(['begin']);
  });

  it('reads a gzipped guide, since that is how most of them arrive', async () => {
    const compressed = async function* (): AsyncIterable<Uint8Array> {
      const stream = new Blob([new TextEncoder().encode(guide)])
        .stream()
        .pipeThrough(new CompressionStream('gzip'));
      yield new Uint8Array(await new Response(stream).arrayBuffer());
    };

    const store = new RecordingStore();
    const report = await loadGuide('src', compressed(), store);

    expect(report.programmes).toBe(2);
    expect(store.programmeRows[1].title).toBe('Čudnovate zgode');
  });
});

