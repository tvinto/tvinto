/**
 * Ordering helpers shared by the two places a list can be arranged.
 */

/** An entry paired with its position in the unfiltered list. */
export interface PositionedEntry {
  index: number;
}

/**
 * Moves the row at `index` one step in the direction the user sees.
 *
 * `visible` is the filtered view, so the step lands on the next row the user
 * can actually see rather than the next one in the full list, which under a
 * filter is usually hidden and would make the arrow look broken.
 *
 * The row is taken out and reinserted at the neighbour's position. Swapping the
 * two instead would send the neighbour back to where this row came from, and
 * with a filter that is past every hidden row in between -- one arrow press
 * could move an unrelated entry hundreds of places, out of sight. Reinserting
 * shifts the rows in between by one and relocates only the row that was asked
 * to move, which is what dragging does too.
 *
 * Returns a new array; the input is left alone.
 */
export function moveWithinFilteredList<T>(
  items: T[],
  visible: PositionedEntry[],
  index: number,
  delta: number
): T[] {
  const position = visible.findIndex(entry => entry.index === index);
  const neighbour = visible[position + delta];

  if (position === -1 || !neighbour) {
    return items;
  }

  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(neighbour.index, 0, moved);
  return next;
}

/**
 * Reads a position the user typed into the index it refers to.
 *
 * Positions are shown to the user starting at 1, so the returned index is one
 * lower. Out-of-range numbers are clamped rather than refused: typing 1 to mean
 * "put this at the top" and 999 to mean "put it at the bottom" are both clear
 * enough to act on. Anything that is not a whole number returns null, which
 * callers treat as "leave the list alone".
 */
export function toTargetIndex(raw: string, listLength: number): number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || listLength === 0) {
    return null;
  }

  const position = Number(trimmed);
  if (!Number.isInteger(position)) {
    return null;
  }

  return Math.min(Math.max(position, 1), listLength) - 1;
}

/**
 * Moves the row at `from` to sit at `to`, as a drag does.
 *
 * Returns a new array; the input is left alone.
 */
export function moveToIndex<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }

  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
