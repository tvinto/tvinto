import { UpdateBarsComponent } from '../update-bars/update-bars.component';
import { NgTemplateOutlet } from '@angular/common';
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
import { t } from '../../utils/i18n';
import { signInPhoneKind } from '../../utils/phone-form.utils';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { TPipe } from '../../pipes/t.pipe';
import { takePageAfterRestart } from '../../services/family-profiles.service';
import { API_URL, buildHasServer, chooseServer, chosenServer, hasServer, movedApiUrl } from '../../services/api-url';
import { ToastService } from '../../services/toast.service';
import { SyncStartService } from '../../services/sync-start.service';
import { OnboardingService } from '../../services/onboarding.service';
import { ServiceKindService } from '../../services/service-kind.service';
import { technicalDetail } from '../../utils/failure-messages.utils';
import { isSyncServiceHealth, registrationOf, serverAddressCandidates, serverName } from '@shared/server';
import { LanguagePickerComponent } from '../language-picker/language-picker.component';
import { TvintoMarkComponent } from '../../ui/tvinto-mark.component';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { Capacitor } from '@capacitor/core';

const SELF_HOST_GUIDE = 'https://github.com/tvinto/tvinto/tree/main/server';

/** How long an address gets to say it is a sync service. */
const SERVER_CHECK_MS = 10_000;

/** How long https gets when plain http on the person's own network is still to try. */
const SERVER_FIRST_TRY_MS = 4_000;

type Mode = 'signIn' | 'register';

