import { app, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { abnormalPlayerExit, cleanLogTail, cleanReport, isReportAddress, LOG_LINES } from './shared/errorReports';
import { playbackLogTail, setPlaybackLogFolder } from './playbackLog';

/**
 * Error reports from the desktop app's main process: its own errors, native
 * crashes of any of its processes (a minidump, sent at the next start), and
 * tvinto-player or mpv ending abnormally (docs/error-reports.md).
 *
 * The address is the build's own, read from the web app's config.js beside
 * it (scripts/write-config.mjs): none in a fork or a self-build, which then
 * never starts Sentry at all. The switch is the page's (ErrorReportsService):
 * it says over IPC whether reports may go, and the main process keeps that
 * in error-reports.json beside its data.
 *
 * Sentry has to start before the app is ready, so the main process starts it
 * only at a launch after the page has said yes -- not before onboarding has
 * shown the switch, never while it is off. Turned off mid-run, every event is
 * dropped from then on, and the next launch does not start it.
 *
 * Every event goes through cleanReport, the same cleaning as the page's,
 * with the playback log's last lines attached.
 */

type SentryMain = typeof import('@sentry/electron/main');

/** The switch as the page last said; off until it has. */
let on = false;
/** The build's report address, or null. */
let dsn: string | null = null;
/** What the page holds that a report must not carry: in memory only, never written. */
let personal: string[] = [];
/** The titles played this run, which mpv can repeat in a log line: taken out the same way. */
const played: string[] = [];
const PLAYED_KEPT = 30;

const removed = (): string[] => [...personal, ...played];

/** A film's, an episode's or a channel's name, as it starts playing. */
export function rememberPlayed(title: unknown): void {
  if (typeof title === 'string' && title.trim() && !played.includes(title)) {
    played.push(title);
    played.splice(0, Math.max(0, played.length - PLAYED_KEPT));
  }
}
let sentry: SentryMain | null = null;

const file = (): string => join(app.getPath('userData'), 'error-reports.json');

const release = (): string => `tvinto-desktop@${app.getVersion()}`;

function readOn(): boolean {
  try {
    return (JSON.parse(readFileSync(file(), 'utf8')) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
}

function writeOn(value: boolean): void {
  try {
    writeFileSync(file(), JSON.stringify({ on: value }));
  } catch {
    // Said again by the page at the next start.
  }
}

/** The address config.js names, as the page reads it (window.__TVINTO_ERROR_REPORTS__). */
function buildDsn(): string | null {
  try {
    const config = readFileSync(join(app.getAppPath(), 'app', 'config.js'), 'utf8');
    const found = /^window\.__TVINTO_ERROR_REPORTS__ = '([^']+)';$/m.exec(config)?.[1] ?? null;
    return isReportAddress(found) ? found : null;
  } catch {
    return null;
  }
}

const enabled = (): boolean => on && dsn !== null;

/**
 * First thing, before the app is ready: the native crash handler has to be
 * there before anything can crash.
 */
export function startErrorReports(): void {
  // The log a report carries, readable from the first report on; userData is
  // settled by now (src/index.ts).
  setPlaybackLogFolder(app.getPath('userData'));
  dsn = buildDsn();
  on = readOn();
  if (enabled()) {
    start();
  }
  ipcMain.on('tvinto:error-reports', (_event, state: { on?: unknown; personal?: unknown }) => {
    personal = Array.isArray(state?.personal) ? state.personal.filter((value): value is string => typeof value === 'string') : [];
    const next = state?.on === true;
    if (next !== on) {
      on = next;
      writeOn(next);
    }
  });
  ipcMain.handle('tvinto:error-reports-log', () => cleanLogTail(playbackLogTail(), removed()));
  ipcMain.on('tvinto:error-reports-release', event => {
    event.returnValue = release();
  });
}

function start(): void {
  if (sentry || !dsn) {
    return;
  }
  // Loaded here, not at the top: a copy with reports off never loads it.
  const loaded = require('@sentry/electron/main') as SentryMain;
  loaded.init({
    dsn,
    release: release(),
    environment: app.isPackaged ? 'desktop' : 'desktop-development',
    // Errors and crashes only: none of the breadcrumbs, sessions, screenshots,
    // network or tracing integrations the SDK would otherwise add.
    defaultIntegrations: false,
    integrations: [
      loaded.sentryMinidumpIntegration(),
      loaded.electronContextIntegration(),
      loaded.additionalContextIntegration(),
      loaded.onUncaughtExceptionIntegration(),
      loaded.onUnhandledRejectionIntegration(),
      loaded.linkedErrorsIntegration(),
      // A renderer, the GPU process or a utility process that died: as an error, not a breadcrumb.
      loaded.childProcessIntegration({ events: ['abnormal-exit', 'launch-failed', 'integrity-failure', 'oom', 'crashed'], breadcrumbs: false, logs: false }),
      loaded.normalizePathsIntegration()
    ],
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    sendClientReports: false,
    // Sentry 11's sendDefaultPii: no user, no IP address, nothing collected.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    beforeSend: (event, hint) => {
      if (!enabled()) {
        return null;
      }
      // A native crash goes as which process crashed and how, without its
      // minidump: a dump is the process's memory, which can hold the
      // provider's address and password, and nothing can clean it. Emptied in
      // place, since the client sends the attachments of this same hint.
      const dumps = (hint.attachments ?? []).filter(attachment => attachment.attachmentType === 'event.minidump').length;
      hint.attachments?.splice(0);
      const log = cleanLogTail(playbackLogTail(), removed(), LOG_LINES);
      const tags = dumps ? { ...event.tags, native_crash: 'yes', minidump: 'not sent' } : event.tags;
      return cleanReport({ ...event, tags, extra: { ...event.extra, log } }, removed());
    }
  });
  sentry = loaded;
  console.info('[error-reports] on');
}

/** tvinto-player or mpv ended: an error when it was not the viewer, a channel key or the provider. */
export function reportPlayerExit(player: 'tvinto-player' | 'mpv', code: number | null, signal: string | null): void {
  if (!sentry || !enabled() || !abnormalPlayerExit(code, signal)) {
    return;
  }
  const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
  sentry.captureException(new Error(`${player} ${how}`), {
    tags: { player, exit_code: code === null ? 'none' : String(code), ...(signal ? { signal } : {}) }
  });
}
