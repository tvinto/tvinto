/**
 * Typing a channel number inside the player (design boards PL-TV-3, PL-TV-3b).
 *
 * The player shows the best match under the digits as they are typed, so a
 * viewer who half-remembers a number sees it resolve before committing; OK
 * goes to that match. The player does this itself from the directory it was
 * sent (ChannelDirectory.java mirrors `bestNumberMatch`), because a round trip
 * per digit is a lag at the one moment a viewer is watching the screen for an
 * answer. The rule lives here, where it is tested.
 */

export interface NumberedChannel {
  itemId: string;
  number: string;
}

const numeric = (value: string): number => {
  const parsed = value.trim() === '' ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

/**
 * The channel a typed number means: the one with exactly that number, or else
 * the lowest-numbered one whose number starts with it. Null for none.
 */
export const bestNumberMatch = <T extends NumberedChannel>(channels: readonly T[], typed: string): T | null => {
  const digits = typed.replace(/\D/g, '');
  if (!digits) {
    return null;
  }
  const exact = channels.find(channel => channel.number === digits || (channel.number !== '' && numeric(channel.number) === Number(digits)));
  if (exact) {
    return exact;
  }
  return (
    channels
      .filter(channel => channel.number.startsWith(digits))
      .sort((a, b) => numeric(a.number) - numeric(b.number))[0] ?? null
  );
};

/** "101 – 486": the numbers in force, which is the one fact that stops the next wrong guess. Empty for none. */
export const numberRange = (channels: readonly NumberedChannel[]): string => {
  const numbers = channels.map(channel => numeric(channel.number)).filter(Number.isFinite);
  if (!numbers.length) {
    return '';
  }
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  return low === high ? String(low) : `${low} – ${high}`;
};
