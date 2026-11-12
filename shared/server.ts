/**
 * Which sync service an app signs in to: the one
 * the build names by default, or one somebody runs themselves -- on their own
 * free Cloudflare account, as the sync service is meant to be run.
 *
 * Here rather than in the app so the planned tvinto CLI reads an address the
 * same way: `tvinto` signs in as one more device, to whichever server the
 * person's account is on.
 */

/**
 * The API address for what somebody typed, or null when it cannot be one.
 *
 * People type a host and nothing else ("my-sync.example.workers.dev"), the
 * address their browser shows, or the API address itself. All three mean the
 * same server: https unless they said otherwise, no query or fragment, and
 * `/api` at the end, which is where the service answers.
 */
export function normaliseServerAddress(input: string): string | null {
  const typed = input.trim();
  if (!typed || /\s/.test(typed)) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '');
  const api = path.endsWith('/api') ? path : `${path}/api`;
  return `${url.protocol}//${url.host}${api}`;
}

/**
 * The addresses to try for what somebody typed, in order: the one
 * `normaliseServerAddress` gives, and -- only when no scheme was typed and
 * the host is on their own network -- the same over plain http.
 *
 * A service run at home (`192.168.1.20:8787`, `nas.local`) usually has no
 * certificate, and typing the host alone meant https, which it cannot answer:
 * ten seconds of "Checking…" and then "not reached" (8 October). Never for a
 * public host -- a quietly plain-http sign-in on the open internet is exactly
 * what https is there to prevent -- and never when https was asked for.
 */
export function serverAddressCandidates(input: string): string[] {
  const first = normaliseServerAddress(input);
  if (!first) {
    return [];
  }
  const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim());
  const url = new URL(first);
  if (typedScheme || url.protocol !== 'https:' || !isOwnNetwork(url.hostname)) {
    return [first];
  }
  return [first, first.replace(/^https:/, 'http:')];
}

/** localhost, the private IPv4 ranges, link-local, and `.local` / `.lan` / `.home.arpa` names. */
export function isOwnNetwork(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /\.(local|lan|home\.arpa)$/.test(host)) {
    return true;
  }
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** Whether a health answer is a sync service's: `{ success, data: { service: 'sync' } }`. */
export function isSyncServiceHealth(body: unknown): boolean {
  const data = (body as { data?: { service?: unknown } } | null)?.data;
  return (body as { success?: unknown } | null)?.success === true && data?.service === 'sync';
}

/**
 * Whether a new account there needs an invite, from its health answer:
 * `open`, `invite`, or null for a server that does not say -- one from before
 * it said, which took invites only, so the app treats null as `invite`.
 */
export function registrationOf(body: unknown): 'open' | 'invite' | null {
  const said = (body as { data?: { registration?: unknown } } | null)?.data?.registration;
  return said === 'open' || said === 'invite' ? said : null;
}

/** How a server is shown: its host, which is what people recognise. */
export function serverName(apiUrl: string): string {
  try {
    return new URL(apiUrl).host;
  } catch {
    return apiUrl;
  }
}
