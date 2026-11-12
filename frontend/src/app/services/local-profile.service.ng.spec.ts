import { TestBed } from '@angular/core/testing';
import { LOCAL_PROFILE_KEY, LocalProfileService } from './local-profile.service';
import { PlatformService } from './platform.service';

/**
 * Which devices start without an account: one that
 * never held an account, and one left that way. Never one whose account's
 * session was refused -- that is the same person about to sign back in.
 */
describe('LocalProfileService', () => {
  const build = (platform: 'electron' | 'browser' = 'electron') => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PlatformService,
          useValue: { keepsLocalData: platform !== 'browser', canReachProviderDirectly: platform !== 'browser' }
        }
      ]
    });
    return TestBed.inject(LocalProfileService);
  };

  beforeEach(() => localStorage.clear());

  it('starts without an account on a device that never held one', () => {
    expect(build().active()).toBe(true);
  });

  it('waits at the sign-in for an account whose session was refused', () => {
    // A refused session takes the token and leaves the account's name.
    localStorage.setItem('xtream_account', JSON.stringify({ id: 1, username: 'ana' }));
    expect(build().active()).toBe(false);
  });

  it('stays signed in when there is a session', () => {
    localStorage.setItem('xtream_session_token', 'token-1');
    expect(build().active()).toBe(false);
  });

  it('is remembered once entered, and forgotten on signing in', () => {
    const profile = build();
    localStorage.setItem('xtream_account', JSON.stringify({ id: 1, username: 'ana' }));
    profile.enter();
    expect(build().active()).toBe(true);

    build().leave();
    expect(localStorage.getItem(LOCAL_PROFILE_KEY)).toBeNull();
    expect(build().active()).toBe(false);
  });

  it('is never offered in a browser, which keeps nothing itself', () => {
    const profile = build('browser');
    profile.enter();
    expect(profile.active()).toBe(false);
  });
});
