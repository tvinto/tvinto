/**
 * Changing channel without leaving the player: what to do next.
 *
 * The player (PlayerActivity) stays open. On a channel key it stops the stream
 * it has -- the provider allows one connection -- shows "Changing to" (PL-TV-2)
 * and asks; this decides the answer, and the service carries it out by
 * handing the player the next channel's address. Pure, so the awkward cases can
 * be tested rather than found on a television: pressing again while a switch
 * is under way, Back part way through, and the provider turning a stream away.
 */

import { ChannelStep, channelAfter } from './channel-step.utils';

/** How long after closing a stream the next is asked for. The provider goes on counting one for a moment. */
export const SWITCH_PAUSE_MS = 1500;

/** The longer wait before the one retry, after the provider refused. */
export const SWITCH_RETRY_PAUSE_MS = 3000;

export interface SwitchState {
  /** The channels the keys step through, in order. */
  readonly list: readonly string[];
  /** The channel on screen, or being switched to. */
  readonly current: string;
  /** Whether `current` has shown a picture yet. */
  readonly started: boolean;
  /** The last channel that actually played before `current`, for the last-channel key. */
  readonly previous: string | null;
  /**
   * Where a run of switches began: the channel that was playing when the first
   * key was pressed. Back returns here; null once the new channel has started.
   */
  readonly origin: string | null;
  /** 1 for the first attempt at `current`, 2 for the retry. */
  readonly attempt: 1 | 2;
  /** Set once both attempts have failed and the player is showing that. */
  readonly gaveUp: boolean;
}

export type SwitchEvent =
  | { kind: 'requested'; step: ChannelStep | 'cancel' }
  /** A channel chosen by number (PL-TV-3) or in the mini guide (PL-TV-4). */
  | { kind: 'jump'; to: string }
  | { kind: 'started' }
  | { kind: 'failed'; errorCode: string };

export type SwitchAction =
  /** Ask the player for this channel after `waitMs`. */
  | { kind: 'switch'; to: string; waitMs: number; attempt: 1 | 2 }
  /** Both attempts failed: say so, and name where Back goes. */
  | { kind: 'giveUp'; backTo: string | null }
  /** Leave the player, reporting the failure -- which the close-and-reopen path knows how to handle. */
  | { kind: 'close' }
  | { kind: 'none' };

export const startSwitching = (list: readonly string[], current: string, previous: string | null): SwitchState => ({
  list,
  current,
  started: false,
  previous,
  origin: null,
  attempt: 1,
  gaveUp: false
});

/** A failure the platform player cannot get past, where VLC might. Same test as NativePlayerService's. */
export const isDecodingFailure = (errorCode: string): boolean => /decode|DECODING|DECODER/i.test(errorCode);

export const nextSwitch = (state: SwitchState, event: SwitchEvent): { state: SwitchState; action: SwitchAction } => {
  switch (event.kind) {
    case 'started':
      return { state: { ...state, started: true, origin: null, attempt: 1, gaveUp: false }, action: { kind: 'none' } };

    case 'failed': {
      if (state.started || isDecodingFailure(event.errorCode)) {
        // A stream that played and then died, or one this device cannot
        // decode, is not the provider being slow to let go: leave the player
        // and let the ordinary path report it, or retry it with VLC.
        return { state, action: { kind: 'close' } };
      }
      if (state.attempt === 1) {
        return {
          state: { ...state, attempt: 2 },
          action: { kind: 'switch', to: state.current, waitMs: SWITCH_RETRY_PAUSE_MS, attempt: 2 }
        };
      }
      // No third attempt: more requests are what gets an address blocked.
      return { state: { ...state, gaveUp: true }, action: { kind: 'giveUp', backTo: state.origin } };
    }

    case 'jump':
    case 'requested': {
      if (event.kind === 'requested' && event.step === 'cancel') {
        const back = state.origin;
        if (!back || back === state.current) {
          // After giving up with nowhere to return to, Back leaves the player.
          // Otherwise there is nothing to cancel -- which is also what a
          // second Back for the same press looks like, and must not close.
          return { state, action: state.gaveUp ? { kind: 'close' } : { kind: 'none' } };
        }
        return {
          state: { ...state, current: back, started: false, origin: null, attempt: 1, gaveUp: false },
          action: { kind: 'switch', to: back, waitMs: SWITCH_PAUSE_MS, attempt: 1 }
        };
      }

      const target =
        event.kind === 'jump'
          ? state.list.includes(event.to)
            ? event.to
            : null
          : channelAfter(state.list, state.current, event.step as ChannelStep, state.previous);
      if (!target || target === state.current) {
        return { state, action: { kind: 'none' } };
      }

      // Pressing again while a switch is under way re-targets it. The channel
      // being left only counts as watched -- for "last" and for Back -- if it
      // showed a picture; one skipped past on the way is not somewhere to return.
      return {
        state: {
          ...state,
          current: target,
          started: false,
          previous: state.started ? state.current : state.previous,
          origin: state.origin ?? state.current,
          attempt: 1,
          gaveUp: false
        },
        action: { kind: 'switch', to: target, waitMs: SWITCH_PAUSE_MS, attempt: 1 }
      };
    }
  }
};
