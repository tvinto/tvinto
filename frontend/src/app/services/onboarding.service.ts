import { Injectable, inject } from '@angular/core';
import { guideSourceId } from '@shared/xtream/guideSourceId';
import { technicalDetail } from '../utils/failure-messages.utils';
import { AccountService } from './account.service';
import { GuideService } from './guide.service';
import { GuideSourcesService } from './guide-sources.service';

/** Set on this device once the first launch's walk-through is finished or left. */
const DONE_KEY = 'tvinto_onboarding_done';

/** For this run: "I have an account" was chosen, and a television comes back for Starting up. */
const AFTER_SIGN_IN_KEY = 'tvinto_onboarding_after_sign_in';

/** How long a guide added during the walk-through waits for the one before it. */
const WAIT_FOR_LOAD_MS = 10 * 60 * 1000;

/**
 * The first launch on a device (design round 10, the OB-TV and OB-P boards):
 * welcome, the provider, the programme guide, how a television starts, done.
 *
 * Shown once per device, to somebody with no account and nothing to watch
 * yet -- where "Add your provider" used to open -- and never again once
 * finished or left; a device that already has a provider never sees it.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingService {
  private readonly accounts = inject(AccountService);
  private readonly guide = inject(GuideService);
  private readonly sources = inject(GuideSourcesService);

  /** Whether to open the walk-through instead of "Add your provider". */
  shouldShow(): boolean {
    return this.accounts.localProfile.active() && !this.accounts.hasSubscription() && !this.done();
  }

  done(): boolean {
    try {
      return localStorage.getItem(DONE_KEY) === '1';
    } catch {
      // Unreadable storage: shown again at worst, never a device stuck in it.
      return true;
    }
  }

  finish(): void {
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      // Shown once more at the next launch, which is all it costs.
    }
  }

  /** "I have an account": a television comes back after signing in, for Starting up. */
  signingIn(television: boolean): void {
    // Not finished here: back from the sign-in page without signing in, the
    // walk-through is still what a device with nothing in it opens on. Signed
    // in, it is never shown again anyway (shouldShow).
    if (!television) {
      return;
    }
    try {
      sessionStorage.setItem(AFTER_SIGN_IN_KEY, '1');
    } catch {
      // Starting up is still on Account.
    }
  }

  /** Once, after signing in: whether to show Starting up before the library. */
  takeAfterSignIn(): boolean {
    try {
      const asked = sessionStorage.getItem(AFTER_SIGN_IN_KEY) === '1';
      sessionStorage.removeItem(AFTER_SIGN_IN_KEY);
      return asked;
    } catch {
      return false;
    }
  }

  /**
   * A guide added here, downloaded once the one before it has finished: the
   * provider's own guide starts downloading as the provider is added, and the
   * guide store takes one at a time (GuideService.load). Carries on after the
   * walk-through is left. Resolves with what went wrong, if anything, for a
   * guide somebody typed (an address that is no guide is taken off again).
   * Without a label the guide is named after its address.
   */
  addGuide(url: string, label?: string): Promise<unknown> {
    this.sources.add(url, label);
    const id = guideSourceId(url);
    return (async () => {
      const until = Date.now() + WAIT_FOR_LOAD_MS;
      while (this.guide.isLoading() && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      try {
        await this.guide.load(id, url);
        return null;
      } catch (error) {
        console.warn('Could not load a guide added at the start', technicalDetail(error));
        return error;
      }
    })();
  }
}
