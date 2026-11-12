import { Env } from './d1';

/**
 * Answering, in the shape every client already expects.
 *
 * `{ success, data }` and `{ success, message }`, the same envelope the
 * Express backend uses, because the devices are not being rewritten -- they are
 * being pointed somewhere else.
 */

/** What a handler can throw to answer with a status of its own. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Origins allowed to call this.
 *
 * The devices are native, and native origins are odd: Capacitor serves from
 * `https://localhost` and electron-serve from a scheme of its own. There are
 * no cookies anywhere in this design -- the token travels in a header -- so
 * CORS is not what keeps anything safe here, but an allowlist still costs
 * nothing and keeps a stray web page out of the browser's own error console.
 */
const DEFAULT_ORIGINS = [
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'app://-'
];

const allowed = (env: Env): string[] =>
  env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',')
        .map(origin => origin.trim())
        .filter(Boolean)
    : DEFAULT_ORIGINS;

export const corsHeaders = (request: Request, env: Env): Record<string, string> => {
  const origin = request.headers.get('Origin');
  const permitted = origin && allowed(env).includes(origin);

  return {
    // An app with no Origin at all -- a native fetch, or curl -- is not a
    // browser and has nothing to be protected from.
    ...(permitted ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
};

export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });

export const ok = (data: unknown, status = 200, headers?: Record<string, string>): Response =>
  json({ success: true, data }, status, headers);

export const fail = (message: string, status: number, headers?: Record<string, string>): Response =>
  json({ success: false, message, timestamp: new Date().toISOString() }, status, headers);

/**
 * The request body as an object, or a 400.
 *
 * An array is refused as well as a non-object: `[]` is valid JSON and would
 * otherwise reach a handler expecting fields, which would read every one of
 * them as undefined and do something quietly wrong.
 */
/**
 * The largest body any route takes: a subtitle (512 KB of text) with room to
 * spare. Above it the request is refused before it is parsed -- before a
 * session is even asked for on the open routes.
 */
export const MAX_BODY_CHARS = 1024 * 1024;

export const readJson = async <T>(request: Request): Promise<T> => {
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_CHARS) {
    throw new HttpError('That is more than this service takes in one request', 413);
  }
  let parsed: unknown;
  let body: string;
  try {
    body = await request.text();
  } catch {
    throw new HttpError('The body must be JSON', 400);
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new HttpError('That is more than this service takes in one request', 413);
  }
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError('The body must be JSON', 400);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError('The body must be a JSON object', 400);
  }

  return parsed as T;
};
