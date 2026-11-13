import { openPageChannel } from './pageChannel';
import type { CapacitorElectronConfig } from '@capacitor-community/electron';
import {
  CapElectronEventEmitter,
  CapacitorSplashScreen,
  setupCapacitorElectronPlugins,
} from '@capacitor-community/electron';
import chokidar from 'chokidar';
import type { MenuItemConstructorOptions } from 'electron';
import { app, BrowserWindow, Menu, MenuItem, nativeImage, Tray, session } from 'electron';

import electronServe from 'electron-serve';
import windowStateKeeper from 'electron-window-state';
import { readFileSync } from 'fs';
import { join } from 'path';

// Developer mode only for a copy that is not installed. electron-is-dev also
// honours ELECTRON_IS_DEV=1, which would turn DevTools and a looser policy on
// in an installed app from nothing more than its environment.
const electronIsDev = !app.isPackaged;

// Define components for a watcher to detect when the webapp is changed so we can reload in Dev mode.
const reloadWatcher = {
  debouncer: null,
  ready: false,
  watcher: null,
};
export function setupReloadWatcher(electronCapacitorApp: ElectronCapacitorApp): void {
  reloadWatcher.watcher = chokidar
    .watch(join(app.getAppPath(), 'app'), {
      ignored: /[/\\]\./,
      persistent: true,
    })
    .on('ready', () => {
      reloadWatcher.ready = true;
    })
    .on('all', (_event, _path) => {
      if (reloadWatcher.ready) {
        clearTimeout(reloadWatcher.debouncer);
        reloadWatcher.debouncer = setTimeout(async () => {
          electronCapacitorApp.getMainWindow().webContents.reload();
          reloadWatcher.ready = false;
          clearTimeout(reloadWatcher.debouncer);
          reloadWatcher.debouncer = null;
          reloadWatcher.watcher = null;
          setupReloadWatcher(electronCapacitorApp);
        }, 1500);
      }
    });
}

// Define our class to manage our app.
export class ElectronCapacitorApp {
  private MainWindow: BrowserWindow | null = null;
  private SplashScreen: CapacitorSplashScreen | null = null;
  private TrayIcon: Tray | null = null;
  private CapacitorFileConfig: CapacitorElectronConfig;
  private TrayMenuTemplate: (MenuItem | MenuItemConstructorOptions)[] = [
    new MenuItem({ label: 'Quit App', role: 'quit' }),
  ];
  private AppMenuBarMenuTemplate: (MenuItem | MenuItemConstructorOptions)[] = [
    { role: process.platform === 'darwin' ? 'appMenu' : 'fileMenu' },
    { role: 'viewMenu' },
  ];
  private mainWindowState;
  private loadWebApp;
  private customScheme: string;

  constructor(
    capacitorFileConfig: CapacitorElectronConfig,
    trayMenuTemplate?: (MenuItemConstructorOptions | MenuItem)[],
    appMenuBarMenuTemplate?: (MenuItemConstructorOptions | MenuItem)[]
  ) {
    this.CapacitorFileConfig = capacitorFileConfig;

    this.customScheme = this.CapacitorFileConfig.electron?.customUrlScheme ?? 'capacitor-electron';

    if (trayMenuTemplate) {
      this.TrayMenuTemplate = trayMenuTemplate;
    }

    if (appMenuBarMenuTemplate) {
      this.AppMenuBarMenuTemplate = appMenuBarMenuTemplate;
    }

    // Setup our web app loader, this lets us load apps like react, vue, and angular without changing their build chains.
    this.loadWebApp = electronServe({
      directory: join(app.getAppPath(), 'app'),
      scheme: this.customScheme,
    });
  }

  // Helper function to load in the app.
  private async loadMainWindow(thisRef: ElectronCapacitorApp) {
    await thisRef.loadWebApp(thisRef.MainWindow);
  }

  // Expose the mainWindow ref for use outside of the class.
  getMainWindow(): BrowserWindow {
    return this.MainWindow;
  }

  getCustomURLScheme(): string {
    return this.customScheme;
  }

