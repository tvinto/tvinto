import { fromAppPage } from './appPage';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { autoUpdater } from 'electron-updater';

import { IDLE_MINUTES, decideInstall } from './installWhen';
import { isPlaying } from './player';

/**
 * Keeping the desktop app up to date without anybody fetching an installer.
 *
 * The app asks a URL for `latest.yml`, compares the version in it with its
 * own, downloads the installer if it is newer, and runs it -- when the app is
 * closed, when somebody asks, or when nobody is using the machine. Fetching and
 * installing are `electron-updater`; what is here is when to ask, when to
 * install, and writing down what happened.
 *
 * Where it asks is not in this file. It is `publish` in
 * `electron-builder.config.js`, which packaging turns into an `app-update.yml`
 * inside the build -- so an installed copy carries its own answer and cannot be
 * pointed somewhere else by anything it downloads.
 *
 * ## Why the logging
 *
 * `checkForUpdatesAndNotify()` was already being called before any of this
 * existed and had never once updated anything, because an app running from
 * source is not packaged and the updater declines with a single line on
 * stdout that nobody was reading. An update path that fails silently is worse
 * than none: it is a promise that repairs will arrive, kept by nothing.
 *
 * So every attempt is written to `updates.log` beside the app's own data,
 * where it survives the window closing and can be read after the fact.
 */

/** How often a copy that stays open goes back and asks again. */
const EVERY = 6 * 60 * 60 * 1000;

/** How often a waiting update looks for a moment to install itself. */
const LOOK_FOR_A_MOMENT_EVERY = 5 * 60 * 1000;

/**
 * The idle time before installing, in minutes.
 *
 * Overridable so that the installed app can be watched doing it without
 * leaving the machine alone for an hour; nothing sets it but a person
 * launching the app from a terminal.
 */
const idleMinutes = (): number => {
  const asked = Number(process.env.XTREAM_UPDATE_IDLE_MINUTES);
  return Number.isFinite(asked) && asked >= 0 ? asked : IDLE_MINUTES;
};

/** The version downloaded and waiting to install, if any. */
let ready: string | null = null;

/** What the page last said it was in the middle of. */
let pageBusy: string | null = null;

/** The last reason for not installing, so the log says each one once. */
let lastReason: string | null = null;

let logFile: string | null = null;

const write = (level: string, message: string): void => {
  const line = `${new Date().toISOString()} ${level} ${message}\n`;

  // Still worth having on stdout: running from source is where this is read
  // most often, and that is exactly when there is no log file worth opening.
  console.info(`[updates] ${message}`);

  try {
    logFile ??= join(app.getPath('userData'), 'updates.log');
    appendFileSync(logFile, line);
  } catch {
    // A log that cannot be written must not be able to stop an update. This is
    // the record of the attempt, not the attempt.
  }
};

const asText = (value: unknown): string =>
  value instanceof Error ? (value.stack ?? value.message) : String(value);

const logger = {
  info: (message: unknown) => write('info', asText(message)),
  warn: (message: unknown) => write('warn', asText(message)),
  error: (message: unknown) => write('error', asText(message)),
  debug: () => undefined
};

/**
 * Ask once.
 *
 * Never throws. A machine that is offline, a bucket that is empty and a
 * manifest that is malformed are all the same thing from here -- no update
 * today -- and none of them is a reason for the app not to run.
 */
export const checkForUpdates = async (): Promise<void> => {
  try {
    await autoUpdater.checkForUpdatesAndNotify();
  } catch {
    // Swallowed rather than logged, because it has already been logged: a
    // failed check reaches `logger.error` on its way out, and rejects as well.
    // Writing it here too put the same stack in the file three times over,
    // which is how this comment came to exist.
  }
};

/**
 * Start checking, and keep checking.
 *
 * The repeat is not ceremony. This is the app on a machine wired to a
 * television: it is opened, and then it stays open for days. Checking only at
 * startup would mean a fix reaching a phone the same afternoon and a desktop
 * the next time somebody happened to close it.
 */
export const startUpdates = (): void => {
  autoUpdater.logger = logger;

  // Answered whether or not this copy can update, so the page never has to
  // tell a copy run from source apart: it is simply never told one is ready.
  ipcMain.handle('xtream:update-ready', () => ready);
  ipcMain.handle('xtream:update-install', event => (fromAppPage(event) ? install('asked') : undefined));
  ipcMain.on('xtream:page-busy', (_event, reason: unknown) => {
    pageBusy = typeof reason === 'string' && reason ? reason : null;
  });

  if (!app.isPackaged) {
    // The line the scaffold used to print, said once and said plainly. Running
    // from source *is* the newest version by definition; there is nothing here
    // to update and nothing wrong.
    write('info', 'Running from source, so there is nothing to update.');
    return;
  }

  // Which copy wrote what follows: after an update the app is started again
  // by the installer, and the lines of two runs a few seconds apart are
  // otherwise indistinguishable.
  write('info', `Started ${app.getVersion()} (process ${process.pid}).`);

  autoUpdater.on('checking-for-update', () => write('info', 'Asking whether there is a newer one.'));
  autoUpdater.on('update-available', info => write('info', `Found ${info.version}, downloading.`));
  autoUpdater.on('update-not-available', () => write('info', `Nothing newer than ${app.getVersion()}.`));
  autoUpdater.on('update-downloaded', info => {
    // Not installed now: replacing the app underneath somebody watching a film
    // is not an improvement. It installs when the app is closed (on by
    // default, `autoInstallOnAppQuit`), when somebody presses Restart on the
    // bar the page shows, or by itself once nobody is using the machine.
    ready = info.version;
    lastReason = null;
    write('info', `Downloaded ${info.version}. Waiting for a restart, a close, or an idle hour.`);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('xtream:update-ready', info.version);
    }
  });
  // No handler for 'error'. The logger above already receives it, in more
  // detail than a second line of ours would carry.

  void checkForUpdates();

  const timer = setInterval(() => void checkForUpdates(), EVERY);
  // Or quitting waits for it.
  timer.unref?.();

  const looking = setInterval(installIfIdle, LOOK_FOR_A_MOMENT_EVERY);
  looking.unref?.();
};

/**
 * Installs a waiting update if nobody would notice.
 *
 * The reason this exists: installing only on close meant never, on a PC that
 * is never closed. See `installWhen.ts` for the rule.
 */
const installIfIdle = (): void => {
  const minutes = idleMinutes();
  const decision = decideInstall(
    { ready, playing: isPlaying(), pageBusy, idleSeconds: powerMonitor.getSystemIdleTime() },
    minutes
  );

  if (decision.install) {
    install(`nobody has used the machine for ${minutes} minutes`);
    return;
  }

  if (ready && decision.reason !== lastReason) {
    lastReason = decision.reason;
    write('info', `Not installing ${ready} yet: ${decision.reason}.`);
  }
};

/**
 * Closes the app, installs, and opens it again.
 *
 * Silent, because the installer's own pages would be waiting for a click on a
 * machine nobody is at; and run afterwards, because a television that went
 * quiet for an update should come back to the app rather than the desktop.
 * The app closes the ordinary way first, so storage is written out as on any
 * other close.
 */
const install = (why: string): boolean => {
  if (!ready) {
    return false;
  }

  write('info', `Installing ${ready} now: ${why}.`);
  autoUpdater.quitAndInstall(true, true);
  return true;
};
