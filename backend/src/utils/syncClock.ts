/**
 * A clock that never repeats itself.
 *
 * Sync marks every change with a time and asks for "everything after T". With
 * an ordinary clock that is not safe: timestamps have millisecond resolution,
 * these operations take far less than a millisecond, and a change written in
 * the same millisecond as a pull compares equal to the cursor and is skipped.
 * Not delayed -- skipped, permanently, because the next pull asks for a later
 * moment still. A favourite would simply never reach the other device, with
 * nothing anywhere to indicate it had been lost.
 *
 * So both the reads and the writes take their time from here, and every call
 * returns a value strictly greater than the last. Under load the clock runs at
 * most a millisecond ahead per change, and real time catches up during any
 * pause.
 *
 * These stay valid ISO timestamps and stay honest to within a few milliseconds,
 * which matters because they are also what "watched 5 minutes ago" is
 * calculated from.
 */

let lastIssued = 0;

/** The current time, guaranteed later than every value already handed out. */
export function syncNow(): string {
  const now = Date.now();
  lastIssued = now > lastIssued ? now : lastIssued + 1;
  return new Date(lastIssued).toISOString();
}

/**
 * Brings the clock up to a time observed elsewhere.
 *
 * Called with the newest timestamp already in the database at startup, so a
 * restart cannot begin issuing times that have already been used -- which
 * would let a new change sort before an old one and be missed by a device
 * whose cursor sits between them.
 */
export function observeTime(timestamp: string | null | undefined): void {
  if (!timestamp) {
    return;
  }
  const parsed = Date.parse(timestamp);
  if (Number.isFinite(parsed) && parsed > lastIssued) {
    lastIssued = parsed;
  }
}

/** Test seam: forgets what has been issued. */
export function resetSyncClock(): void {
  lastIssued = 0;
}
