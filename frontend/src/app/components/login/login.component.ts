import { PhoneFormOfferComponent } from '../phone-form-offer/phone-form-offer.component';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEye, lucideEyeOff, lucideLoaderCircle } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { AccountService } from '../../services/account.service';
import { LanguageService } from '../../services/language.service';
import { t } from '../../utils/i18n';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { TPipe } from '../../pipes/t.pipe';
import { takePageAfterRestart } from '../../services/family-profiles.service';
import { API_URL, chooseServer, chosenServer, hasServer } from '../../services/api-url';
import { ToastService } from '../../services/toast.service';
import { SyncStartService } from '../../services/sync-start.service';
import { OnboardingService } from '../../services/onboarding.service';
import { technicalDetail } from '../../utils/failure-messages.utils';
import { isSyncServiceHealth, registrationOf, serverAddressCandidates, serverName } from '@shared/server';
import { TvintoMarkComponent } from '../../ui/tvinto-mark.component';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { Capacitor } from '@capacitor/core';

const SELF_HOST_GUIDE = 'https://github.com/tvinto/tvinto/tree/main/server';

/** How long an address gets to say it is a sync service. */
const SERVER_CHECK_MS = 10_000;

/** How long https gets when plain http on the person's own network is still to try. */
const SERVER_FIRST_TRY_MS = 4_000;

type Mode = 'signIn' | 'register';

