import http from 'http';
import { StalkerPortal, StalkerSend } from './client';
import { StalkerSource, episodeCommand, episodeId } from './stalkerSource';
import { slimStreams } from '../xtream/catalogue';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fake = require('../../tools/qa/fake-stalker.js') as { start(): Promise<{ port: number; mac: string; close(): void }> };

const send: StalkerSend = request =>
  new Promise((resolve, reject) => {
    const url = new URL(request.url);
    Object.entries(request.query).forEach(([key, value]) => url.searchParams.set(key, value));
    http
      .get(url, { headers: request.headers }, response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text: body }));
      })
      .on('error', reject);
  });

describe('a portal as a catalogue', () => {
  let portal: { port: number; mac: string; close(): void };
  let source: StalkerSource;
  let client: StalkerPortal;

  beforeAll(async () => {
    portal = await fake.start();
    client = new StalkerPortal(send, `http://127.0.0.1:${portal.port}/c`, portal.mac, { pause: () => Promise.resolve() });
    source = new StalkerSource(client);
  });
  afterAll(() => portal.close());

  it('lists genres and categories as categories', async () => {
    expect((await source.getCategories('live')).map(one => one.category_name)).toEqual(expect.arrayContaining(['News', 'Sport']));
    expect((await source.getCategories('vod')).map(one => one.category_id)).toEqual(['11', '12']);
  });

  it("files channels under their genre, with catch-up in days and the portal's command kept", async () => {
    const sport = await source.getStreams('live', '2');

    expect(sport.every(one => one.category_id === '2')).toBe(true);
    const archived = (await source.getStreams('live')).find(one => one.stream_id === '108')!;
    expect(archived).toEqual(expect.objectContaining({ tv_archive: 1, tv_archive_duration: 3, portal_cmd: 'ffrt http://localhost/ch/108' }));
  });

  it("keeps the command through the catalogue's slimming, so a stored row can still be played", async () => {
    const [film] = await source.getStreams('vod', '11');

    expect(slimStreams([film as unknown as Record<string, unknown>], 'vod')[0].portal_cmd).toBe(film.portal_cmd);
  });

  it('reads the whole film library, a category at a time, for search', async () => {
    expect(await source.getStreams('vod')).toHaveLength(31);
  });

  it("gives a show's seasons in the shape a show's page reads, and finds an episode's command again", async () => {
    const [show] = (await source.getStreams('series', '21')).filter(one => one.stream_id === '3000');
    const info = await source.seriesInfo(show);

    expect(Object.keys(info.episodes!)).toEqual(['1', '2']);
    const episode = info.episodes!['2'][3];
    expect(episode).toEqual(expect.objectContaining({ episode_num: 4, season: 2 }));

    const seasons = await client.seasons('3000');
    expect(episode.id).toBe(episodeId('3000', seasons[1], 4));
    expect(episodeCommand(episode.id, seasons)).toEqual({ cmd: seasons[1].cmd, episode: 4 });
    expect(await client.link('series', seasons[1].cmd, 4)).toMatch(/\/play\/episode\/3000-2-4\.ts\?once=/);
  });
});

describe('playing from a portal', () => {
  let portal: { port: number; mac: string; close(): void };
  let source: StalkerSource;

  beforeAll(async () => {
    portal = await fake.start();
    source = new StalkerSource(new StalkerPortal(send, `http://127.0.0.1:${portal.port}/c`, portal.mac, { pause: () => Promise.resolve() }));
  });
  afterAll(() => portal.close());

  it('plays a channel kept on the device without listing the portal again', async () => {
    const kept = [{ stream_id: '105', name: 'Channel 6', icon: '', portal_cmd: 'ffrt http://localhost/ch/105' }];

    expect(await source.playbackUrl('live', '105', () => Promise.resolve(kept))).toMatch(/\/play\/live\/105\.ts\?once=/);
  });

  it('finds a film the device does not hold by asking the portal once', async () => {
    expect(await source.playbackUrl('vod', '2003', () => Promise.resolve([]))).toMatch(/\/play\/film\/2003\.ts\?once=/);
  });

  it("plays an episode from its id and the show's seasons", async () => {
    const info = await source.seriesInfo({ stream_id: '3001', name: 'Twelve Seasons', icon: '' });
    const episode = info.episodes!['12'][1];

    expect(await source.playbackUrl('series', episode.id, () => Promise.resolve([]))).toMatch(/\/play\/episode\/3001-12-2\.ts\?once=/);
  });
});
