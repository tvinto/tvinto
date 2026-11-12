import { Injectable, Signal, effect, inject, untracked } from '@angular/core';
import { Location } from '@angular/common';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/** Undoes one thing. Returned by `whileOpen` so it can be taken back. */
type Dismiss = () => void;

/**
 * What the back key means.
 *
 * On Android it is not a browser's back button. It is the general "undo the
 * last thing that happened to the screen" control, and a person expects it to
 * peel off one layer at a time: leave full screen, then close the player, then
 * go back to where the list was, and only leave the app when there is nothing
 * left to leave.
 *
 * Capacitor's default is to close the app on the first press, which is what it
 * was doing -- pressing back while watching something quit outright.
 *
 * Layers register themselves as they open, and the newest one is undone first.
 * A registry rather than each dialog listening for the key itself, because only
 * one of them should answer a press and they have no way of knowing which is on
 * top.
 */
@Injectable({ providedIn: 'root' })
export class BackButtonService {
  private readonly location = inject(Location);

  /** Newest last. */
  private readonly layers: Dismiss[] = [];

  private installed = false;

  install(): void {
    if (this.installed || !Capacitor.isNativePlatform()) {
      return;
    }
    this.installed = true;

    void App.addListener('backButton', ({ canGoBack }) => this.onBack(canGoBack));
  }

  /**
   * Registers something that back should close, and hands back the way to
   * unregister it.
   *
   * The caller must call what it is given when the layer closes by any other
   * route -- a close button, a click on the backdrop -- or back will later
   * "close" something that is no longer there and swallow a press.
   */
  whileOpen(dismiss: Dismiss): () => void {
    this.layers.push(dismiss);

    return () => {
      const at = this.layers.lastIndexOf(dismiss);
      if (at >= 0) {
        this.layers.splice(at, 1);
      }
    };
  }

  /**
   * Keeps a layer registered for exactly as long as its signal says it is open.
   *
   * The reason to prefer this over calling `whileOpen` at the point a dialog
   * opens: a dialog has several ways of closing -- its own button, the
   * backdrop, a route change -- and every one of them would have to remember to
   * unregister. Following the signal means the bookkeeping cannot drift from
   * what is actually on the screen.
   *
   * Must be called from an injection context, so a component constructor.
   */
  bindTo(open: Signal<boolean>, dismiss: Dismiss): void {
    let release: (() => void) | null = null;

    effect(onCleanup => {
      const isOpen = open();

      untracked(() => {
        if (isOpen && !release) {
          release = this.whileOpen(dismiss);
        } else if (!isOpen && release) {
          release();
          release = null;
        }
      });

      // Leaving the page with a dialog open would otherwise leave a dismissal
      // behind that closes something already gone, swallowing a press.
      onCleanup(() => {
        release?.();
        release = null;
      });
    });
  }

  /** For You, the screen the app opens on, or the sign-in form before it. */
  private onFirstScreen(): boolean {
    const path = this.location.path().split(/[?#]/)[0];
    return path === '' || path === '/' || path === '/for-you';
  }

  /**
   * Whether this app put a page before this one, whatever the WebView says.
   *
   * After a film played from its own page -- which passes through Movies to
   * start the player and comes back -- the WebView answered that there was no
   * going back, and Back on the film's page closed the app instead of
   * returning to the category it was found in (29 October). The
   * router numbers the pages it opens, and keeps the number with each.
   */
  private hasOwnHistory(): boolean {
    const state = this.location.getState() as { navigationId?: number } | null;
    return (state?.navigationId ?? 0) > 1;
  }

  private onBack(canGoBack: boolean): void {
    // Full screen first, and without being registered: it is owned by the
    // platform rather than by any component, and it is the outermost thing on
    // the screen whenever it is on.
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }

    const top = this.layers.pop();
    if (top) {
      top();
      return;
    }

    // The first screen is where Back leaves the app, as it is in any app with
    // a tab bar -- not a step back through whichever tabs were visited on the
    // way. From For You it went to Live TV, and from there to For You again.
    // Found by the phone walk (tools/qa/phone-walk.js), 22 September.
    if ((canGoBack || this.hasOwnHistory()) && !this.onFirstScreen()) {
      this.location.back();
      return;
    }

    // Nothing left to undo. Only here does back mean what Capacitor assumed it
    // always meant.
    void App.exitApp();
  }
}
