import { InjectionToken } from '@angular/core';
import { Capacitor } from '@capacitor/core';

/**
 * Where the backend is, as this build sees it.
 *
 * It was written out in five places, all saying localhost, which was true
 * everywhere the app had ever run. It stopped being true the moment the app
 * ran on a phone: localhost there is the phone.
 *
 * A function, asked at each use rather than once as the app starts: a server
 * chosen at sign-in is then the one everything talks to at once. When it was
 * a string read at startup, choosing one restarted the app, which came back
 * on Welcome with what the person had typed gone (12 November).
 */
export const API_URL = new InjectionToken<() => string>('API_URL', {
  providedIn: 'root',
  factory: () => resolveApiUrl
});

/** Where the backend listens. */
const PORT = 3000;

/**
 * The Android emulator's alias for the machine hosting it.
 *
 * 127.0.0.1 inside the emulator is the emulated device, so the host is
 * unreachable by that name. 10.0.2.2 is the address the emulator maps back to
 * its host's loopback -- the one case where a device can reach a backend
 * running on the developer's own machine with no configuration at all.
 */
const EMULATOR_HOST_ALIAS = '10.0.2.2';

/**
 * The address this build was told to use, if it was told one.
 *
 * Set on the window rather than compiled in, so that one built bundle can be
 * pointed at a different backend without being rebuilt -- which is what makes
 * a static host workable: the same files, and one line of configuration beside
 * them saying where the server is.
 */
function configuredApiUrl(): string | null {
  const configured = (window as { __XTREAM_API_URL__?: string }).__XTREAM_API_URL__;
  return configured ? configured.replace(/\/+$/, '') : null;
}

/**
 * A sync service somebody chose at sign-in, over the build's own
 * ("use the default, or enter your own"). Kept on the device, not in
 * the account -- it is where the account is, so it has to be known before
 * there is one. Changed only while signed out; every service reads it as it
 * makes a request (API_URL), so no restart is needed.
 */
export const CHOSEN_SERVER_KEY = 'xtream_server_url';

export function chosenServer(): string | null {
  try {
    return localStorage.getItem(CHOSEN_SERVER_KEY);
  } catch {
    return null;
  }
}

/** Keeps a server for the next start, or forgets it (null) for the build's own. */
export function chooseServer(apiUrl: string | null): void {
  try {
    if (apiUrl) {
      localStorage.setItem(CHOSEN_SERVER_KEY, apiUrl);
    } else {
      localStorage.removeItem(CHOSEN_SERVER_KEY);
    }
  } catch {
    // Without storage the choice cannot be kept; the default stays.
  }
}

/**
 * The API address a `/health` answer was really given from, when it got there
 * through a redirect (http to https, an HSTS host, a moved service); null when
 * it was answered where it was asked.
 *
 * Kept instead of the typed one because Chromium drops Authorization on a
 * redirect to another origin (seen on Electron 45; the Electron 26 desktop
 * signed in to the same server): signing in
 * worked, and every request after it came back 401 (24 November).
 */
export function movedApiUrl(response: Pick<Response, 'redirected' | 'url'>): string | null {
  return response.redirected && /\/health$/.test(response.url) ? response.url.replace(/\/health$/, '') : null;
}

/**
 * Where updates come from: the feed this build was made for (config.js,
 * written from frontend/scripts/feed.js), whichever server the account is on.
 * A server somebody runs for themselves is the sync service and nothing else
 * -- it has no builds -- and asking it would leave that device without
 * updates, silently.
 *
 * A config.js from before the feed had its own line names only a server; that
 * build was updated from the server's `/updates`. Null for a build with
 * neither, which then looks for no updates.
 */
export function updatesBaseUrl(): string | null {
  const feed = (window as { __TVINTO_UPDATES_URL__?: string }).__TVINTO_UPDATES_URL__;
  if (feed) {
    return feed.replace(/\/+$/, '');
  }
  const api = configuredApiUrl();
  return api ? api.replace(/\/api\/?$/, '') + '/updates' : null;
}

/**
 * Whether there is any server to use before somebody names one: chosen here
 * before, written in config.js, or the backend beside a page in a browser.
 * A public build is none of these -- it names
 * nobody's server, and the guesses below (this machine, the emulator's host)
 * would only send a person's account nowhere.
 */
export function hasServer(): boolean {
  return chosenServer() !== null || buildHasServer();
}

/** Whether the build has a server of its own to go back to ("Use the default"). */
export function buildHasServer(): boolean {
  if (configuredApiUrl() !== null) {
    return true;
  }
  const platform = Capacitor.getPlatform();
  return platform === 'web' && !(typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent));
}

export function resolveApiUrl(): string {
  return chosenServer() ?? defaultApiUrl();
}

/** The build's own server: what it was configured with, or what it can infer. */
export function defaultApiUrl(): string {
  const platform = Capacitor.getPlatform();
  const isElectron =
    platform === 'electron' ||
    (typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent));

  // Checked before anything is inferred, on every platform. A hosted browser
  // build is served from one origin and answered by another, so the page's own
  // address stopped being a good guess the moment the backend left the machine.
  const configured = configuredApiUrl();
  if (configured) {
    return configured;
  }

  // Otherwise a browser talks to whatever served it. In development that is
  // the dev server on another port, so the port is named rather than inherited.
  if (platform === 'web' && !isElectron) {
    return `${window.location.protocol}//${window.location.hostname}:${PORT}/api`;
  }

  // A desktop app is served from its own scheme, so its address says nothing
  // about where a backend is. It talks to the provider directly and needs one
  // only for signing in, which is on the same machine while this is unhosted.
  if (isElectron) {
    return `http://localhost:${PORT}/api`;
  }

  // A packaged app is served from localhost inside its own WebView, so the
  // page's own address says nothing about where the backend is. Falls back to
  // the emulator alias so a fresh build is testable without being configured
  // first.
  return `http://${EMULATOR_HOST_ALIAS}:${PORT}/api`;
}
