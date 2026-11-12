import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';

/** The kinds of place this app runs. */
export type AppPlatform = 'browser' | 'android' | 'electron';

/**
 * What this build can do, asked as capabilities rather than as an identity.
 *
 * Every switch in the app used to ask `Capacitor.isNativePlatform()`, which was
 * exactly right while there were two platforms and the answer to every question
 * was the same. A desktop build makes them come apart: Electron can reach the
 * provider directly and has a bundled player, like Android; but it is a
 * keyboard-and-mouse machine that is nobody's shared computer, so it wants the
 * durable session Android has and none of the D-pad handling.
 *
 * Asking "can you do this" rather than "what are you" keeps those decisions
 * where the reason for them is, instead of spreading a platform name through
 * code that only cares about one consequence of it.
 */
@Injectable({ providedIn: 'root' })
export class PlatformService {
  readonly platform: AppPlatform = detect();

  /**
   * Whether the provider can be reached without a backend in between.
   *
   * A browser cannot: the provider is HTTP-only with no TLS listener, and no
   * page may load HTTP content or read a cross-origin response. Everything else
   * makes its requests outside a browsing context, where neither rule applies.
   */
  readonly canReachProviderDirectly = this.platform !== 'browser';

  /** Whether there is a player that is not the WebView's. */
  readonly hasNativePlayer = this.platform !== 'browser';

  /**
   * Whether this device keeps its own copy of favourites and history.
   *
   * The same question as above in practice: a machine that can work without the
   * backend should also remember what you did while it was away.
   */
  readonly keepsLocalData = this.platform !== 'browser';

  /**
   * Whether a session should outlive the process.
   *
   * A browser tab may be on a machine that is not yours, so the token dies with
   * it. An installed application is one person's, and being signed out every
   * launch would be absurd -- more so on a television, where signing in is a
   * D-pad and an on-screen keyboard.
   */
  readonly keepsSessionAcrossRestarts = this.platform !== 'browser';
}

function detect(): AppPlatform {
  const named = Capacitor.getPlatform();

  if (named === 'electron') {
    return 'electron';
  }
  if (named === 'android' || named === 'ios') {
    return 'android';
  }

  // Belt and braces: an Electron build whose Capacitor platform did not
  // register still exposes the userAgent, and being wrong here would send a
  // desktop app back through a backend it does not need.
  if (typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)) {
    return 'electron';
  }

  return 'browser';
}