  async init(): Promise<void> {
    const icon = nativeImage.createFromPath(
      join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'appIcon.ico' : 'appIcon.png')
    );
    this.mainWindowState = windowStateKeeper({
      defaultWidth: 1000,
      defaultHeight: 800,
    });
    // Setup preload script path and construct our main window.
    const preloadPath = join(app.getAppPath(), 'build', 'src', 'preload.js');
    this.MainWindow = new BrowserWindow({
      icon,
      show: false,
      x: this.mainWindowState.x,
      y: this.mainWindowState.y,
      width: this.mainWindowState.width,
      height: this.mainWindowState.height,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: true,
        /*
         * The whole reason a desktop build is worth having.
         *
         * The provider serves HTTP with no TLS listener at all, and a browsing
         * context may not read a cross-origin response from it however the page
         * itself was served. That is not a rule this app can satisfy -- it is
         * the reason the browser build has to go through a backend, and the
         * reason the Android build talks to the provider directly instead.
         *
         * Turning it off here buys the same freedom on the desktop: the
         * catalogue comes straight from the provider and no server of ours need
         * be running. It is safe in a way it would never be on the open web,
         * because this window loads one thing -- the application's own bundled
         * files -- and never navigates anywhere a stranger chose. The
         * navigation guard below is what keeps that true.
         */
        webSecurity: false,
        // Use preload to inject the electron varriant overrides for capacitor plugins.
        // preload: join(app.getAppPath(), "node_modules", "@capacitor-community", "electron", "dist", "runtime", "electron-rt.js"),
        preload: preloadPath,
      },
    });

    /*
     * Nothing navigates this window but the app itself.
     *
     * webSecurity is off above, so a page loaded from anywhere else would run
     * with the same freedom the app has. Nothing in the app navigates away or
     * opens windows, so refusing both costs nothing and closes the one hole
     * that setting opens.
     */
    this.MainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.MainWindow.webContents.on('will-navigate', (event, url) => {
      // Only the app's own scheme: a `file://` page would run with webSecurity off.
      const isOwnApp = url.startsWith(`${this.customScheme}://`);
      if (!isOwnApp) {
        event.preventDefault();
        console.warn('Refused to navigate away from the app:', url);
      }
    });
    this.mainWindowState.manage(this.MainWindow);
    // What the main process tells the page goes over a port (src/pageChannel.ts).
    openPageChannel(this.MainWindow.webContents);

    if (this.CapacitorFileConfig.backgroundColor) {
      this.MainWindow.setBackgroundColor(this.CapacitorFileConfig.electron.backgroundColor);
    }

    // If we close the main window with the splashscreen enabled we need to destory the ref.
    this.MainWindow.on('closed', () => {
      if (this.SplashScreen?.getSplashWindow() && !this.SplashScreen.getSplashWindow().isDestroyed()) {
        this.SplashScreen.getSplashWindow().close();
      }
    });

    // When the tray icon is enabled, setup the options.
    if (this.CapacitorFileConfig.electron?.trayIconAndMenuEnabled) {
      this.TrayIcon = new Tray(icon);
      this.TrayIcon.on('double-click', () => {
        if (this.MainWindow) {
          if (this.MainWindow.isVisible()) {
            this.MainWindow.hide();
          } else {
            this.MainWindow.show();
            this.MainWindow.focus();
          }
        }
      });
      this.TrayIcon.on('click', () => {
        if (this.MainWindow) {
          if (this.MainWindow.isVisible()) {
            this.MainWindow.hide();
          } else {
            this.MainWindow.show();
            this.MainWindow.focus();
          }
        }
      });
      this.TrayIcon.setToolTip(app.getName());
      this.TrayIcon.setContextMenu(Menu.buildFromTemplate(this.TrayMenuTemplate));
    }

    // Setup the main manu bar at the top of our window.
    Menu.setApplicationMenu(Menu.buildFromTemplate(this.AppMenuBarMenuTemplate));

    // If the splashscreen is enabled, show it first while the main window loads then switch it out for the main window, or just load the main window from the start.
    if (this.CapacitorFileConfig.electron?.splashScreenEnabled) {
      this.SplashScreen = new CapacitorSplashScreen({
        imageFilePath: join(
          app.getAppPath(),
          'assets',
          this.CapacitorFileConfig.electron?.splashScreenImageName ?? 'splash.png'
        ),
        windowWidth: 400,
        windowHeight: 400,
      });
      this.SplashScreen.init(this.loadMainWindow, this);
    } else {
      this.loadMainWindow(this);
    }

    // Security. The scaffold allowed any window whose address merely contained
    // the scheme's name -- `https://anywhere/capacitor-electron` -- and, set
    // here, it replaced the refusal above. A window the app never opens is
    // refused outright, for every web contents, child frames' popups included.
    this.MainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Link electron plugins into the system.
    setupCapacitorElectronPlugins();

    // A development copy that never shows a window (XTREAM_HEADLESS=1): checked
    // over the DevTools protocol from a script, with nothing appearing on the
    // owner's screen, which is in use while the checks run (1 November). At
    // the size the desktop is checked at. Never in an installed app.
    const headless = electronIsDev && process.env['XTREAM_HEADLESS'] === '1';
    if (headless) {
      // A window never shown stops painting after its first frame, and a
      // screenshot of it waits for one forever. So it is shown -- but without
      // focus, out of the taskbar, transparent and off every screen.
      this.MainWindow.setSize(1440, 900);
      this.MainWindow.setSkipTaskbar(true);
      this.MainWindow.setOpacity(0);
      this.MainWindow.setPosition(-20000, -20000);
      this.MainWindow.webContents.setBackgroundThrottling(false);
    }

    // When the web app is loaded we hide the splashscreen if needed and show the mainwindow.
    this.MainWindow.webContents.on('dom-ready', () => {
      if (this.CapacitorFileConfig.electron?.splashScreenEnabled) {
        this.SplashScreen.getSplashWindow().hide();
      }
      if (headless) {
        this.MainWindow.showInactive();
      } else if (!this.CapacitorFileConfig.electron?.hideMainWindowOnLaunch) {
        this.MainWindow.show();
      }
      setTimeout(() => {
        if (electronIsDev && !headless) {
          this.MainWindow.webContents.openDevTools();
        }
        CapElectronEventEmitter.emit('CAPELECTRON_DeeplinkListenerInitialized', '');
      }, 400);
    });
  }
}

