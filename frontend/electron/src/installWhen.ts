/**
 * When a downloaded update may be installed without anybody asking for it.
 *
 * An update used to install only when the app was closed, and on a PC wired to
 * a television the app is not closed: the installed copy sat on 1.0.10 from
 * 9 to 13 September with newer versions downloaded and waiting. So the app now
 * also restarts into an update by itself -- but only when that cannot land on
 * a person. Nothing playing, nothing half-loaded, and nobody having touched
 * the machine for a good while.
 *
 * Kept apart from `updates.ts`, and free of Electron, so the rule can be tested
 * without an app to run it in.
 */

/** How long the machine must have gone untouched. */
export const IDLE_MINUTES = 60;

export interface InstallState {
  /** The version downloaded and waiting, or null when there is none. */
  ready: string | null;

  /** Whether mpv is running. It has its own window, so the page cannot say. */
  playing: boolean;

  /**
   * What the page says it is in the middle of, or null for nothing.
   *
   * Null also when the page has said nothing at all -- a page that never
   * started must not be able to keep the fix for it from installing.
   */
  pageBusy: string | null;

  /** Seconds since the last keyboard, mouse or remote input anywhere on the machine. */
  idleSeconds: number;
}

export type InstallDecision =
  | { install: true; reason: 'idle' }
  | { install: false; reason: 'nothing-ready' | 'playing' | 'in-use' | string };

export const decideInstall = (state: InstallState, idleMinutes = IDLE_MINUTES): InstallDecision => {
  if (!state.ready) {
    return { install: false, reason: 'nothing-ready' };
  }

  // Before idleness, and not instead of it: a film is watched with nobody
  // touching anything, which is exactly what idle looks like.
  if (state.playing) {
    return { install: false, reason: 'playing' };
  }

  if (state.pageBusy) {
    return { install: false, reason: state.pageBusy };
  }

  if (!(state.idleSeconds >= idleMinutes * 60)) {
    return { install: false, reason: 'in-use' };
  }

  return { install: true, reason: 'idle' };
};
