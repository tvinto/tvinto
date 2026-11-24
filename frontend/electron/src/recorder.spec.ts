import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { createServer, get } from 'http';
import type { Server, ServerResponse } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { DesktopRecorder, PLAYLIST_FAILURE } from './recorder';

/** A provider that streams a packet every few milliseconds, and counts its streams. */
function liveProvider(): Promise<{ server: Server; url: string; open: () => number; refuse: (status: number | null) => void; drop: () => void }> {
  let streams = 0;
  let refusing: number | null = null;
  const answers: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/moved') {
      response.writeHead(302, { Location: '/live' }).end();
      return;
    }
    if (request.url === '/hls') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U');
      return;
    }
    if (refusing) {
      response.writeHead(refusing).end();
      return;
    }
    streams++;
    answers.push(response);
    response.writeHead(200, { 'Content-Type': 'video/mp2t' });
    const timer = setInterval(() => response.write(Buffer.alloc(188, 0x47)), 5);
    response.on('close', () => {
      clearInterval(timer);
      streams--;
    });
  });
  return new Promise(done =>
    server.listen(0, '127.0.0.1', () =>
      done({
        server,
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        open: () => streams,
        refuse: status => (refusing = status),
        drop: () => answers.splice(0).forEach(one => one.destroy())
      })
    )
  );
}

const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('Waited too long');
    }
    await new Promise(wake => setTimeout(wake, 20));
  }
};