// Set a CSP up for our application based on the custom scheme
/**
 * The headers the page may not set itself. Electron allows one
 * onBeforeSendHeaders per session, so both live here:
 *
 * - YouTube's embedded player refuses to play without an http(s) referrer --
 *   "Video player configuration error, Error 153" -- and this app's pages
 *   come from its own scheme, which no browser sends as one. The origin it
 *   names is the sync service this copy talks to, from `app/config.js`.
 *   Without one configured, nothing is added (D-22).
 * - A Stalker portal reads the MAC address from a cookie and wants a MAG
 *   box's user agent (shared/stalker/client.ts), and a page's fetch may set
 *   neither. The page sends them under PORTAL_HEADERS' own names, and they
 *   are put where the portal looks, here, for that request alone.
 */
const PORTAL_HEADERS = { cookie: 'X-Tvinto-Portal-Cookie', agent: 'X-Tvinto-Portal-Agent' };

export function setupRequestHeaders(): void {
  let origin = '';
  try {
    const config = readFileSync(join(app.getAppPath(), 'app', 'config.js'), 'utf8');
    const found = /^\s*window\.__XTREAM_API_URL__\s*=\s*['"](https:\/\/[^'"]+)['"]/m.exec(config);
    origin = found ? new URL(found[1]).origin : '';
  } catch {
    origin = '';
  }
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    // Matched without regard to case: Chromium may hand a header on in either.
    const take = (name: string): string | undefined => {
      const key = Object.keys(headers).find(one => one.toLowerCase() === name.toLowerCase());
      const value = key === undefined ? undefined : headers[key];
      if (key !== undefined) {
        delete headers[key];
      }
      return value;
    };
    const cookie = take(PORTAL_HEADERS.cookie);
    const agent = take(PORTAL_HEADERS.agent);
    if (cookie !== undefined) {
      take('Cookie');
      headers['Cookie'] = cookie;
      if (agent !== undefined) {
        take('User-Agent');
        headers['User-Agent'] = agent;
      }
    } else if (origin && details.url.startsWith('https://www.youtube-nocookie.com/')) {
      headers['Referer'] = `${origin}/`;
    }
    callback({ requestHeaders: headers });
  });
}

export function setupContentSecurityPolicy(customScheme: string): void {
  /*
   * The scaffold ships `default-src <scheme>://*`, which forbids the app from
   * connecting anywhere at all -- not to the backend it signs in against, and
   * not to the provider it exists to read. Sign-in failed with "could not reach
   * the server" while the server was answering perfectly well.
   *
   * So the parts that fetch data are widened and the part that matters is not.
   * `script-src` still resolves to default-src, which is this app's own scheme:
   * no code runs here that did not ship in the bundle, whatever any response
   * body happens to contain. What is opened is the ability to *read* from
   * elsewhere, which is the entire purpose of a client for somebody else's
   * catalogue.
   *
   * http: as well as https: because the provider is HTTP-only with no TLS
   * listener. That is the same fact that makes a browser unable to host this
   * app at all, and the reason there is a desktop build.
   */
  const fetchable = `${customScheme}://* http: https:`;

  const policy = [
    electronIsDev
      ? `default-src ${customScheme}://* 'unsafe-inline' devtools://* 'unsafe-eval' data:`
      : `default-src ${customScheme}://* 'unsafe-inline' data:`,
    // The backend, and the provider's API.
    `connect-src ${fetchable} ws: wss:`,
    // Channel logos and film artwork, which come from the provider and from
    // image hosts it points at.
    `img-src ${fetchable} data: blob:`,
    // Anything the in-page player is asked to open, when it is used at all.
    `media-src ${fetchable} data: blob:`,
    // Trailers: YouTube's player, and nothing else, may be framed (D-22).
    `frame-src https://www.youtube-nocookie.com https://www.youtube.com`,
    `font-src ${customScheme}://* https: data:`,
    `style-src ${customScheme}://* 'unsafe-inline' https:`
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // The app's own pages only. Stamped on everything, it also landed on
    // YouTube's player inside the trailer dialog, whose scripts it then
    // refused: a black box (D-22, 18 October).
    if (!details.url.startsWith(`${customScheme}://`)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}
