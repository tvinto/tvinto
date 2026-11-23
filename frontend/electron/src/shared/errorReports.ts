// Copied from shared/ by scripts/copy-shared.js. Change it there, then run that.
/**
 * Error reports: what an official build sends by itself when something goes
 * wrong, and the cleaning every report passes through before it leaves the
 * device (docs/error-reports.md).
 *
 * People do not report problems by hand, so official builds send errors on
 * their own -- on by default, said so where the app starts, and one switch to
 * turn off (SETTING_KEYS.errorReports). Errors only: no usage, no screens
 * viewed, nothing about what was pressed.
 *
 * A report may say which device, which system, which version and what failed.
 * It may never say whose: no provider address, username or password, no
 * channel, film or show, no account name or email, no sync server, no key.
 * The cleaning below works on every string in a report, wherever it sits --
 * the message, the stack, extra data, attached log lines -- because a name
 * that is safe in one field is not safe in the next one somebody adds.
 *
 * Self-contained, with no imports: the desktop app's main process carries a
 * copy of this file (frontend/electron/src/shared/errorReports.ts, kept the
 * same by a test), since its build cannot reach shared/.
 */

/** The setting's value when it is off. Anything else, including nothing, is on. */
export const ERROR_REPORTS_OFF = 'off';
export const ERROR_REPORTS_ON = 'on';

/** On unless turned off: the decision of 22 November. */
export const sendsErrorReports = (value: string | null | undefined): boolean => value !== ERROR_REPORTS_OFF;

export const errorReportsValue = (on: boolean): string => (on ? ERROR_REPORTS_ON : ERROR_REPORTS_OFF);

export interface ReportingState {
  /** The build's report address. None in a fork or a self-build, which then sends nothing. */
  dsn: string | null | undefined;
  /** The account's setting (sendsErrorReports). */
  setting: string | null | undefined;
  /** This device has shown the switch: onboarding, or the one-time notice. */
  shown: boolean;
}

/** Whether anything may be sent now. All three, or nothing. */
export const mayReport = (state: ReportingState): boolean =>
  isReportAddress(state.dsn) && state.shown && sendsErrorReports(state.setting);

/** A Sentry DSN: http(s), a key before the @, a project number at the end. */
export const isReportAddress = (dsn: string | null | undefined): dsn is string =>
  typeof dsn === 'string' && /^https?:\/\/[A-Za-z0-9]+@[^\s/'"\\]+\/\d+$/.test(dsn.trim());

/** What a removed value is replaced with. */
const REMOVED = '[removed]';

/** Values shorter than this are only taken out where they stand as a word of their own. */
const SHORT = 3;

/**
 * The stream's file name without where it lives or who asked: "http …/1234.m3u8".
 * The same as the desktop playback log's (frontend/electron/src/playbackLog.ts),
 * which a report's log lines have already passed through.
 */
export function cleanAddress(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim())?.[1]?.toLowerCase();
  if (!scheme) {
    return 'a local file';
  }
  const path = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0] ?? '';
  const last = path.split('/').filter(Boolean).pop() ?? '';
  // A channel number and an extension; anything else could be a name or a token.
  return /^\d{1,12}(\.[A-Za-z0-9]{1,5})?$/.test(last) ? `${scheme} …/${last}` : `${scheme} …`;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Pattern = readonly [RegExp, string | ((match: string) => string)];

/**
 * Addresses and the like, in order, before anything else: whole, so the
 * parts of one (a host, a user and password in its path, a query) go with it
 * and the stream's number stays.
 */
