import { Env } from './d1';
import { HttpError } from './http';

/**
 * Where the desktop app gets its updates from.
 *
 * `electron-updater`'s generic provider is a directory over HTTP: it asks for
 * `latest.yml`, reads the version and the file name out of it, and then asks
 * for that file. So this is a static file server, and the only reason it is a
 * Worker rather than a bucket with a public URL is that a bucket's public URL
 * is a hostname nobody controls -- if it ever has to move, every installed
 * copy is already pointing at it and cannot be told otherwise. This address
 * belongs to us and can be redirected.
 *
 * The bucket stays private. Nothing here is secret -- an installer is meant to
 * be downloadable -- but "not secret" and "reachable by its own URL forever"
 * are different things.
 */

/** What an object out of R2 looks like, as far as this uses it. */
export interface UpdateObject {
  body: ReadableStream | null;
  size: number;
  httpEtag: string;
  /** When it was put here. The download page prints it; nothing else reads it. */
  uploaded: Date;
}

/** The part of R2 this depends on, so a test can supply the rest of it. */
export interface UpdateBucket {
  get(
    key: string,
    options?: { range?: { offset: number; length: number } }
  ): Promise<UpdateObject | null>;
  head(key: string): Promise<UpdateObject | null>;
}

/**
 * A file name, and nothing that is secretly a path.
 *
 * electron-builder writes `latest.yml`, `Xtream-Setup-1.2.3.exe` and
 * `Xtream-Setup-1.2.3.exe.blockmap` into one flat directory, so one flat
 * directory is all this serves. Anything with a slash, a backslash or a dot
 * segment in it is a caller trying to leave, not a caller who mistyped.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const safeName = (name: string): boolean => NAME.test(name) && !name.includes('..');

/**
 * A manifest is the one kind of file here that changes under a fixed name.
 *
 * Everything else -- an installer, a bundle, an APK -- carries its version in
 * its own name and so is a different file when it is a different version.
 * That difference decides both the caching below and, for a reader, which
 * files are answers and which are questions.
 */
const isManifest = (name: string): boolean =>
  name.endsWith('.yml') || name.endsWith('.yaml') || name.endsWith('.json');

const contentType = (name: string): string => {
  if (name.endsWith('.yml') || name.endsWith('.yaml')) {
    // Not `text/yaml`: electron-updater reads the body as text either way, and
    // a charset spelled out is one fewer thing for a proxy to guess wrong.
    return 'text/yaml; charset=utf-8';
  }
  if (name.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (name.endsWith('.apk')) {
    // Android decides whether a download can be installed partly by this. The
    // Downloader app on a television offers to install what it fetched only
    // when the server said it was a package.
    return 'application/vnd.android.package-archive';
  }
  if (name.endsWith('.zip')) {
    return 'application/zip';
  }
  return 'application/octet-stream';
};

/**
 * How long a copy of this may be kept.
 *
 * A manifest is the question "is there a new version", so caching it is
 * caching the answer -- a minute, no more. An installer is named after its own
 * version and so can never change; caching it forever is what keeps the
 * download off this Worker on a second attempt.
 *
 * `android-latest.json` was on the immutable side of this until the download
 * page needed the same rule for the APK's manifest: a phone reads it with a
 * client that keeps no cache, so nothing was ever observed to go wrong, and
 * anything in between the two would have held a year-old answer.
 */
const cacheControl = (name: string): string =>
  isManifest(name) ? 'public, max-age=60, must-revalidate' : 'public, max-age=31536000, immutable';

/**
 * `Range: bytes=a-b`, as far as a downloader resuming a file uses it.
 *
 * electron-updater asks for pieces when it has a blockmap for the version it
 * already has, and downloads only the blocks that differ. Answering the whole
 * file to a range request is not wrong -- it falls back to a full download --
 * but it throws away the point of the blockmap.
 *
 * Returns `null` for a header this does not understand, which is answered as
 * the whole file, and `'unsatisfiable'` for one that is understood and cannot
 * be met.
 */
export const parseRange = (
  header: string | null,
  size: number
): { offset: number; length: number } | null | 'unsatisfiable' => {
  if (!header) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    // Multiple ranges, or a unit that is not bytes. Neither is worth the code.
    return null;
  }

  const [, from, to] = match;

  if (from === '' && to === '') {
    return null;
  }

  // `bytes=-500` is the last 500 bytes, not "up to 500".
  const offset = from === '' ? Math.max(0, size - Number(to)) : Number(from);
  const last = from === '' ? size - 1 : to === '' ? size - 1 : Math.min(Number(to), size - 1);

  if (offset >= size || last < offset) {
    return 'unsatisfiable';
  }

  return { offset, length: last - offset + 1 };
};

/**
 * Serve one file out of the update bucket.
 *
 * Fails closed: with no bucket bound this says so rather than 404ing, because
 * "there is no such version" and "updates are not set up here" send a device
 * in opposite directions, and only one of them is worth investigating.
 */
export const serveUpdate = async (request: Request, env: Env, path: string): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError('No such endpoint', 404);
  }

  const bucket = env.UPDATES;
  if (!bucket) {
    throw new HttpError('Updates are not configured on this service', 503);
  }

  // The path only. electron-updater asks for `latest.yml?noCache=<random>`,
  // which is it defeating a cache it does not control -- so a query string is
  // ordinary here, and must not become part of the name being looked up.
  const name = decodeURIComponent(path.slice('/updates/'.length));
  if (!safeName(name)) {
    throw new HttpError('No such file', 404);
  }

  const headers = new Headers({
    'Content-Type': contentType(name),
    'Cache-Control': cacheControl(name),
    'Accept-Ranges': 'bytes'
  });

  if (request.method === 'HEAD') {
    const head = await bucket.head(name);
    if (!head) {
      throw new HttpError('No such file', 404);
    }

    headers.set('Content-Length', String(head.size));
    headers.set('ETag', head.httpEtag);
    return new Response(null, { status: 200, headers });
  }

  // The size has to be known before a range can be resolved, and `head` is the
  // cheap way to know it. A whole-file request skips it.
  const wanted = request.headers.get('Range');
  if (wanted) {
    const head = await bucket.head(name);
    if (!head) {
      throw new HttpError('No such file', 404);
    }

    const range = parseRange(wanted, head.size);

    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }

    if (range) {
      const part = await bucket.get(name, { range });
      if (!part) {
        throw new HttpError('No such file', 404);
      }

      headers.set('Content-Length', String(range.length));
      headers.set(
        'Content-Range',
        `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`
      );
      headers.set('ETag', part.httpEtag);
      return new Response(part.body, { status: 206, headers });
    }
  }

  const object = await bucket.get(name);
  if (!object) {
    throw new HttpError('No such file', 404);
  }

  headers.set('Content-Length', String(object.size));
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, { status: 200, headers });
};
