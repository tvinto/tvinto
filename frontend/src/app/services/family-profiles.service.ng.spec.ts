import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { API_URL } from './api-url';
import { AccountService } from './account.service';
import { FamilyService } from './family.service';
import { ParentalLockService } from './parental-lock.service';
import { FamilyProfilesService } from './family-profiles.service';
import { VAULT_KEY } from '../utils/profile-vault.utils';

/**
 * "Who's watching?" is asked when the app opens on a device with a household,
 * but not on the start a profile switch makes: the app restarts to become the
 * person chosen, and asking again there made every switch take two picks (the
 * owner's TV, 10 November).
 */
describe('FamilyProfilesService and who is watching', () => {
  const build = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: HttpClient, useValue: {} },
        { provide: API_URL, useValue: () => 'https://sync.example/api' },
        { provide: AccountService, useValue: { signedIn: () => true } },
        { provide: FamilyService, useValue: {} },
        { provide: ParentalLockService, useValue: {} }
      ]
    });
    return TestBed.inject(FamilyProfilesService);
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(
      VAULT_KEY,
      JSON.stringify({ home: 'petar', active: 'petar', scope: 'full', lastSeenAt: null, household: [{ id: 2, username: 'ana', role: 'member' }], stash: {} })
    );
  });

  it('asks when the app opens on a device with a household', () => {
    expect(build().askWhoIsWatching()).toBe(true);
  });

  it('does not ask on the restart a switch made, and asks again on the next start', () => {
    sessionStorage.setItem('tvinto_profile_answered', '1');
    expect(build().askWhoIsWatching()).toBe(false);
    expect(build().askWhoIsWatching()).toBe(true);
  });
});