/** The card's fields that can be missing something, by their element id. */
type Field = 'server' | 'username' | 'password' | 'invite';

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
  imports: [UpdateBarsComponent, NgTemplateOutlet, PhoneFormOfferComponent, TPipe, ReactiveFormsModule, NgIcon, HlmButton, HlmInput, HlmLabel, SettingGroupComponent, SettingRowComponent, TvintoMarkComponent, LanguagePickerComponent],
  providers: [provideIcons({ lucideEye, lucideEyeOff, lucideLoaderCircle })],
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LoginComponent {
  private readonly accounts = inject(AccountService);
  private readonly router = inject(Router);
  private readonly syncStart = inject(SyncStartService);

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
  /** What the server said no to (a wrong password, a name taken): above the form. */
  readonly error = signal('');

  /**
   * What is missing from a field, said under that field, which also takes
   * focus. Not "do this first" at the top of the card about a field that is
   * right there (12 November).
   */
  readonly fieldErrors = signal<Partial<Record<Field, string>>>({});

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
   * reports. Before that, with the address typed on this card, the server is
   * asked whether it is one.
   */
  readonly busyLabel = computed(() => {
    if (this.checkingServer()) {
      return t('server.checking');
    }
    const deriving = this.accounts.deriving();
    if (deriving !== null) {
      return t('login.unlocking', { percent: Math.round(deriving * 100) });
    }
    return this.mode() === 'signIn' ? t('login.signingIn') : t('login.creating');
  });

  /**
   * Whether an account here needs an invite, as the server says
   * (registrationOf). Null until it answers, and for a server that does not
   * say -- which needed invites, so that is what null means below. With no
   * server yet nothing is known, and the card does not claim either; the
   * server is asked on Sign in before an invite is required.
   */
  readonly registration = signal<'open' | 'invite' | null>(null);
  readonly inviteNeeded = computed(() => {
    const registration = this.registration();
    return registration === null ? !this.noServer() : registration === 'invite';
  });

  constructor() {
    // Without an account this page is passed by, asking nothing of anyone.
    if (this.passingThrough) {
      this.goOnward();
      return;
    }

    this.askRegistration();

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
  private readonly serviceKind = inject(ServiceKindService);
  private readonly tv = inject(TvNavigationService);

  /** Where requests go, read at each use (API_URL): a server chosen here is used at once. */
  private readonly apiUrl = inject(API_URL);

  /**
   * A build that names no server, and none chosen here yet: the public one
   * (hasServer). The address is then the first field of the form, and Sign
   * in checks it, keeps it and signs in, in one press.
   */
  readonly noServer = signal(!hasServer());
  /** The server everything talks to, as people recognise it. */
  readonly serverShown = signal(serverName(this.apiUrl()));
  /** Whether that is the build's own rather than one chosen here. */
  readonly usingDefault = signal(chosenServer() === null);
  /** Whether the build has one of its own to go back to: not a public build. */
  readonly hasDefault = buildHasServer();

  /** The address form open in place of the Server row: "Change", with a server already in use. */
  readonly changingServer = signal(false);
  /** What the phone page asks for (signInPhoneKind). */
  readonly phoneKind = computed(() => signInPhoneKind(this.noServer(), this.changingServer()));

  /**
   * The guide to running a sync service of one's own (server/README.md). A
   * television has no browser to open it in, so there it is an address to
   * type somewhere that has one.
   */
  readonly selfHostGuideShown = SELF_HOST_GUIDE.replace('https://', '');
  readonly onTelevision = this.tv.isTelevision;

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

  /** What was typed on a phone (PhoneFormOfferComponent): into the fields, used only when the person goes on here. */
  fromPhone(fields: Record<string, string>): void {
    if (fields['server'] !== undefined) {
      this.typedServer(fields['server']);
    }
    if (fields['name'] !== undefined) {
      this.form.patchValue({ username: fields['name'], password: fields['password'] ?? '' });
    }
  }

  startChangingServer(): void {
    this.serverInput.set(this.usingDefault() ? '' : this.serverShown());
    this.clearFieldError('server');
    this.changingServer.set(true);
    this.focusField('server');
  }

  cancelChangingServer(): void {
    this.changingServer.set(false);
    this.clearFieldError('server');
  }

  typedServer(value: string): void {
    this.serverInput.set(value);
    this.clearFieldError('server');
    if (this.noServer()) {
      this.registration.set(null);
    }
  }

  /**
   * Leaving the address field with no server yet: asks it, quietly, whether
   * it takes accounts without an invite, so that Create account says so
   * before it is pressed. Anything wrong with the address is said on Sign
   * in, not here.
   */
  async peekRegistration(): Promise<void> {
    if (!this.noServer()) {
      return;
    }
    const typed = this.serverInput();
    for (const apiUrl of serverAddressCandidates(typed)) {
      try {
        const response = await fetch(`${apiUrl}/health`, { cache: 'no-store', signal: AbortSignal.timeout(SERVER_FIRST_TRY_MS) });
        const body: unknown = await response.json();
        if (this.serverInput() === typed && isSyncServiceHealth(body)) {
          this.registration.set(registrationOf(body));
        }
        return;
      } catch {
        // Not this way; the next, if there is one.
      }
    }
  }

  typedInForm(field: Field): void {
    this.clearFieldError(field);
  }

  /**
   * "Use this server", on the Change form: asks the address whether it is a
   * sync service, and if it is, makes it the one everything uses. What is
   * typed in the name and password stays as it is.
   */
  async useServer(): Promise<void> {
    if (!this.serverInput().trim()) {
      this.missing('server', t('server.needAddress'));
      return;
    }
    this.checkingServer.set(true);
    try {
      const apiUrl = await this.checkServer();
      if (apiUrl) {
        this.serverChosen(apiUrl);
        this.focusField('username');
      }
    } finally {
      this.checkingServer.set(false);
    }
  }

  /**
   * The address typed, asked whether it is a sync service. Its API address if
   * it is; null, with the reason said, if not.
   */
  private async checkServer(): Promise<string | null> {
    // https first; the same over http only for a host alone on the person's
    // own network, and only when https did not answer (serverAddressCandidates).
    const candidates = serverAddressCandidates(this.serverInput());
    if (!candidates.length) {
      this.missing('server', t('server.invalid'));
      return null;
    }
    const name = serverName(candidates[0]);
    const unreached: string[] = [];
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
        return null;
      }
      this.registration.set(registrationOf(body));
      return movedApiUrl(response) ?? apiUrl;
    }
    this.toasts.error(t('server.notReached'), t('server.notReachedBody', { name }), {
      detail: unreached.join('\n')
    });
    return null;
  }

  /**
   * Keeps a server (or the build's own, for null) and uses it from now on.
   * No restart: every service reads the address as it makes a request
   * (API_URL), and what was learned about the old one is forgotten.
   */
  private serverChosen(apiUrl: string | null): void {
    chooseServer(apiUrl);
    this.serviceKind.forget();
    this.noServer.set(!hasServer());
    this.serverShown.set(serverName(this.apiUrl()));
    this.usingDefault.set(chosenServer() === null);
    this.changingServer.set(false);
    this.clearFieldError('server');
    if (apiUrl === null) {
      this.askRegistration();
    }
  }

  /** Asked fresh each time: a server somebody has just set up is open to its first account and needs invites from then on. */
  private askRegistration(): void {
    this.registration.set(null);
    if (this.noServer()) {
      return;
    }
    fetch(`${this.apiUrl()}/health`, { cache: 'no-store' })
      .then(response => {
        // A server kept before addresses were followed (movedApiUrl): put right here, before it is signed in to.
        const moved = movedApiUrl(response);
        if (moved && chosenServer() !== null) {
          chooseServer(moved);
          this.serverShown.set(serverName(moved));
        }
        return response.json();
      })
      .then(body => this.registration.set(registrationOf(body)))
      .catch(() => undefined);
  }

  /** Back to the device's own library, from having come here to start syncing. */
  withoutAccount(): void {
    this.goOnward();
  }

  useDefaultServer(): void {
    this.serverChosen(null);
  }

  switchTo(mode: Mode): void {
    this.mode.set(mode);
    this.error.set('');
    this.fieldErrors.set({});
    // The link pressed goes with the mode it switched from, and focus went
    // with it to nothing on the television (the walk, 23 November).
    this.focusField('username');
  }

  togglePassword(): void {
    this.passwordShown.update(shown => !shown);
  }

  async onSubmit(): Promise<void> {
    if (this.loading()) {
      return;
    }
    this.error.set('');
    // Everything that can be seen to be missing, in the order of the fields,
    // before anything is asked of a server.
    if (this.noServer() && !this.serverInput().trim()) {
      this.missing('server', t('server.needAddress'));
      return;
    }
    const registering = this.mode() === 'register';
    const { username, password, invite } = this.form.getRawValue();
    if (!username.trim()) {
      this.missing('username', t('login.needUsername'));
      return;
    }
    if (registering && this.form.controls.username.invalid) {
      this.missing('username', t('login.usernameRule'));
      return;
    }
    if (!password) {
      this.missing('password', t('login.needPassword'));
      return;
    }
    if (registering && this.form.controls.password.invalid) {
      this.missing('password', t('login.passwordRule'));
      return;
    }

    this.loading.set(true);

    // The address typed on this card: checked and kept as part of the same
    // press, rather than a button of its own and a second start.
    if (this.noServer()) {
      this.checkingServer.set(true);
      const apiUrl = await this.checkServer().finally(() => this.checkingServer.set(false));
      if (!apiUrl) {
        this.loading.set(false);
        this.focusField('server');
        return;
      }
      this.serverChosen(apiUrl);
    }

    // Registration is closed on the service except by invite, so an attempt
    // without one can only be refused -- better said here than after a
    // key derivation that takes seconds on a television. Asked after the
    // server, whose answer says whether it needs one.
    if (registering && this.inviteNeeded() && !invite.trim()) {
      this.loading.set(false);
      this.missing('invite', t('login.needInvite'));
      return;
    }

    const request = registering
      ? this.accounts.register(username, password, invite)
      : this.accounts.logIn(username, password);

    request.subscribe({
      next: () => void this.signedIn(),
      error: (err: unknown) => {
        this.loading.set(false);
        this.error.set(this.accounts.describeError(err));
        // The pressed button was disabled while waiting, which left a remote with nothing focused.
        this.focusField('password');
      }
    });
  }

  /** Says under a field what it is missing, and puts focus there. */
  private missing(field: Field, message: string): void {
    this.fieldErrors.set({ [field]: message });
    this.focusField(field);
  }

  private clearFieldError(field: Field): void {
    if (this.fieldErrors()[field]) {
      this.fieldErrors.update(errors => ({ ...errors, [field]: undefined }));
    }
  }

  /**
   * After the view has drawn what was just asked for (a field that has only
   * now appeared). On a television without raising the keyboard: OK opens it,
   * as for any field the remote reaches.
   */
  private focusField(field: Field): void {
    setTimeout(() => {
      const element = document.getElementById(field);
      if (!element) {
        return;
      }
      if (this.onTelevision()) {
        this.tv.focusAsIfMoved(element);
      } else {
        element.focus();
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
