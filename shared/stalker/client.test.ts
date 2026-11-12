import http from 'http';
import { StalkerError, StalkerPortal, StalkerSend, endpointCandidates, normaliseMac, streamAddress } from './client';

// tools/qa/fake-stalker.js, in-process: a portal that is nobody's subscription.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fake = require('../../tools/qa/fake-stalker.js') as { start(): Promise<{ port: number; mac: string; close(): void }> };

/** A platform's HTTP, as Node does it: headers as given, the body as text. */
const send: StalkerSend = request =>
  new Promise((resolve, reject) => {
    const url = new URL(request.url);
    Object.entries(request.query).forEach(([key, value]) => url.searchParams.set(key, value));
    http
      .get(url, { headers: request.headers, timeout: request.timeoutMs }, response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text: body }));
      })
      .on('error', reject);
  });

const noPause = { pause: () => Promise.resolve() };

describe('a Stalker portal', () => {
  let portal: { port: number; mac: string; close(): void };
  let address: string;

  beforeAll(async () => {
    portal = await fake.start();
    address = `http://127.0.0.1:${portal.port}/c`;
  });
  afterAll(() => portal.close());

  it('finds the API behind the landing page people copy, and signs in', async () => {
    const client = new StalkerPortal(send, address, portal.mac.toLowerCase().replace(/:/g, '-'), noPause);

    await expect(client.connect()).resolves.toEqual({ name: 'Test account', expires: '2027-12-31 00:00:00' });
  });

  it('remembers where the API was, and goes straight there next time', async () => {
    let found = '';
    await new StalkerPortal(send, address, portal.mac, { ...noPause, foundEndpoint: endpoint => (found = endpoint) }).connect();
    expect(found).toMatch(/\/stalker_portal\/server\/load\.php$/);

    const tried: string[] = [];
    const counting: StalkerSend = request => (tried.push(request.url), send(request));
    await new StalkerPortal(counting, address, portal.mac, { ...noPause, knownEndpoint: found }).connect();
    expect(tried[0]).toBe(found);
    expect(new Set(tried)).toEqual(new Set([found]));
  });

  it('says plainly when the portal does not know the MAC address', async () => {
    const client = new StalkerPortal(send, address, '00:1A:79:FF:FF:FF', noPause);

    await expect(client.connect()).rejects.toMatchObject({ failure: 'refused' });
  });

  it('tells nothing answering apart from something that is not a portal', async () => {
    await expect(new StalkerPortal(send, 'http://127.0.0.1:9/c', portal.mac, noPause).connect()).rejects.toMatchObject({ failure: 'unreachable' });
  });

  it('reads the live genres without "All", and every channel but the adult genre', async () => {
    const client = new StalkerPortal(send, address, portal.mac, noPause);
    await client.connect();

    const genres = await client.liveGenres();
    const channels = await client.channels();

    expect(genres.map(one => one.id)).toEqual(['1', '2', '3', '4']);
    expect(genres.find(one => one.id === '4')?.censored).toBe(true);
    expect(channels).toHaveLength(60);
    expect(channels[7]).toEqual(expect.objectContaining({ name: 'HR| HRT 1 FHD', number: '8', genreId: '2', archiveHours: 0 }));
    expect(channels[8].archiveHours).toBe(72);
  });

  it('reads a category page by page, pausing between pages', async () => {
    const pauses: number[] = [];
    const client = new StalkerPortal(send, address, portal.mac, { pause: ms => (pauses.push(ms), Promise.resolve()) });
    await client.connect();

    const films = await client.items('vod', '11');

    expect(films).toHaveLength(28);
    expect(pauses).toHaveLength(1);
    expect(films[0]).toEqual(expect.objectContaining({ name: 'The Matrix (1999)', year: '2000', isSeries: false }));
  });

  it("reads a show's seasons, each with its episodes", async () => {
    const client = new StalkerPortal(send, address, portal.mac, noPause);
    await client.connect();

    const seasons = await client.seasons('3001');

    expect(seasons).toHaveLength(12);
    expect(seasons[0].episodes).toEqual([1, 2, 3, 4]);
  });

  it('makes a stream address when asked, without the player name in front', async () => {
    const client = new StalkerPortal(send, address, portal.mac, noPause);
    await client.connect();
    const [channel] = await client.channels();

    expect(await client.link('itv', channel.cmd)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/play\/live\/100\.ts\?once=/);
  });

  it('shakes hands again when the portal lets a token go', async () => {
    const client = new StalkerPortal(send, address, portal.mac, noPause);
    await client.connect();

    // The fake lets a token go after 40 requests; this takes more.
    for (let i = 0; i < 45; i++) {
      await client.liveGenres();
    }
    expect(await client.liveGenres()).toHaveLength(4);
  });

  it('keeps the MAC address out of what it says', async () => {
    const error = (await new StalkerPortal(send, address, '00:1A:79:FF:FF:FE', noPause).connect().catch(e => e)) as StalkerError;

    expect(String(error.message)).not.toMatch(/FF:FF:FE|ff-ff-fe/i);
  });
});

describe('Stalker details', () => {
  it('takes a MAC address however it is written', () => {
    expect(normaliseMac('00-1a-79-ab-cd-ef')).toBe('00:1A:79:AB:CD:EF');
    expect(normaliseMac('001A79ABCDEF')).toBe('00:1A:79:AB:CD:EF');
    expect(normaliseMac('00:1A:79:AB:CD')).toBeNull();
  });

  it('looks for the API where portals keep it', () => {
    expect(endpointCandidates('portal.example.com/c/')).toEqual([
      'http://portal.example.com/portal.php',
      'http://portal.example.com/server/load.php',
      'http://portal.example.com/stalker_portal/server/load.php'
    ]);
    expect(endpointCandidates('http://p.example:8080/stalker_portal/server/load.php')[0]).toBe('http://p.example:8080/stalker_portal/server/load.php');
  });

  it('takes the player name off a stream address', () => {
    expect(streamAddress('ffmpeg http://s.example/live/1.ts')).toBe('http://s.example/live/1.ts');
    expect(streamAddress('ffrt2 http://s.example/1')).toBe('http://s.example/1');
  });
});
