/**
 * Which channel the remote's channel keys land on.
 *
 * The players close and say which way was pressed (ChannelKeys.java, and mpv's
 * exit codes on the desktop); this decides what that means in the list the
 * viewer was watching from. Pure, so the edges can be tested: the ends of the
 * list, a channel no longer in it, and "last" with nothing to go back to.
 */

export type ChannelStep = 'next' | 'previous' | 'last';

export const isChannelStep = (value: unknown): value is ChannelStep =>
  value === 'next' || value === 'previous' || value === 'last';

/**
 * The id to play after `current`, or null for nowhere to go.
 *
 * Next and previous wrap round the ends, as a television's channel keys do:
 * holding Channel Up through a category comes back to its first channel rather
 * than stopping dead. Last is the channel watched before this one, whether or
 * not it is in the list -- it was chosen from somewhere, and that is where it
 * lives.
 */
export const channelAfter = (
  list: readonly string[],
  current: string,
  step: ChannelStep,
  previous: string | null
): string | null => {
  if (step === 'last') {
    return previous && previous !== current ? previous : null;
  }

  if (!list.length) {
    return null;
  }

  const at = list.indexOf(current);
  if (at < 0) {
    // Gone from the list since it was opened -- a filter, a re-sort. Start
    // from whichever end the key points at rather than doing nothing.
    return step === 'next' ? list[0] : list[list.length - 1];
  }

  const next = (at + (step === 'next' ? 1 : -1) + list.length) % list.length;
  return list[next] === current ? null : list[next];
};
