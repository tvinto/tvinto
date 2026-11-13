import type { CapacitorElectronConfig } from '@capacitor-community/electron';
import { getCapacitorElectronConfig, setupElectronDeepLinking } from '@capacitor-community/electron';
import type { MenuItemConstructorOptions } from 'electron';
import { app, ipcMain, MenuItem } from 'electron';

import unhandled from 'electron-unhandled';

import { setupDeepLinks } from './deepLinks';
import { registerExternalLinks } from './externalLinks';
import { startLocalApi } from './localApi';
import { registerNativePlayer } from './player';
import { desktopRecorder, registerRecorder } from './recorderIpc';
import { registerSubtitleFetch } from './subtitles';
import { ElectronCapacitorApp, setupContentSecurityPolicy, setupReloadWatcher, setupRequestHeaders } from './setup';
import { registerToolCli } from './toolCli';
import { startUpdates } from './updates';
import { join } from 'path';

// Developer mode only for a copy that is not installed. electron-is-dev also
// honours ELECTRON_IS_DEV=1, which would turn DevTools and a looser policy on
// in an installed app from nothing more than its environment.
const electronIsDev = !app.isPackaged;

// A copy run from source keeps its data apart from the installed app.
//
// Both are called Xtream, so both used to live in %APPDATA%\Xtream: the same
// session, the same IndexedDB, the same downloaded guides. Every test run was a
// run against the installed app's own data -- and a test that failed badly, or
// a development copy killed mid-write, landed on the app somebody actually
// watches television with. Guides went missing there more than once while its
// owner took it for a side effect of updating.
//
// First thing, before anything can open storage: Chromium fixes where it keeps
// data the moment the app touches it, and moving userData afterwards splits the
// app across two folders. The price is signing in once in the development copy.
//
// XTREAM_DEV_DATA names a folder of its own instead, for a throwaway copy:
// testing a family takes several accounts signed in at once, against a sync
// service on this machine, and none of that belongs in the development copy
// somebody signed in to by hand.
if (!app.isPackaged) {
  const throwaway = process.env['XTREAM_DEV_DATA']?.trim();
  app.setPath('userData', join(app.getPath('appData'), throwaway ? `Tvinto (test ${throwaway})` : 'Tvinto (development)'));
}

// Graceful handling of unhandled errors.
unhandled();

// Define our menu templates (these are optional)
const trayMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [new MenuItem({ label: 'Quit App', role: 'quit' })];
const appMenuBarMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [
  { role: process.platform === 'darwin' ? 'appMenu' : 'fileMenu' },
  { role: 'viewMenu' },
];

// Get Config options from capacitor.config
const capacitorFileConfig: CapacitorElectronConfig = getCapacitorElectronConfig();

// Initialize our app. You can pass menu templates into the app here.
// const myCapacitorApp = new ElectronCapacitorApp(capacitorFileConfig);
const myCapacitorApp = new ElectronCapacitorApp(capacitorFileConfig, trayMenuTemplate, appMenuBarMenuTemplate);

// tvinto:// links, and one copy at a time: a second start hands its link to
// the first and goes (src/deepLinks.ts).
const isFirstCopy = setupDeepLinks(() => myCapacitorApp.getMainWindow() ?? null);
if (!isFirstCopy) {
  app.quit();
}

// If deeplinking is enabled then we will set it up here.
if (capacitorFileConfig.electron?.deepLinkingEnabled) {
  setupElectronDeepLinking(myCapacitorApp, {
    customProtocol: capacitorFileConfig.electron.deepLinkingCustomProtocol ?? 'mycapacitorapp',
  });
}

// If we are in Dev mode, use the file watcher components.
if (electronIsDev) {
  setupReloadWatcher(myCapacitorApp);
}

// Run Application
(async () => {
  // Wait for electron app to be ready.
  await app.whenReady();
  if (!isFirstCopy) {
    return;
  }
  // Security - Set Content-Security-Policy based on whether or not we are in dev mode.
  setupContentSecurityPolicy(myCapacitorApp.getCustomURLScheme());
  setupRequestHeaders();
  // Playback by mpv rather than by Chromium, which has no HEVC decoder unless
  // Windows supplies one. Registered before the window exists, so the first
  // thing played cannot arrive before there is anything listening.
  registerNativePlayer();
  registerSubtitleFetch();
  // Recording, and bookings made while the app was closed set going again.
  registerRecorder();
  desktopRecorder();
  registerExternalLinks();
  // tvinto, carried in the app for connecting an AI agent (src/toolCli.ts).
  registerToolCli();
  // The country Windows is set to, for the guide suggested (EpgShareService):
  // the page's languages say only which language the app is in, and an
  // English Windows in Croatia gives en-US.
  ipcMain.on('xtream:region', event => {
    event.returnValue = app.getLocaleCountryCode();
  });
  // tvinto with no account: the app answers it on 127.0.0.1 (src/localApi.ts).
  startLocalApi(() => myCapacitorApp.getMainWindow() ?? null);
  // Initialize our app, build windows, and load content.
  await myCapacitorApp.init();
  // Ask whether there is a newer version, now and every few hours after.
  // After the window exists, so nothing about updating can delay the app
  // appearing -- and so a failure has somewhere to be seen.
  startUpdates();
})();

// No web contents opens a window -- the app, a frame in it, anything. The app
// never opens one, and a window it did not open would have its preload.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// Handle when all of our windows are close (platforms have their own expectations).
app.on('window-all-closed', function () {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// When the dock icon is clicked.
app.on('activate', async function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (myCapacitorApp.getMainWindow().isDestroyed()) {
    await myCapacitorApp.init();
  }
});

// Place all ipc or other electron api calls and custom functionality under this line