/**
 * The way in.
 *
 * Your own username and password, not the provider's. Xtream credentials
 * expire and get reissued; an account that changed every year would take your
 * favourites with it each time, so the subscription is asked for separately,
 * after you are already someone.
 */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [PhoneFormOfferComponent, TPipe, ReactiveFormsModule, NgIcon, HlmButton, HlmInput, HlmLabel, SettingGroupComponent, SettingRowComponent, TvintoMarkComponent],
  providers: [provideIcons({ lucideEye, lucideEyeOff, lucideLoaderCircle })],
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LoginComponent {
  private readonly accounts = inject(AccountService);
  private readonly router = inject(Router);
  private readonly syncStart = inject(SyncStartService);
  readonly languages = inject(LanguageService);

  /**
   * Reached from a device used without an account, to start syncing it
   * (Account -> Sign in to sync). Otherwise such a device passes this page
   * by: the account is only for syncing.
   */
  private readonly route = inject(ActivatedRoute).snapshot;
  readonly toSync = this.route.routeConfig?.path === 'sign-in';
  readonly passingThrough = this.accounts.localProfile.active() && !this.toSync;
  private readonly onboarding = inject(OnboardingService);

  /** Making an account, when the first launch's "Sync with an account" sent somebody here. */
  readonly mode = signal<Mode>(this.route.queryParamMap.get('create') === '1' ? 'register' : 'signIn');
  readonly loading = signal(false);
  readonly error = signal('');

  readonly form = new FormGroup({
    username: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(3)]
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(8)]
    }),
    // Only asked for when creating an account; checked in `onSubmit`.
    invite: new FormControl('', { nonNullable: true })
  });

  /**
   * Whether the password is shown as typed.
   *
   * Hidden by default, as anywhere. Shown on request, because on a television
   * every character is an arrow-key journey round an on-screen keyboard, and
   * one slip hidden behind a dot means starting again (22 September).
   */
  readonly passwordShown = signal(false);

  readonly heading = computed(() =>
    this.mode() === 'signIn' ? t('login.signIn') : t('login.createYourAccount')
  );

  readonly submitLabel = computed(() =>
    this.mode() === 'signIn' ? t('login.signIn') : t('login.createAccount')
  );

  /**
   * What the button says while it works.
   *
   * The key derivation is deliberately slow -- a second on a desktop and
   * several on a television -- and it happens before any request goes out. A
   * button that sat on "Signing in…" through all of it would look stuck, so
   * while the key is being made it says so, with the progress the derivation
   * reports.
   */
  readonly busyLabel = computed(() => {
    const deriving = this.accounts.deriving();
    if (deriving !== null) {
      return t('login.unlocking', { percent: Math.round(deriving * 100) });
    }
    return this.mode() === 'signIn' ? t('login.signingIn') : t('login.creating');
  });

  /**
   * Whether an account here needs an invite, as the server says
   * (registrationOf). Null until it answers, and for a server that does not
   * say -- which needed invites, so that is what null means below.
   */
  readonly registration = signal<'open' | 'invite' | null>(null);
  readonly inviteNeeded = computed(() => this.registration() !== 'open');

  constructor() {
    // Without an account this page is passed by, asking nothing of anyone.
    if (this.passingThrough) {
      this.goOnward();
      return;
    }

    // Asked fresh each time rather than once: a server somebody has just set
    // up is open to its first account and needs invites from then on.
    if (!this.noServer) {
      fetch(`${this.apiUrl}/health`, { cache: 'no-store' })
        .then(response => response.json())
        .then(body => this.registration.set(registrationOf(body)))
        .catch(() => undefined);
    }

    // A token from a previous visit may already be good. Check before showing a
    // form that asks for something the user has effectively already given.
    if (this.accounts.getToken()) {
      this.loading.set(true);
      this.accounts.refresh().subscribe(valid => {
        this.loading.set(false);
        if (valid) {
          this.goOnward();
        }
      });
    }
  }

  // --- Which server ----------------------------------------------------------

  private readonly toasts = inject(ToastService);

  /** The server this start of the app talks to, as people recognise it. */
  private readonly apiUrl = inject(API_URL);
  /**
   * A build that names no server, and none chosen here yet: the public one
   * (hasServer). Nothing is asked of anyone until an address is given, and
   * the address form is open from the start.
   */
  readonly noServer = !hasServer();
  readonly serverShown = this.noServer ? t('server.none') : serverName(this.apiUrl);
  /** Whether that is the build's own rather than one chosen here. */
  readonly usingDefault = chosenServer() === null && !this.noServer;

  readonly changingServer = signal(this.noServer);

  /**
   * The guide to running a sync service of one's own (server/README.md). A
   * television has no browser to open it in, so there it is an address to
   * type somewhere that has one.
   */
  readonly selfHostGuideShown = SELF_HOST_GUIDE.replace('https://', '');
  readonly onTelevision = inject(TvNavigationService).isTelevision;

  openSelfHostGuide(): void {
    const desktop = (window as { xtreamDesktop?: { openExternal?: (url: string) => Promise<boolean> } }).xtreamDesktop;
    if (desktop?.openExternal) {
      void desktop.openExternal(SELF_HOST_GUIDE);
    } else if (Capacitor.isNativePlatform()) {
      // A navigation away from the app is handed to the system's browser.
      window.location.href = SELF_HOST_GUIDE;
    } else {
      window.open(SELF_HOST_GUIDE, '_blank', 'noopener');
    }
  }
  readonly serverInput = signal('');
  readonly checkingServer = signal(false);
  /** What was typed and could not be an address: said under the field, where it was typed. */
  readonly serverError = signal('');

  /** What was typed on a phone (PhoneFormOfferComponent): into the fields, used only when the person goes on here. */
  fromPhone(fields: Record<string, string>): void {
    if (this.changingServer()) {
      this.serverInput.set(fields['server'] ?? '');
      this.serverError.set('');
    } else {
      this.form.patchValue({ username: fields['name'] ?? '', password: fields['password'] ?? '' });
    }
  }

  startChangingServer(): void {
    this.serverInput.set(this.usingDefault || this.noServer ? '' : this.serverShown);
    this.serverError.set('');
    this.changingServer.set(true);
  }

  /**
   * Asks the address whether it is a sync service, and if it is, starts the
   * app again on it. Every service reads where the server is as it starts,
   * so a fresh start is what makes the new one the one everything uses.
   */
  async useServer(): Promise<void> {
    // https first; the same over http only for a host alone on the person's
    // own network, and only when https did not answer (serverAddressCandidates).
    const candidates = serverAddressCandidates(this.serverInput());
    if (!candidates.length) {
      this.serverError.set(t('server.invalid'));
      return;
    }
    this.serverError.set('');
    this.checkingServer.set(true);
    const name = serverName(candidates[0]);
    const unreached: string[] = [];
    try {
      for (const [index, apiUrl] of candidates.entries()) {
        let response: Response;
        try {
          response = await fetch(`${apiUrl}/health`, {
            cache: 'no-store',
            // Shorter while there is another way still to try.
            signal: AbortSignal.timeout(index < candidates.length - 1 ? SERVER_FIRST_TRY_MS : SERVER_CHECK_MS)
          });
        } catch (error) {
          unreached.push(`${apiUrl}: ${technicalDetail(error)}`);
          continue;
        }
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !isSyncServiceHealth(body)) {
          // It answered, as something else: not a reason to try it over http.
          this.toasts.error(t('server.notSync'), t('server.notSyncBody', { name }), {
            detail: `${apiUrl}: ${response.status} ${response.statusText}`.trim()
          });
          return;
        }
        chooseServer(apiUrl);
        window.location.replace(document.baseURI);
        return;
      }
      this.toasts.error(t('server.notReached'), t('server.notReachedBody', { name }), {
        detail: unreached.join('\n')
      });
    } finally {
      this.checkingServer.set(false);
    }
  }

  /** Back to the device's own library, from having come here to start syncing. */
  withoutAccount(): void {
    this.goOnward();
  }

  useDefaultServer(): void {
    chooseServer(null);
    window.location.replace(document.baseURI);
  }

  switchTo(mode: Mode): void {
    this.mode.set(mode);
    this.error.set('');
  }

  togglePassword(): void {
    this.passwordShown.update(shown => !shown);
  }

  onSubmit(): void {
    if (this.noServer) {
      this.error.set(t('server.needFirst'));
      this.changingServer.set(true);
      return;
    }
    if (this.form.invalid) {
      this.error.set(
        this.mode() === 'register'
          ? t('login.needValid')
          : t('login.needBoth')
      );
      return;
    }

    const { username, password, invite } = this.form.getRawValue();

    // Registration is closed on the service except by invite, so an attempt
    // without one can only be refused -- better said here than after a
    // key derivation that takes seconds on a television.
    if (this.mode() === 'register' && this.inviteNeeded() && !invite.trim()) {
      this.error.set(t('login.needInvite'));
      return;
    }

    this.loading.set(true);
    this.error.set('');

    const request =
      this.mode() === 'signIn'
        ? this.accounts.logIn(username, password)
        : this.accounts.register(username, password, invite);

    request.subscribe({
      next: () => void this.signedIn(),
      error: (err: unknown) => {
        this.loading.set(false);
        this.error.set(this.accounts.describeError(err));
      }
    });
  }

  /**
   * In. A device used without an account first hands what it kept to the
   * account (SyncStartService); if that cannot be done the sign-in is taken
   * back, and the device goes on as it was.
   */
  private async signedIn(): Promise<void> {
    try {
      await this.syncStart.afterSignIn();
    } catch (error) {
      this.accounts.undoSignIn();
      this.loading.set(false);
      this.error.set(t('local.notBrought'));
      this.toasts.error(t('local.notBrought'), t('local.notBroughtBody'), { detail: technicalDetail(error) });
      return;
    }
    this.loading.set(false);
    this.goOnward();
  }

  /**
   * Straight to the library, or to setting up a subscription if there is none.
   *
   * In place of the sign-in page rather than on top of it, so Back from the
   * library closes the app as it does on any other first screen. Pushed, it
   * went back to a sign-in form for an account already signed in (a user,
   * 22 September).
   */
  private goOnward(): void {
    // The first launch on a device with nothing in it yet, instead of "Add
    // your provider"; and a television signed in from it, back for Starting up.
    if (this.onboarding.shouldShow()) {
      void this.router.navigate(['/welcome'], { replaceUrl: true });
      return;
    }
    if (!this.accounts.localProfile.active() && this.onboarding.takeAfterSignIn()) {
      void this.router.navigate(['/welcome'], { queryParams: { step: 'startup' }, replaceUrl: true });
      return;
    }
    // A family profile switch starts the app again and names the page to open.
    const asked = takePageAfterRestart();
    if (asked) {
      void this.router.navigateByUrl(asked, { replaceUrl: true });
      return;
    }
    void this.router.navigate([this.accounts.hasSubscription() ? '/for-you' : '/subscription'], {
      replaceUrl: true
    });
  }
}