const ADDRESS_PATTERNS: readonly Pattern[] = [
  // Any address with a scheme: http, https, rtmp, tvinto, file, capacitor...
  // A full stop or comma after one ends the sentence, not the address.
  [/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>()`]+/gi, match => {
    const end = /[.,;:!?]+$/.exec(match)?.[0] ?? '';
    return cleanAddress(match.slice(0, match.length - end.length)) + end;
  }],
  // A person's own folder, which is named after them: C:\Users\Mario\..., /home/mario/...
  [/\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s'"]+/gi, '[home]'],
  [/(?:\/home|\/Users)\/[^/\s'"]+/g, '[home]'],
  // An email address.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // A host and port with or without a path, no scheme: panel.example.com:8080/walk/walk/1.ts.
  // Not a file of the app's own (main-AB12.js:1:2 in a stack written out).
  [/\b(?:[A-Za-z0-9-]+\.)+(?!(?:js|mjs|cjs|ts|map|html?|css|json|node|exe|dll|cpp|log)\b)[A-Za-z]{2,}(?::\d{1,5})(?:\/[^\s'"<>()`]*)?/g, '[address]'],
  [/\b(?:[A-Za-z0-9-]+\.)+(?!(?:js|mjs|cjs|ts|map|html?|css|json|node|exe|dll|cpp|log)\b)[A-Za-z]{2,}\/[^\s'"<>()`]+/g, '[address]'],
  // IP addresses, v4 and v6, with any port and path.
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/[^\s'"<>()`]*)?/g, '[address]'],
  [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, '[address]']
];

/** After the known values: credentials, queries and keys wherever they are left. */
const OTHER_PATTERNS: readonly Pattern[] = [
  // name=value and name: value for anything that names a secret or a person.
  [
    /\b(user(?:name)?|login|pass(?:word|wd)?|pwd|token|secret|api[_-]?key|key|auth(?:orization)?|mac|email|account|session|cookie|sig(?:nature)?)(["']?\s*[=:]\s*["']?)(?:bearer\s+|basic\s+)?[^\s&"',;)}\]]+/gi,
    (match: string) => match.replace(/^(\w[\w-]*["']?\s*[=:]\s*["']?)[\s\S]*$/i, `$1${REMOVED}`)
  ],
  // A query string left on its own (?a=b&c=d).
  [/\?[A-Za-z0-9_.-]+=[^\s'"<>]*/g, '?[removed]'],
  // A key or token of its own: a long run of letters and digits with both in it.
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, REMOVED],
  // A MAC address (Stalker portals sign in with one).
  [/\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b/gi, '[mac]']
];

/**
 * One string, cleaned: addresses, emails, credentials, keys, and every value
 * in `personal` (the provider's host, username, password, the account's name
 * and email, the sync server -- whatever the app holds at the time).
 */
export function cleanText(text: string, personal: readonly string[] = []): string {
  // Addresses first; then the known values, since a username in a sentence
  // ("walk could not sign in") is found only by name; then everything else.
  let out = text;
  for (const [pattern, replacement] of ADDRESS_PATTERNS) {
    out = out.replace(pattern, replacement as string);
  }
  for (const value of knownValues(personal)) {
    const pattern =
      value.length < SHORT
        ? new RegExp(`(?<![A-Za-z0-9])${escape(value)}(?![A-Za-z0-9])`, 'g')
        : new RegExp(escape(value), 'gi');
    out = out.replace(pattern, REMOVED);
  }
  for (const [pattern, replacement] of OTHER_PATTERNS) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

/**
 * The personal values as they may appear: each as given, and the host of any
 * that is an address, so `http://panel.example.com:8080` also takes out
 * `panel.example.com` standing alone. Longest first, so a value that contains
 * another goes whole.
 */
function knownValues(personal: readonly string[]): string[] {
  const values = new Set<string>();
  for (const raw of personal) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      continue;
    }
    values.add(value);
    const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(value)?.[1];
    if (host) {
      values.add(host);
    }
    try {
      const decoded = decodeURIComponent(value);
      if (decoded !== value) {
        values.add(decoded);
      }
      const encoded = encodeURIComponent(value);
      if (encoded !== value) {
        values.add(encoded);
      }
    } catch {
      // Not encoded, or not encodable: as given is enough.
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Fields a report never carries, wherever they turn up. */
const DROPPED_KEYS = new Set([
  'user',
  'cookies',
  'cookie',
  'headers',
  'query_string',
  'server_name',
  'ip_address',
  'breadcrumbs',
  // Native and source-map images: their paths name the person's folders, and
  // a minidump is worked out from its attachment without them.
  'debug_meta'
]);

/** Keys whose value is a person's own, whatever it looks like. */
const SECRET_KEYS = /^(user(name)?|login|pass(word)?|pwd|token|secret|api[_-]?key|key|auth(orization)?|mac|email|account|session|host(name)?|server|url|title|computer_name)$/i;

/** Stack frames point at the app's own files; only the file's name is kept. */
const FRAME_FILE_KEYS = new Set(['filename', 'abs_path', 'module', 'package']);

/**
 * The SDK's own fields, left as they are: an event id is 32 letters and
 * digits, which the cleaning would take for a key, and Sentry refuses an
 * event without it.
 */
const SDK_FIELDS = new Set(['event_id', 'timestamp', 'start_timestamp', 'platform', 'level', 'release', 'dist', 'environment', 'type', 'logger', 'trace_id', 'span_id', 'parent_span_id', 'sdk']);

const MAX_DEPTH = 12;

/**
 * Every string in a report, cleaned, at any depth; the fields above dropped.
 * Returns a new value and leaves the one given alone.
 */
export function cleanValue<T>(value: T, personal: readonly string[] = [], depth = 0): T {
  if (typeof value === 'string') {
    return cleanText(value, personal) as T;
  }
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => cleanValue(item, personal, depth + 1)) as T;
  }
  // Binary attachments (a minidump) are not text and are left as they are.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_KEYS.has(key)) {
      continue;
    }
    if (SDK_FIELDS.has(key) && typeof field !== 'object') {
      out[key] = field;
    } else if (FRAME_FILE_KEYS.has(key) && typeof field === 'string') {
      out[key] = appFile(field);
    } else if (SECRET_KEYS.test(key) && typeof field === 'string') {
      out[key] = REMOVED;
    } else {
      out[key] = cleanValue(field, personal, depth + 1);
    }
  }
  return out as T;
}

/** `capacitor-electron://-/main-AB12.js?x=1` -> `app:///main-AB12.js`: where in the app, not whose. */
export function appFile(path: string): string {
  const last = path.split(/[?#]/)[0]?.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return /^[A-Za-z0-9._<>-]{1,80}$/.test(last) ? `app:///${last}` : 'app:///?';
}

/** The parts of a Sentry event the cleaning knows by shape. */
export interface ReportEvent {
  request?: { url?: string; [key: string]: unknown };
  contexts?: Record<string, unknown>;
  sdk?: { settings?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

/** What a context may say, by context: the kind of device and system, never its name. */
const CONTEXT_FIELDS: Record<string, readonly string[]> = {
  device: ['family', 'model', 'model_id', 'arch', 'brand', 'manufacturer', 'screen_resolution', 'screen_density', 'screen_dpi', 'memory_size', 'processor_count', 'cpu_description', 'processor_frequency', 'simulator', 'orientation'],
  os: ['name', 'version', 'build', 'kernel_version'],
  runtime: ['name', 'version'],
  browser: ['name', 'version'],
  app: ['app_version', 'app_build', 'app_name', 'app_memory', 'app_start_time', 'in_foreground'],
  culture: ['locale', 'timezone'],
  electron: ['crashed_process', 'crashed_url', 'details'],
  chrome: ['name', 'version'],
  node: ['name', 'version'],
  gpu: ['name', 'vendor_name', 'vendor_id', 'id', 'driver_version'],
  trace: ['trace_id', 'span_id', 'parent_span_id']
};

/**
 * A whole event, ready to leave the device: every string cleaned, no user,
 * no IP address (and Sentry told not to work one out from the connection),
 * no breadcrumbs, no cookies or headers, the page's address down to the
 * screen's name, contexts down to the kind of device.
 */
export function cleanReport<T extends object>(event: T, personal: readonly string[] = []): T {
  const { request, contexts, sdk, ...rest } = event as ReportEvent;
  const cleaned = cleanValue(rest, personal) as ReportEvent;
  if (request && typeof request === 'object') {
    // The browser's own name for itself says which system and version, and is
    // the one header kept.
    const headers = (request['headers'] ?? {}) as Record<string, unknown>;
    const agent = headers['User-Agent'] ?? headers['user-agent'];
    cleaned.request = {
      ...(typeof request.url === 'string' ? { url: appScreen(request.url) } : {}),
      ...(typeof agent === 'string' ? { headers: { 'User-Agent': cleanText(agent, personal) } } : {})
    };
  }
  if (contexts && typeof contexts === 'object') {
    const kept: Record<string, unknown> = {};
    for (const [name, context] of Object.entries(contexts)) {
      const fields = CONTEXT_FIELDS[name];
      if (!fields || !context || typeof context !== 'object') {
        continue;
      }
      const copy: Record<string, unknown> = {};
      for (const field of fields) {
        const value = (context as Record<string, unknown>)[field];
        if (value === undefined) {
          continue;
        }
        copy[field] =
          field === 'crashed_url' && typeof value === 'string'
            ? appScreen(value)
            : name === 'trace'
              ? value
              : typeof value === 'string'
                ? cleanText(value, personal)
                : cleanValue(value, personal, 1);
      }
      kept[name] = copy;
    }
    cleaned.contexts = kept;
  }
  cleaned.sdk = { ...(sdk ?? {}), settings: { ...(sdk?.settings ?? {}), infer_ip: 'never' } };
  return cleaned as T;
}

/** The screen a report came from, without ids: `#/live/12/345` -> `app:///live`. */
export function appScreen(url: string): string {
  const route = (url.split('#')[1] ?? url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')).split(/[?#]/)[0] ?? '';
  const first = route.split('/').filter(Boolean)[0] ?? '';
  return /^[a-z-]{1,30}$/.test(first) ? `app:///${first}` : 'app:///';
}

/** How many of the app's own log lines go with a report. */
export const LOG_LINES = 50;

/** The last lines of a log, cleaned, for a report's extra data. */
export function cleanLogTail(log: string, personal: readonly string[] = [], lines = LOG_LINES): string[] {
  return log
    .split(/\r?\n/)
    .filter(line => line.trim())
    .slice(-lines)
    .map(line => cleanText(line, personal));
}

/**
 * An exit of tvinto-player or mpv that is worth a report. Not: closed by the
 * viewer (0), the channel keys (10, 11), closed by the app over a stream that
 * failed (4) or a stream that could not be played (2) -- those are the
 * provider's, and part 2 reports them as what they are. A crash (a signal, or
 * a Windows exception code such as 3221225477) and anything else unexpected is.
 */
export function abnormalPlayerExit(code: number | null, signal: string | null): boolean {
  if (signal) {
    return true;
  }
  return code !== null && ![0, 2, 4, 10, 11].includes(code);
}
