import { locale } from './i18n';

/** Wasted space worth a banner: by then the cleans in standby are not keeping up. */
export const BANNER_FREE_BYTES = 250 * 1024 * 1024;

/** How long "Not now" keeps the banner away. */
export const BANNER_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** Below this there is nothing worth pressing "Free up space" for. */
export const NOTHING_TO_FREE_BYTES = 1024 * 1024;

/** "640 MB", "1.2 GB" ("1,2 GB" in Croatian). */
export function size(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1000) {
    return `${Math.max(0, Math.round(megabytes))} MB`;
  }
  return `${(megabytes / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 })} GB`;
}

/** Time on the busy screen: "42 s", then "7:15". */
export function elapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} s`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Whether the banner asks to free space: enough to free, and not put off with "Not now". */
export function bannerDue(freeBytes: number, snoozedUntil: number, now: number): boolean {
  return freeBytes >= BANNER_FREE_BYTES && now >= snoozedUntil;
}

/** What the clean job last wrote (DatabaseSpace.java). */
export interface LastClean {
  state?: 'running' | 'done' | 'failed' | 'stopped';
  asked?: boolean;
  /** "full": a device's first clean, a whole rewrite; "steps": a megabyte at a time. */
  mode?: 'full' | 'steps';
  startedAt?: number;
  finishedAt?: number;
  beforeBytes?: number;
  afterBytes?: number;
  reason?: string;
}

/**
 * Whether the job's last word is the answer to a clean asked for at
 * `requestedAt` -- not one from before it -- and is final.
 */
export function finishedSince(last: LastClean, requestedAt: number): boolean {
  return (last.startedAt ?? 0) >= requestedAt - 1000 && !!last.state && last.state !== 'running';
}

/** What a finished clean gave back. */
export function freed(last: LastClean): number {
  return Math.max(0, (last.beforeBytes ?? 0) - (last.afterBytes ?? 0));
}
