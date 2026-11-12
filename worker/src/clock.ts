/**
 * The two times this service deals in, and why one of them lags.
 *
 * The Express backend hands out a cursor from a clock that never repeats
 * itself, because timestamps have millisecond resolution and a change written
 * in the same millisecond as a pull would compare equal to the cursor and be
 * skipped -- not delayed, skipped, because the next pull asks for a later
 * moment still.
 *
 * A Worker cannot have that clock. There is no single process to keep the
 * counter in: requests land in whichever isolate is nearest and warmest, and
 * two of them can hand out the same millisecond without ever knowing about
 * each other.
 *
 * So the cursor lags instead. A pull says "you are up to date as of a second
 * ago", and the next pull re-reads that second. A change is delivered twice
 * rather than never, which is the right way round: applying a change already
 * held is a no-op, because last-write-wins treats an equal timestamp as not
 * newer. The cost is a few rows re-sent; the alternative is a favourite that
 * vanishes with nothing anywhere to say it was lost.
 */

/**
 * How far behind real time a cursor is handed back.
 *
 * A second is far more than the millisecond the race actually needs, and small
 * enough that the overlap is a handful of rows.
 */
export const CURSOR_LAG_MS = 1000;

/** When something was written down here. */
export const now = (): string => new Date().toISOString();

/** What a device should quote on its next pull. */
export const cursorNow = (): string => new Date(Date.now() - CURSOR_LAG_MS).toISOString();
