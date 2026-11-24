import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { LoginComponent } from './login.component';
import { AccountService } from '../../services/account.service';
import { SyncStartService } from '../../services/sync-start.service';
import { OnboardingService } from '../../services/onboarding.service';
import { ToastService } from '../../services/toast.service';
import { ServiceKindService } from '../../services/service-kind.service';
import { TvNavigationService } from '../../services/tv-navigation.service';

/** What a phone sends fills the sign-in form (24 November: all three at once with no server yet). */
describe('LoginComponent from a phone', () => {
  beforeEach(() => {
    // Asked on opening whether the server takes accounts; nothing answers here.
    (globalThis as { fetch?: unknown }).fetch = jest.fn(() => new Promise(() => undefined));
  });

  function login(): LoginComponent {
    TestBed.configureTestingModule({
      providers: [
        { provide: AccountService, useValue: { localProfile: { active: () => false }, getToken: () => null } },
        { provide: Router, useValue: {} },
        { provide: SyncStartService, useValue: {} },
        { provide: ActivatedRoute, useValue: { snapshot: { routeConfig: { path: 'login' }, queryParamMap: new Map() } } },
        { provide: OnboardingService, useValue: {} },
        { provide: ToastService, useValue: {} },
        { provide: ServiceKindService, useValue: {} },
        { provide: TvNavigationService, useValue: { isTelevision: () => true } }
      ]
    });
    TestBed.overrideComponent(LoginComponent, { set: { template: '', imports: [] } });
    return TestBed.createComponent(LoginComponent).componentInstance;
  }

  it('fills the server, name and password when there is no server yet', () => {
    const page = login();
    page.noServer.set(true);
    expect(page.phoneKind()).toBe('serverSignin');

    page.fromPhone({ server: 'sync.example', name: 'ana', password: 'secret' });

    expect(page.serverInput()).toBe('sync.example');
    expect(page.form.getRawValue()).toMatchObject({ username: 'ana', password: 'secret' });
  });

  it('takes only the server while one in use is being changed, and keeps what was typed', () => {
    const page = login();
    page.noServer.set(false);
    page.changingServer.set(true);
    page.form.patchValue({ username: 'ana', password: 'secret' });
    expect(page.phoneKind()).toBe('server');

    page.fromPhone({ server: 'other.example' });

    expect(page.serverInput()).toBe('other.example');
    expect(page.form.getRawValue()).toMatchObject({ username: 'ana', password: 'secret' });
  });

  it('takes the name and password with a server set', () => {
    const page = login();
    page.noServer.set(false);
    expect(page.phoneKind()).toBe('signin');

    page.fromPhone({ name: 'ana', password: 'secret' });

    expect(page.form.getRawValue()).toMatchObject({ username: 'ana', password: 'secret' });
  });
});
