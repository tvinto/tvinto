import { M3uSource } from './m3uSource';
import { m3uItemsOf } from './m3uReader';
import { m3uCatchUpUrl } from './m3uCatchUp';
import { Catalogue, CatalogueStore } from '../xtream/catalogue';
import { Category, Stream, StreamType } from '../types';

const PLAYLIST = [
  '#EXTM3U url-tvg="http://guide.example/epg.xml"',
  '#EXTINF:-1 tvg-id="A.hr" group-title="News",Channel A',
  'http://line.example/live/u/p/1.ts',
  '#EXTINF:-1 group-title="Sport",Channel B',
  'http://line.example/live/u/p/2.ts',
  '#EXTINF:-1 group-title="Films",Film C',
  'http://line.example/movie/u/p/3.mp4'
].join('\n');

const source = () => {
  let reads = 0;
  const made = new M3uSource(async function* () {
    reads++;
    yield* m3uItemsOf(PLAYLIST);
  });
  return { made, reads: () => reads };
};

/** A store that keeps everything in maps, as the desktop's does. */
const memoryStore = (): CatalogueStore => {
  const categories = new Map<StreamType, Category[]>();
  const streams = new Map<string, Stream[]>();
  const marks = new Map<string, string>();
  return {
    readCategories: async type => categories.get(type) ?? [],
    writeCategories: async (type, list) => void categories.set(type, list),
    readStreams: async (type, id) => streams.get(`${type}:${id}`) ?? [],
    writeStreams: async (type, id, list) => void streams.set(`${type}:${id}`, list),
    lastFetchedAt: async (type, id) => marks.get(`${type}:${id}`) ?? null,
    markFetched: async (type, id, at) => void marks.set(`${type}:${id}`, at),
    findStreams: async () => [],
    recentlyAdded: async () => []
  };
};

describe('M3uSource', () => {
  it('reads the playlist once, however many questions follow', async () => {
    const { made, reads } = source();
    expect((await made.getCategories('live')).map(c => c.category_name)).toEqual(['News', 'Sport']);
    expect((await made.getCategories('vod')).map(c => c.category_name)).toEqual(['Films']);
    expect(await made.getStreams('live')).toHaveLength(2);
    expect(await made.guideUrls()).toEqual(['http://guide.example/epg.xml']);
    expect(reads()).toBe(1);
  });

  it('serves a catalogue, which keeps each category with its address', async () => {
    const { made } = source();
    const catalogue = new Catalogue(made, memoryStore());
    const [news] = await catalogue.categories('live');
    const [channel] = await catalogue.streams('live', news.category_id);
    expect(channel).toEqual(
      expect.objectContaining({ name: 'Channel A', source_url: 'http://line.example/live/u/p/1.ts' })
    );
  });

  it('takes a failure as the answer for a while, then reads again', async () => {
    let fail = true;
    let reads = 0;
    let now = 0;
    const made = new M3uSource(
      async function* () {
        reads++;
        if (fail) {
          throw new Error('offline');
        }
        yield* m3uItemsOf(PLAYLIST);
      },
      60_000,
      () => now
    );
    await expect(made.getCategories('live')).rejects.toThrow('offline');
    fail = false;
    now = 59_000;
    await expect(made.getCategories('vod')).rejects.toThrow('offline');
    expect(reads).toBe(1);
    now = 61_000;
    expect(await made.getCategories('live')).toHaveLength(2);
    expect(reads).toBe(2);
  });
});

describe('m3uCatchUpUrl', () => {
  // 29 September 2026, 18:30:00 UTC, for 45 minutes, asked at 20:00.
  const start = Date.UTC(2026, 8, 29, 18, 30);
  const now = Date.UTC(2026, 8, 29, 20, 0);
  const at = (fields: Record<string, string>) =>
    m3uCatchUpUrl({ source_url: 'http://line.example/live/u/p/7.ts', ...fields }, start, 45, now);

  it('fills a whole-address template', () => {
    expect(
      at({ catchup_mode: 'default', catchup_source: 'http://arc.example/7/{Y}-{m}-{d}/{H}{M}.ts?from=${start}&len={duration:60}' })
    ).toBe(`http://arc.example/7/2026-09-29/1830.ts?from=${start / 1000}&len=45`);
  });

  it('appends, and shifts', () => {
    expect(at({ catchup_mode: 'append', catchup_source: '?utc={utc}&end={utcend}' })).toBe(
      `http://line.example/live/u/p/7.ts?utc=${start / 1000}&end=${start / 1000 + 2700}`
    );
    expect(at({ catchup_mode: 'shift' })).toBe(
      `http://line.example/live/u/p/7.ts?utc=${start / 1000}&lutc=${now / 1000}`
    );
  });

  it('rewrites a Flussonic address, TS and HLS', () => {
    expect(
      m3uCatchUpUrl({ source_url: 'http://fs.example/ch1/mpegts', catchup_mode: 'flussonic' }, start, 45, now)
    ).toBe(`http://fs.example/ch1/timeshift_abs-${start / 1000}.ts`);
    expect(
      m3uCatchUpUrl({ source_url: 'http://fs.example/ch1/index.m3u8?token=x', catchup_mode: 'fs' }, start, 45, now)
    ).toBe(`http://fs.example/ch1/index-${start / 1000}-2700.m3u8?token=x`);
  });

  it("rewrites an Xtream line to its timeshift form", () => {
    expect(at({ catchup_mode: 'xc' })).toBe('http://line.example/timeshift/u/p/45/2026-09-29:18-30/7.ts');
  });

  it('says nothing for a mode it does not know, or a template that is missing', () => {
    expect(at({ catchup_mode: 'vod' })).toBeNull();
    expect(at({ catchup_mode: 'default' })).toBeNull();
    expect(at({})).toBeNull();
  });
});
