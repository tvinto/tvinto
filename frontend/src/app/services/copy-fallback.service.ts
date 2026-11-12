import { Injectable } from '@angular/core';
import {
  MOST_COPIES_TRIED,
  NamedStream,
  copiesWorthTrying,
  copyFailure,
  nextCopy,
  versionKey
} from '../utils/other-versions.utils';

/** A film or an episode that failed within this much of where it started is a copy worth swapping. */
export const COPY_FAILS_WITHIN_S = 60;

/** The pause between a copy that failed and asking the provider for the next. */
export const COPY_SWITCH_PAUSE_MS = 1500;

/** A copy that failed is put last for this long, on this device. */
const FAILED_FOR_MS = 24 * 60 * 60 * 1000;

const FAILED_KEY = 'tvinto_failed_copies';

/** What the player said when it closed, as far as choosing another copy goes. */
export interface CopyOutcome {
  errorCode: string | null;
  positionSeconds: number;
}

/**
 * The copies of one film or show tried since the person pressed Play, kept
 * across pages: another copy of a show is another show's page.
 *
 * Forgotten once a copy plays, or when it is a different film or show.
 */
@Injectable({ providedIn: 'root' })
export class CopyFallbackService {
  private run: { title: string; tried: Set<string>; left: number } | null = null;

  /**
   * After `failed` closed with `outcome`, the copy among `candidates` to try
   * next, or null when there is none worth trying. Counts the try: call it
   * only when the copy it returns will be opened.
   */
  next<T extends NamedStream>(failed: NamedStream, candidates: T[], outcome: CopyOutcome, startAt: number): T | null {
    if (!outcome.errorCode || outcome.positionSeconds - startAt > COPY_FAILS_WITHIN_S) {
      this.run = null;
      return null;
    }
    const title = versionKey(failed.name);
    if (this.run?.title !== title) {
      this.run = { title, tried: new Set(), left: MOST_COPIES_TRIED };
    }
    const run = this.run;
    run.tried.add(String(failed.stream_id));
    run.left = Math.min(run.left, copiesWorthTrying(outcome.errorCode));
    const failure = copyFailure(outcome.errorCode);
    if (failure === 'copy' || failure === 'decode') {
      // The copy's own fault, or this device's: either way, not the first offered tomorrow.
      this.remember(failed);
    }
    const next = run.left > 0 ? nextCopy(failed, candidates, run.tried, copyFailure(outcome.errorCode)) : null;
    if (next) {
      run.left -= 1;
      run.tried.add(String(next.stream_id));
    }
    return next;
  }

  /** A copy that turned out not to be worth opening after all (a show without the episode): tried, and passed over. */
  passOver(copy: NamedStream): void {
    if (this.run) {
      this.run.tried.add(String(copy.stream_id));
      this.run.left += 1;
    }
  }

  /** Whether this copy has already been tried in the current run. */
  tried(copy: NamedStream): boolean {
    return !!this.run?.tried.has(String(copy.stream_id));
  }

  /** A copy played: the next failure starts afresh, and it is no longer one that failed. */
  played(copy?: NamedStream): void {
    this.run = null;
    if (copy && this.failedRecently(copy)) {
      const failed = readFailed();
      delete failed[String(copy.stream_id)];
      writeFailed(failed);
    }
  }

  /** Whether this copy failed on this device in the last day. Not synced: it may play on another. */
  failedRecently(copy: NamedStream): boolean {
    const at = readFailed()[String(copy.stream_id)];
    return at !== undefined && Date.now() - at < FAILED_FOR_MS;
  }

  /** The copies in the same order, the ones that failed lately moved to the end. */
  inPlayOrder<T extends { stream: NamedStream }>(copies: readonly T[]): T[] {
    return [...copies.filter(copy => !this.failedRecently(copy.stream)), ...copies.filter(copy => this.failedRecently(copy.stream))];
  }

  private remember(copy: NamedStream): void {
    const now = Date.now();
    const kept = Object.fromEntries(Object.entries(readFailed()).filter(([, at]) => now - at < FAILED_FOR_MS));
    kept[String(copy.stream_id)] = now;
    writeFailed(kept);
  }
}

function readFailed(): Record<string, number> {
  try {
    const kept = JSON.parse(localStorage.getItem(FAILED_KEY) ?? '{}') as Record<string, number>;
    return kept && typeof kept === 'object' ? kept : {};
  } catch {
    return {};
  }
}

function writeFailed(failed: Record<string, number>): void {
  try {
    localStorage.setItem(FAILED_KEY, JSON.stringify(failed));
  } catch {
    // Storage unavailable: the copy is simply offered as before.
  }
}
