import { toPage } from './pageChannel';
import { fromAppPage } from './appPage';
import type { BrowserWindow } from 'electron';
import { app, ipcMain } from 'electron';

/**
 * tvinto:// links on the desktop: how `tvinto sign-in` opens the app on its
 * request, for a person to allow.
 *
 * The installed app registers itself as the handler; a copy run from source
 * does not, so it never takes links meant for the installed one. Windows
 * hands a link to a new process, so only one copy runs: a second start passes
 * its link to the first and quits. Links that arrive before the page is ready
 * wait until it asks for them.
 */

const SCHEME = 'tvinto';

const waiting: string[] = [];
let windowOf: () => BrowserWindow | null = () => null;
let pageListening = false;

const linksIn = (argv: readonly string[]): string[] => argv.filter(arg => arg.startsWith(`${SCHEME}://`));

function deliver(link: string): void {
  const window = windowOf();
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }
  if (window && !window.isDestroyed() && pageListening) {
    toPage(window.webContents, 'xtream:deep-link', link);
  } else {
    waiting.push(link);
  }
}

/**
 * Takes the single-instance lock and listens for links. False when another
 * copy already runs: this one has handed its link over and should quit.
 */
export function setupDeepLinks(getWindow: () => BrowserWindow | null): boolean {
  if (!app.requestSingleInstanceLock()) {
    return false;
  }
  windowOf = getWindow;
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(SCHEME);
  }

  waiting.push(...linksIn(process.argv));
  app.on('second-instance', (_event, argv) => {
    const links = linksIn(argv);
    if (!links.length) {
      // Started again by hand: bring this one forward.
      const window = windowOf();
      window?.show();
      window?.focus();
    }
    links.forEach(deliver);
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliver(url);
  });

  // The page asks once it can act on them; from then on they are sent as they come.
  ipcMain.handle('xtream:deep-links', event => {
    if (!fromAppPage(event)) {
      return [];
    }
    pageListening = true;
    return waiting.splice(0);
  });
  return true;
}
