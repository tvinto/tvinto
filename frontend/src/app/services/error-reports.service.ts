import { ErrorHandler, Injectable, computed, effect, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { cleanLogTail, cleanReport, isReportAddress, mayReport } from '@shared/errorReports';
import { recordAddress } from '@shared/providers/providerRecord';
import { SETTING_KEYS } from '@shared/types';
import { AccountService } from './account.service';
import { API_URL } from './api-url';
import { ProvidersService } from './providers.service';
import { SettingsService } from './settings.service';
import { playedTitles } from '../utils/played-titles';

/** Set on this device once the switch has been on screen: onboarding, or the notice (ErrorReportsNoticeService). */
const SHOWN_KEY = 'tvinto_error_reports_shown';

/** Errors from before Sentry has loaded, kept for it: a few, the first ones. */
const EARLY_MAX = 10;

/** What the desktop app's preload offers (frontend/electron/src/preload.ts). */
interface DesktopReports {
  /** `tvinto-desktop@1.0.127`: the desktop app's version, which the main process reports under too. */
  release: string;
  /** Hands the main process the switch and the values to take out of its reports. Its address is the build's, as here. */
  set(state: { on: boolean; personal: string[] }): void;
  /** The playback log's last lines, cleaned by the main process. */
  logTail(): Promise<string[]>;
}

const desktop = (): DesktopReports | null =>
  typeof window === 'undefined' ? null : ((window as { xtreamDesktop?: { errorReports?: DesktopReports } }).xtreamDesktop?.errorReports ?? null);

type SentryModule = typeof import('./error-reports.sentry');

/**
 * Error reports from the web app, wherever it runs: the desktop's window, the
 * Android WebView, a browser (docs/error-reports.md). JavaScript errors only.
 *
 * Sentry is loaded only once reporting is on -- a chunk of its own, so a
 * build without an address, or with the switch off, never downloads it.
 * Every event goes through cleanReport (shared/errorReports.ts) before it is
 * sent, and is dropped there if the switch went off in the meantime.
 */
@Injectable({ providedIn: 'root' })
export class ErrorReportsService {
  private readonly settings = inject(SettingsService);
  private readonly providers = inject(ProvidersService);
  private readonly accounts = inject(AccountService);
  private readonly syncServer = inject(API_URL);

  /** The build's address: none in a fork or a self-build. */
  readonly dsn: string | null = (() => {
    const dsn = typeof window === 'undefined' ? null : (window as { __TVINTO_ERROR_REPORTS__?: unknown }).__TVINTO_ERROR_REPORTS__;
    return typeof dsn === 'string' && isReportAddress(dsn) ? dsn.trim() : null;
  })();

  /** Whether this build can send reports at all: the switch is shown only where it can. */
  readonly available = this.dsn !== null;

  readonly shown = signal(this.readShown());

  /** The account's switch, on unless turned off. */
  readonly on = computed(() => this.settings.get(SETTING_KEYS.errorReports) !== 'off');

  readonly enabled = computed(() => mayReport({ dsn: this.dsn, setting: this.settings.get(SETTING_KEYS.errorReports), shown: this.shown() }));

  /** What the app holds that a report must never carry; with what was played, read at the time. */
  private personal(): string[] {
    return [...this.held(), ...playedTitles()];
  }

  private readonly held = computed(() => {
    const values: string[] = [];
    for (const record of this.providers.all()) {
      values.push(recordAddress(record), record.label);
      if (record.kind === 'xtream') {
        values.push(record.username, record.password);
      } else if (record.kind === 'stalker') {
        values.push(record.mac, record.username ?? '', record.password ?? '');
      }
      if (record.sharedBy) {
        values.push(record.sharedBy);
      }
    }
    const account = this.accounts.account();
    if (account) {
      values.push(account.username);
    }
    values.push(this.syncServer());
    return values.filter(value => typeof value === 'string' && value.trim().length > 0);
  });

  private sentry: SentryModule | null = null;
  private loading = false;
  private readonly early: unknown[] = [];

  constructor() {
    effect(() => {
      const on = this.enabled();
      desktop()?.set({ on, personal: this.held() });
      if (on) {
        void this.load();
      }
    });
  }

  /** The switch has been on screen on this device; reports may go from now on. */
  markShown(): void {
    this.shown.set(true);
    try {
      localStorage.setItem(SHOWN_KEY, '1');
    } catch {
      // Asked again next launch, and nothing sent until then.
    }
  }

  setOn(on: boolean): void {
    this.settings.set(SETTING_KEYS.errorReports, on ? 'on' : 'off');
  }

  /**
   * Once, on a device that will not see the walk-through -- one signed in,
   * one set up before error reports existed: a notice saying so, with the way
   * to turn them off. Nothing is sent before it, or before the walk-through.
   */
  noticeIfNeeded(url: string, notice: (open: () => void) => void, open: () => void): void {
    if (!this.available || this.shown() || !this.accounts.hasAccess()) {
      return;
    }
    // Not over signing in, the walk-through (which shows the switch itself) or Who's watching.
    if (['/', '/sign-in', '/welcome', '/profiles'].includes(url.split(/[?#]/)[0] ?? '')) {
      return;
    }
    notice(open);
    this.markShown();
  }

  /** An error the app caught at the top (ReportingErrorHandler). */
  capture(error: unknown): void {
    if (!this.enabled()) {
      return;
    }
    if (this.sentry) {
      this.sentry.captureException(error);
    } else if (this.early.length < EARLY_MAX) {
      this.early.push(error);
    }
  }

  private readShown(): boolean {
    try {
      return localStorage.getItem(SHOWN_KEY) === '1';
    } catch {
      // Unreadable storage: not shown, so nothing is sent.
      return false;
    }
  }

  private async load(): Promise<void> {
    if (this.sentry || this.loading || !this.dsn) {
      return;
    }
    this.loading = true;
    try {
      const sentry = await import('./error-reports.sentry');
      const platform = Capacitor.getPlatform();
      const version = (window as { __TVINTO_VERSION__?: unknown }).__TVINTO_VERSION__;
      sentry.init({
        dsn: this.dsn,
        release: desktop()?.release ?? `tvinto-web@${typeof version === 'string' ? version : 'unknown'}`,
        environment: platform,
        // Errors only: no breadcrumbs of what was pressed, no sessions, no
        // tracing, no replay -- each of those is a default integration.
        defaultIntegrations: false,
        integrations: [
          sentry.globalHandlersIntegration(),
          sentry.browserApiErrorsIntegration(),
          sentry.linkedErrorsIntegration(),
          sentry.dedupeIntegration(),
          sentry.httpContextIntegration()
        ],
        maxBreadcrumbs: 0,
        beforeBreadcrumb: () => null,
        sendClientReports: false,
        // Sentry 11's sendDefaultPii: nothing about the person, and no IP address.
        dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
        beforeSend: async event => {
          if (!this.enabled()) {
            return null;
          }
          const personal = this.personal();
          const log = (await desktop()?.logTail().catch(() => [])) ?? [];
          const withContext = {
            ...event,
            tags: { ...event.tags, platform },
            // Which system and device (an Android television names its model here); no other header.
            request: { ...event.request, headers: { 'User-Agent': navigator.userAgent } },
            contexts: { ...event.contexts, device: { ...event.contexts?.['device'], screen_resolution: `${screen.width}x${screen.height}` } },
            extra: { ...event.extra, ...(log.length ? { log: cleanLogTail(log.join('\n'), personal) } : {}) }
          };
          return cleanReport(withContext, personal);
        }
      });
      this.sentry = sentry;
      for (const error of this.early.splice(0)) {
        sentry.captureException(error);
      }
    } catch (error) {
      console.warn('Error reports could not start', String(error).slice(0, 200));
    } finally {
      this.loading = false;
    }
  }
}

/**
 * Angular's own handler -- the console -- and a report. Errors from outside
 * Angular (a script, a promise nobody waited on) reach Sentry through its
 * global handlers instead.
 */
@Injectable()
export class ReportingErrorHandler extends ErrorHandler {
  private readonly reports = inject(ErrorReportsService);

  override handleError(error: unknown): void {
    super.handleError(error);
    this.reports.capture(error);
  }
}