describe('the desktop recorder', () => {
  let dir: string;
  let provider: Awaited<ReturnType<typeof liveProvider>>;
  let recorder: DesktopRecorder;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tvinto-rec-'));
    provider = await liveProvider();
    recorder = new DesktopRecorder(join(dir, 'Recordings'), join(dir, 'bookings.json'));
  });

  afterEach(async () => {
    await Promise.all(recorder.runningIds().map(id => recorder.stop(id)));
    recorder.close();
    await new Promise(done => provider.server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a stream to a file, following a redirect, and ends when told', async () => {
    recorder.start({ id: 'r1', url: `${provider.url}/moved`, title: 'News', channel: 'HRT 1', channelId: '7', endsAt: Date.now() + 60_000 });
    await until(() => (recorder.list()[0] as { bytes: number })?.bytes > 188 * 20);
    expect(provider.open()).toBe(1);
    expect(recorder.list()[0]).toMatchObject({ id: 'r1', state: 'recording', channelId: '7', title: 'News' });

    await recorder.stop('r1');
    await until(() => provider.open() === 0);
    const [done] = recorder.list() as Array<{ state: string; path: string; bytes: number }>;
    expect(done.state).toBe('done');
    expect(done.path).toBe(pathToFileURL(join(dir, 'Recordings', 'r1.ts')).toString());
    expect(statSync(join(dir, 'Recordings', 'r1.ts')).size).toBe(done.bytes);
  });

  it('refuses an id that could leave the recordings folder', async () => {
    for (const id of ['../escape', '..\\escape', '/abs', 'a/b', '..']) {
      expect(recorder.start({ id, url: `${provider.url}/live`, title: '', channel: '', channelId: '', endsAt: Date.now() + 60_000 })).toEqual({ id });
    }
    expect(recorder.runningIds()).toEqual([]);
    expect(provider.open()).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['Recordings']);
  });

  it('never writes the address beside the recording', async () => {
    recorder.start({ id: 'r2', url: `${provider.url}/live?password=secret`, title: '', channel: 'HRT 1', channelId: '7', endsAt: Date.now() + 60_000 });
    await until(() => (recorder.list()[0] as { bytes: number })?.bytes > 0);
    await recorder.stop('r2');
    expect(readFileSync(join(dir, 'Recordings', 'r2.json'), 'utf8')).not.toContain('secret');
  });

  it('opens the stream again after it drops, and says a refusal by its status', async () => {
    recorder.start({ id: 'r3', url: `${provider.url}/live`, title: '', channel: 'HRT 1', channelId: '7', endsAt: Date.now() + 60_000 });
    await until(() => provider.open() === 1);
    provider.drop();
    await until(() => provider.open() === 1, 6000);
    await recorder.stop('r3');

    provider.refuse(403);
    recorder.start({ id: 'r4', url: `${provider.url}/live`, title: '', channel: 'HRT 1', channelId: '7', endsAt: Date.now() + 300 });
    await until(() => !recorder.isRecording('r4'));
    expect(recorder.list().find(one => (one as { id: string }).id === 'r4')).toMatchObject({ state: 'failed', failure: 'HTTP 403' });
  });

  it('refuses an HLS playlist at once rather than saving it', async () => {
    recorder.start({ id: 'r7', url: `${provider.url}/hls`, title: '', channel: 'HRT 1', channelId: '7', endsAt: Date.now() + 60_000 });
    await until(() => !recorder.isRecording('r7'));
    expect(recorder.list()[0]).toMatchObject({ state: 'failed', failure: PLAYLIST_FAILURE });
  });

  it('serves a recording being made on 127.0.0.1, and nothing else', async () => {
    recorder.start({ id: 'r5', url: `${provider.url}/live`, title: '', channel: 'HRT 1', channelId: '7', endsAt: Date.now() + 60_000 });
    await until(() => (recorder.list()[0] as { bytes: number })?.bytes > 0);
    const { url } = await recorder.watchAddress('r5');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rec\/r5\.ts$/);

    let received = 0;
    await new Promise<void>(done => {
      get(url, response => {
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > 188 * 40) {
            response.destroy();
            done();
          }
        });
      });
    });
    // Still only the recording's own connection to the provider.
    expect(provider.open()).toBe(1);

    const missing = await new Promise<number>(done => get(url.replace('r5', 'nope'), response => done(response.statusCode ?? 0)));
    expect(missing).toBe(404);
  });

  it('lets the player open its own recordings and no other local file', async () => {
    recorder.start({ id: 'r6', url: `${provider.url}/live`, title: '', channel: 'HRT 1', channelId: '7', endsAt: Date.now() + 60_000 });
    await until(() => recorder.list().length > 0);
    await recorder.stop('r6');
    const path = (recorder.list()[0] as { path: string }).path;
    expect(recorder.recordingFile(path)).toBe(join(dir, 'Recordings', 'r6.ts'));
    expect(recorder.recordingFile(pathToFileURL(join(dir, 'bookings.json')).toString())).toBeNull();
    expect(recorder.recordingFile(pathToFileURL(join(dir, 'Recordings', '..', 'x.ts')).toString())).toBeNull();
    expect(recorder.recordingFile('http://example.test/r6.ts')).toBeNull();

    expect(recorder.remove('r6')).toBe(true);
    expect(recorder.list()).toEqual([]);
  });

  it('keeps bookings without showing their addresses, and starts one when due', async () => {
    const now = Date.now();
    expect(() =>
      recorder.book({ id: 'b1', url: `${provider.url}/live`, title: 'Film', channel: 'HRT 1', channelId: '7', startMs: now + 60_100, endsAt: now + 60_000 })
    ).toThrow();
    expect(recorder.bookings()).toEqual([]);

    recorder.book({ id: 'b1', url: `${provider.url}/live?password=secret`, title: 'Film', channel: 'HRT 1', channelId: '7', startMs: now + 60_100, endsAt: now + 120_000 });
    expect(JSON.stringify(recorder.bookings())).not.toContain('secret');
    expect(recorder.bookings()).toEqual([{ id: 'b1', title: 'Film', channel: 'HRT 1', channelId: '7', startMs: now + 60_100, endsAt: now + 120_000 }]);

    await until(() => recorder.isRecording('b1'));
    expect(recorder.bookings()).toEqual([]);
    await until(() => provider.open() === 1);

    recorder.book({ id: 'b2', url: `${provider.url}/live`, title: 'Later', channel: 'HRT 1', channelId: '7', startMs: now + 3_600_000, endsAt: now + 7_200_000 });
    recorder.cancelBooking('b2');
    expect(recorder.bookings()).toEqual([]);
  });
});
