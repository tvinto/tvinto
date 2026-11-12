import { createReadStream, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, createWriteStream } from 'fs';
import type { WriteStream } from 'fs';
import { get as getHttp } from 'http';
import type { ClientRequest, IncomingMessage, Server, ServerResponse } from 'http';
import { createServer } from 'http';
import { get as getHttps } from 'https';
import { join, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

/**
 * Recording live channels on the desktop (private plan: recording): what
 * RecordingService, RecordingTail and Bookings do on Android, in the main
 * process, where nothing holds it back while the window is minimised.
 *
 * The stream is saved as it arrives (MPEG-TS, written as is) with a small
 * JSON file beside it saying what it is and how far it got. A dropped
 * connection is opened again, with a growing pause, until the programme's
 * end. Bookings wait on timers, so they run only while the app is open; one
 * missed that way is said so on the Recordings page, by its absence.
 *
 * A stream address carries the provider's login: it is never logged, never
 * written beside a recording, and never handed back to the page. Bookings keep
 * it in their own file in the app's data, as the app keeps the login itself.
 *
 * Nothing here needs Electron, so it is tested in plain Node
 * (recorder.spec.ts); recorderIpc.ts hands it to the page.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 20_000;
const LONGEST_PAUSE_MS = 15_000;
const MAX_REDIRECTS = 5;
/** How far behind the newest part watching starts: a few seconds of picture, so it begins at once. */
const BEHIND_BYTES = 2 * 1024 * 1024;
const PACKET = 188;
/** A booking starts recording this long before the programme does. */
export const BEFORE_MS = 60_000;

export interface StartRequest {
  id: string;
  url: string;
  title: string;
  channel: string;
  channelId: string;
  endsAt: number;
}

export interface BookRequest extends Omit<StartRequest, 'endsAt'> {
  startMs: number;
  endsAt: number;
}

/** Opens a stream; answers its response, or a status with no body. Replaced in tests. */
export type StreamOpener = (url: string) => { request: ClientRequest; response: Promise<IncomingMessage> };

export const openStream: StreamOpener = url => {
  let request!: ClientRequest;
  const response = new Promise<IncomingMessage>((done, fail) => {
    const follow = (address: string, left: number) => {
      const get = address.startsWith('https:') ? getHttps : getHttp;
      request = get(address, { headers: { 'User-Agent': 'Tvinto' }, timeout: CONNECT_TIMEOUT_MS }, answer => {
        const status = answer.statusCode ?? 0;
        const next = answer.headers.location;
        if (status >= 300 && status < 400 && next && left > 0) {
          answer.resume();
          follow(new URL(next, address).toString(), left - 1);
          return;
        }
        request.setTimeout(READ_TIMEOUT_MS);
        done(answer);
      });
      // Said by what went wrong, never with the address.
      request.on('timeout', () => request.destroy(new Error('timed out')));
      request.on('error', fail);
    };
    follow(url, MAX_REDIRECTS);
  });
  return {
    get request() {
      return request;
    },
    response
  };
};

interface Running {
  id: string;
  stop(): void;
  done: Promise<void>;
}

export class DesktopRecorder {
  private readonly running = new Map<string, Running>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private tail: Server | null = null;
  private tailPort = 0;

  constructor(
    /** Where recordings are kept: a `.ts` and a `.json` each. */
    private readonly dir: string,
    /** Where bookings are kept, addresses and all. */
    private readonly bookingsFile: string,
    /** Told whenever a recording starts, moves on or ends, or a booking changes. */
    private readonly changed: (id: string) => void = () => undefined,
    private readonly open: StreamOpener = openStream,
    private readonly now: () => number = Date.now
  ) {
    mkdirSync(dir, { recursive: true });
  }

  isRecording(id: string): boolean {
    return this.running.has(id);
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  start(request: StartRequest): { id: string } {
    if (!ID.test(request?.id ?? '') || typeof request.url !== 'string' || this.running.has(request.id)) {
      return { id: request?.id };
    }
    let stopped = false;
    let current: ClientRequest | null = null;
    const id = request.id;
    const video = join(this.dir, `${id}.ts`);
    const startedAt = this.now();
    let bytes = 0;
    let reconnects = 0;
    const describe = (state: 'recording' | 'done' | 'failed', failure?: string) => {
      const about = {
        id,
        title: String(request.title ?? ''),
        channel: String(request.channel ?? ''),
        channelId: String(request.channelId ?? ''),
        startedAt,
        endsAt: Number(request.endsAt) || 0,
        state,
        bytes,
        reconnects,
        ...(failure ? { failure } : {})
      };
      try {
        writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(about));
      } catch {
        // The recording goes on; only its description is late.
      }
      this.changed(id);
    };

    const record = async (): Promise<void> => {
      let out: WriteStream;
      try {
        closeSync(openSync(video, 'a'));
        out = createWriteStream(video, { flags: 'a' });
      } catch {
        describe('failed', 'could not write the recording');
        return;
      }
      let failure: string | undefined;
      let pause = 2_000;
      describe('recording');
      let lastNote = this.now();
      while (!stopped && this.now() < request.endsAt) {
        try {
          const opened = this.open(request.url);
          current = opened.request;
          const answer = await opened.response;
          if (answer.statusCode !== 200) {
            answer.resume();
            failure = `HTTP ${answer.statusCode}`;
            throw new Error(failure);
          }
          if (isPlaylist(answer.headers['content-type'])) {
            // HLS: a playlist naming pieces, not the picture. Asking again will not change it.
            answer.resume();
            failure = PLAYLIST_FAILURE;
            stopped = true;
            throw new Error(failure);
          }
          failure = undefined;
          pause = 2_000;
          await new Promise<void>(finish => {
            const until = setTimeout(() => answer.destroy(), Math.max(0, request.endsAt - this.now()));
            answer.on('data', (chunk: Buffer) => {
              if (stopped) {
                answer.destroy();
                return;
              }
              out.write(chunk);
              bytes += chunk.length;
              if (this.now() - lastNote > 10_000) {
                lastNote = this.now();
                describe('recording');
              }
            });
            const end = () => {
              clearTimeout(until);
              finish();
            };
            answer.on('end', end);
            answer.on('close', end);
            answer.on('error', end);
          });
        } catch {
          failure = failure ?? 'connection dropped';
        } finally {
          current?.destroy();
          current = null;
        }
        if (!stopped && this.now() < request.endsAt) {
          reconnects++;
          await new Promise<void>(wake => {
            const timer = setTimeout(wake, Math.max(0, Math.min(pause, request.endsAt - this.now())));
            wakeEarly = () => {
              clearTimeout(timer);
              wake();
            };
          });
          pause = Math.min(LONGEST_PAUSE_MS, pause * 2);
        }
      }
      await new Promise<void>(closed => out.end(closed));
      this.running.delete(id);
      describe(bytes > 0 ? 'done' : 'failed', bytes > 0 ? undefined : failure ?? 'nothing arrived');
    };

    let wakeEarly = () => undefined as void;
    const one: Running = {
      id,
      stop: () => {
        stopped = true;
        current?.destroy();
        wakeEarly();
      },
      done: Promise.resolve()
    };
    this.running.set(id, one);
    one.done = record();
    return { id };
  }

  /** Stops a recording; answers once it has let go of the connection and said so. */
  async stop(id: string): Promise<void> {
    const one = this.running.get(id);
    if (one) {
      one.stop();
      await one.done;
    }
  }

  /** Every recording, with its file's address for the player and its size now. */
  list(): object[] {
    const found: object[] = [];
    for (const name of safeList(this.dir).filter(file => file.endsWith('.json'))) {
      try {
        const one = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Record<string, unknown>;
        const id = String(one['id'] ?? '');
        if (!ID.test(id)) {
          continue;
        }
        const video = join(this.dir, `${id}.ts`);
        const size = existsSync(video) ? statSync(video).size : 0;
        one['path'] = pathToFileURL(video).toString();
        one['bytes'] = size;
        if (one['state'] === 'recording' && !this.running.has(id)) {
          // Left as recording by an app that was closed: it ends where the file ends.
          one['state'] = size > 0 ? 'done' : 'failed';
        }
        found.push(one);
      } catch {
        // A description half written: the next look will find it whole.
      }
    }
    return found;
  }

  /** Deletes a finished recording and its description. False while it is still recording. */
  remove(id: string): boolean {
    if (this.running.has(id) || !ID.test(id)) {
      return false;
    }
    for (const file of [`${id}.ts`, `${id}.json`]) {
      try {
        unlinkSync(join(this.dir, file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return false;
        }
      }
    }
    this.changed(id);
    return true;
  }

  /**
   * The file a `file://` address names, when it is one of these recordings;
   * null for anything else. The player opens no other local file.
   */
  recordingFile(url: unknown): string | null {
    if (typeof url !== 'string' || !url.startsWith('file:')) {
      return null;
    }
    try {
      const path = resolve(fileURLToPath(url));
      const inside = path.startsWith(resolve(this.dir) + sep) && /[\\/][A-Za-z0-9_-]{1,64}\.ts$/.test(path);
      return inside && existsSync(path) ? path : null;
    } catch {
      return null;
    }
  }

  /**
   * Where to watch a recording being made, without a second connection: its
   * file, served on 127.0.0.1 only, from near its newest part and on as it
   * grows. MPEG-TS without an end until the recording has finished.
   */
  async watchAddress(id: string): Promise<{ url: string }> {
    if (!ID.test(id)) {
      throw new Error('No such recording');
    }
    if (!this.tail) {
      const server = createServer((request, response) => this.serveTail(request, response));
      await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', () => done());
      });
      this.tail = server;
      this.tailPort = (server.address() as { port: number }).port;
    }
    return { url: `http://127.0.0.1:${this.tailPort}/rec/${id}.ts` };
  }

  private serveTail(request: { url?: string; method?: string }, response: ServerResponse): void {
    const id = /^\/rec\/([A-Za-z0-9_-]{1,64})\.ts(?:\?|$)/.exec(request.url ?? '')?.[1];
    const video = id ? join(this.dir, `${id}.ts`) : null;
    if (request.method !== 'GET' || !id || !video || !existsSync(video)) {
      response.writeHead(404, { 'Content-Length': 0, Connection: 'close' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', Connection: 'close' });
    let at = Math.max(0, statSync(video).size - BEHIND_BYTES);
    at -= at % PACKET;
    let gone = false;
    response.on('close', () => (gone = true));
    const more = () => {
      if (gone) {
        return;
      }
      const size = existsSync(video) ? statSync(video).size : 0;
      if (size <= at) {
        if (!this.running.has(id)) {
          // Finished, and all of it sent.
          response.end();
          return;
        }
        // Caught up with the recording: wait for it to write more.
        setTimeout(more, 200);
        return;
      }
      const piece = createReadStream(video, { start: at, end: size - 1 });
      at = size;
      piece.on('data', chunk => response.write(chunk));
      piece.on('end', more);
      piece.on('error', () => response.end());
    };
    more();
  }

  // --- bookings ---------------------------------------------------------------

  /** Books a recording: a timer starts it a minute before `startMs`, while the app is open. */
  book(request: BookRequest): void {
    if (!ID.test(request?.id ?? '') || typeof request.url !== 'string' || !(request.endsAt > request.startMs)) {
      throw new Error('That booking is not well formed');
    }
    const all = this.allBookings().filter(one => one.id !== request.id);
    all.push({
      id: request.id,
      url: request.url,
      title: String(request.title ?? ''),
      channel: String(request.channel ?? ''),
      channelId: String(request.channelId ?? ''),
      startMs: Number(request.startMs),
      endsAt: Number(request.endsAt)
    });
    this.saveBookings(all);
    this.reschedule();
    this.changed(request.id);
  }

  cancelBooking(id: string): void {
    this.saveBookings(this.allBookings().filter(one => one.id !== id));
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.changed(id);
  }

  /** The bookings as the page sees them: without their addresses. */
  bookings(): object[] {
    return this.allBookings().map(({ url: _address, ...shown }) => shown);
  }

  /**
   * A timer for every booking still to come, and those past forgotten. Run
   * when the app starts: a booking whose start passed while it was closed
   * begins at once if its programme has not ended.
   */
  reschedule(): void {
    const now = this.now();
    const kept = this.allBookings().filter(one => one.endsAt > now);
    this.saveBookings(kept);
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const one of kept) {
      // setTimeout holds at most about 24.8 days; a booking further off waits
      // for a later look, which every app start and every booking makes.
      const wait = Math.max(0, one.startMs - BEFORE_MS - now);
      if (wait < 2 ** 31 - 1) {
        this.timers.set(one.id, setTimeout(() => void this.due(one.id), wait));
      }
    }
  }

  /** Stops the timers and the tail, for a closing app. Recordings stop with the process. */
  close(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.tail?.close();
    this.tail = null;
  }

  private async due(id: string): Promise<void> {
    this.timers.delete(id);
    const booking = this.allBookings().find(one => one.id === id);
    this.saveBookings(this.allBookings().filter(one => one.id !== id));
    if (!booking || booking.endsAt <= this.now()) {
      this.changed(id);
      return;
    }
    // A recording still running is in its minutes after the end: the page
    // booked nothing that overlaps the programmes themselves (shared/recording,
    // clashesWith). It lets go of the connection.
    await Promise.all(this.runningIds().map(running => this.stop(running)));
    this.start({ id, url: booking.url, title: booking.title, channel: booking.channel, channelId: booking.channelId, endsAt: booking.endsAt });
  }

  private allBookings(): Array<BookRequest> {
    try {
      const read = JSON.parse(readFileSync(this.bookingsFile, 'utf8'));
      return Array.isArray(read) ? read.filter(one => one && ID.test(one.id) && typeof one.url === 'string') : [];
    } catch {
      return [];
    }
  }

  private saveBookings(all: BookRequest[]): void {
    writeFileSync(this.bookingsFile, JSON.stringify(all));
  }
}

/** What a recording of an HLS channel says: such a channel cannot be recorded yet. */
export const PLAYLIST_FAILURE = 'the channel is a playlist (HLS), which cannot be recorded yet';

const isPlaylist = (type: string | undefined): boolean => /mpegurl/i.test(type ?? '');

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
