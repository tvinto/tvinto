import { normaliseMac } from '@shared/stalker/client';
import { recordAddress } from '@shared/providers/providerRecord';
import { PhoneFormOfferComponent } from '../phone-form-offer/phone-form-offer.component';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideCheck, lucideEye, lucideEyeOff, lucideGlobe, lucideLoaderCircle, lucidePlus } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { firstValueFrom, timeout } from 'rxjs';
import { ALL_CHANNELS_ID, hostOf, untagged } from '@shared/providers/providerRecord';
import { SETTING_KEYS, StreamType } from '@shared/types';
import { opensLastChannel } from '@shared/startup';
import { guideSourceId } from '@shared/xtream/guideSourceId';
import { TPipe } from '../../pipes/t.pipe';
import { t } from '../../utils/i18n';
import { technicalDetail } from '../../utils/failure-messages.utils';
import { AccountService } from '../../services/account.service';
import { BackButtonService } from '../../services/back-button.service';
import { ChannelPreviewService } from '../../services/channel-preview.service';
import { GuideService } from '../../services/guide.service';
import { GuideSourcesService, guideAddressProblem, guideName } from '../../services/guide-sources.service';
import { EpgShareService } from '../../services/epg-share.service';
import { EmptyGuide } from '@shared/xtream/guide';
import { LanguagePickerComponent } from '../language-picker/language-picker.component';
import { OnboardingService } from '../../services/onboarding.service';
import { ProviderInput, ProvidersService } from '../../services/providers.service';
import { SettingsService } from '../../services/settings.service';
import { ToastService } from '../../services/toast.service';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { XtreamService } from '../../services/xtream.service';
import { StartupSettingsComponent } from '../startup-settings/startup-settings.component';
import { TvintoMarkComponent } from '../../ui/tvinto-mark.component';
import { TmdbKeyComponent } from '../tmdb-key/tmdb-key.component';
import { TmdbService } from '../../services/tmdb.service';

type Step = 'welcome' | 'provider' | 'guide' | 'tmdb' | 'startup' | 'done';

/** How long checking a provider waits for its category list. */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * The first launch on a device (OnboardingService; design round 10, boards
 * OB-TV-1 to OB-TV-5 and OB-P-1 to OB-P-4). Two columns on a television, as
 * its sign-in page: where and which step on the left, the step on a card on
 * the right. One column on a phone and a computer, the step's buttons at the
 * bottom of a phone. Every step can be skipped and changed later where it
 * lives today; a television gets Starting up, the others do not.
 *
 * The TMDB step asks for a key of the device's own (TmdbService): without an
 * account there is no sync service to hand one out, and Popular, New in your
 * shows and the film and show pages' details stay empty without one.
 */
@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [TPipe, NgIcon, HlmButton, HlmInput, HlmLabel, StartupSettingsComponent, TvintoMarkComponent, PhoneFormOfferComponent, LanguagePickerComponent, TmdbKeyComponent],
  providers: [provideIcons({ lucideArrowLeft, lucideCheck, lucideEye, lucideEyeOff, lucideGlobe, lucideLoaderCircle, lucidePlus })],
  templateUrl: './onboarding.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OnboardingComponent {
  private readonly router = inject(Router);
  private readonly accounts = inject(AccountService);
  private readonly onboarding = inject(OnboardingService);
  private readonly providers = inject(ProvidersService);
  private readonly xtream = inject(XtreamService);
  private readonly toasts = inject(ToastService);
  private readonly settings = inject(SettingsService);
  readonly sources = inject(GuideSourcesService);
  readonly guide = inject(GuideService);
  readonly preview = inject(ChannelPreviewService);
  readonly tv = inject(TvNavigationService);
  readonly tmdb = inject(TmdbService);

  readonly step = signal<Step>(inject(ActivatedRoute).snapshot.queryParamMap.get('step') === 'startup' ? 'startup' : 'welcome');

  /** Signed in already: came back after "I have an account" for Starting up. */
  readonly signedIn = !this.accounts.localProfile.active();

  /** The numbered steps after Welcome, as this device has them. */
  readonly numbered = computed<Step[]>(() =>
    this.tv.isTelevision() ? ['provider', 'guide', 'tmdb', 'startup', 'done'] : ['provider', 'guide', 'tmdb', 'done']
  );
  readonly stepNumber = computed(() => this.numbered().indexOf(this.step()) + 1);

  /** Back goes to the step before, down to Welcome; not from Starting up after signing in. */
  readonly canGoBack = computed(() => this.step() !== 'welcome' && !(this.signedIn && this.step() === 'startup'));

  // --- The provider -----------------------------------------------------------

  readonly kind = signal<'xtream' | 'm3u' | 'stalker'>('xtream');
  readonly portalUrl = signal('');
  readonly mac = signal('');
  readonly serverUrl = signal('');
  readonly username = signal('');
  readonly password = signal('');
  readonly playlistUrl = signal('');
  readonly passwordShown = signal(false);
  readonly checking = signal(false);
  /** The provider added and answering: its address and how many categories it has. */
  readonly found = signal<{ host: string; categories: number } | null>(null);

  readonly filled = computed(() =>
    this.kind() === 'xtream'
      ? !!this.serverUrl().trim() && !!this.username().trim() && !!this.password()
      : this.kind() === 'stalker'
        ? !!this.portalUrl().trim() && !!normaliseMac(this.mac())
        : /^https?:\/\/\S+$/i.test(this.playlistUrl().trim())
  );

  // --- The guide --------------------------------------------------------------

  /** What each guide source holds once loaded, by id. */
  readonly totals = signal<ReadonlyMap<string, { channels: number; programmes: number }>>(new Map());
  /** The guide suggested beside the provider's own, for the device's country, as the Guides page suggests it. */
  readonly share = inject(EpgShareService);
  readonly shareAdded = computed(() => {
    const suggestion = this.share.suggestion();
    return !!suggestion && this.sources.sources().some(source => source.id === guideSourceId(suggestion.url));
  });
  readonly guideName = guideName;
  /** A guide of one's own, by address, as on the Guides page. */
  readonly guideUrl = signal('');
  readonly guideLabel = signal('');

  // --- Done -------------------------------------------------------------------

  readonly providerLine = computed(() => {
    const record = this.providers.all()[0];
    if (!record) {
      return null;
    }
    const host = hostOf(recordAddress(record));
    return `${host} · ${t(record.kind === 'm3u' ? 'onboarding.m3u' : record.kind === 'stalker' ? 'onboarding.portal' : 'onboarding.xtream')}`;
  });
  readonly guideCount = computed(() => this.sources.sources().length);
  readonly opensOnLastChannel = computed(() => opensLastChannel(this.settings.get(SETTING_KEYS.openLastChannel)));

  constructor() {
    if (!this.signedIn && !this.onboarding.shouldShow()) {
      void this.router.navigate(['/for-you'], { replaceUrl: true });
    }

    // Back goes to the step before, down to Welcome.
    inject(BackButtonService).bindTo(this.canGoBack, () => this.back());

    // A television starts each step on its first control: the step changes
    // within the page, so nothing else moves focus.
    effect(() => {
      this.step();
      if (!this.tv.isTelevision()) {
        return;
      }
      requestAnimationFrame(() => {
        const first = document.querySelector<HTMLElement>('[data-onboarding-first]');
        if (first) {
          this.tv.focusAsIfMoved(first);
        }
      });
    });

    // What a guide holds, read again whenever a download finishes.
    effect(() => {
      this.guide.loading();
      const ids = this.sources.sources().map(source => source.id);
      untracked(() => void this.readTotals(ids));
    });
  }

  chooseKind(kind: 'xtream' | 'm3u' | 'stalker'): void {
    this.kind.set(kind);
    this.found.set(null);
  }

  /** What was typed on a phone (PhoneFormOfferComponent): into the form, to be checked here as if typed. */
  fromPhone(fields: Record<string, string>): void {
    if (this.kind() === 'xtream') {
      this.serverUrl.set(fields['server'] ?? '');
      this.username.set(fields['username'] ?? '');
      this.password.set(fields['password'] ?? '');
    } else if (this.kind() === 'stalker') {
      this.portalUrl.set(fields['server'] ?? '');
      this.mac.set(fields['mac'] ?? '');
    } else {
      this.playlistUrl.set(fields['playlist'] ?? '');
    }
    this.found.set(null);
  }

  getStarted(): void {
    this.step.set('provider');
  }

  /** "I have an account": the sign-in page, and on a television back here for Starting up. */
  haveAccount(): void {
    this.onboarding.signingIn(this.tv.isTelevision());
    void this.router.navigate(['/sign-in']);
  }

  /**
   * Adds the provider and asks it for its category list once -- what the
   * library needs first anyway, so nothing extra is asked of it. Not
   * answering, it is taken back off, with its guide, and a dialog says so.
   */
  async checkProvider(): Promise<void> {
    if (this.found()) {
      this.next();
      return;
    }
    if (!this.filled() || this.checking()) {
      if (!this.filled()) {
        this.toasts.error(t('onboarding.notFilled'));
      }
      return;
    }
    const input: ProviderInput =
      this.kind() === 'xtream'
        ? { kind: 'xtream', label: '', serverUrl: this.serverUrl(), username: this.username(), password: this.password() }
        : this.kind() === 'stalker'
          ? { kind: 'stalker', label: '', portalUrl: this.portalUrl(), mac: this.mac() }
          : { kind: 'm3u', label: '', url: this.playlistUrl() };
    const host = hostOf(recordAddress(input));
    const tagsBefore = new Set(this.providers.all().map(record => record.tag));
    const sourcesBefore = new Set(this.sources.sources().map(source => source.id));

    this.checking.set(true);
    try {
      await this.providers.add(input);
      // Channels first; films, then shows, only for one with no channels -- a
      // playlist of films alone was refused as not reached (27 October).
      const count =
        (await this.categoryCount('live')) || (await this.categoryCount('vod')) || (await this.categoryCount('series'));
      if (!count) {
        throw new Error('No categories');
      }
      this.found.set({ host, categories: count });
    } catch (error) {
      const added = this.providers.all().find(record => !tagsBefore.has(record.tag));
      if (added) {
        await this.providers.remove(added).catch(() => undefined);
      }
      for (const source of this.sources.sources()) {
        if (!sourcesBefore.has(source.id)) {
          this.sources.remove(source.id);
        }
      }
      this.toasts.error(t('onboarding.notReached'), t('onboarding.notReachedBody', { host }), { detail: technicalDetail(error) });
    } finally {
      this.checking.set(false);
    }
  }

  /** How many categories of one kind the provider answered with, leaving out "all channels". */
  private async categoryCount(type: StreamType): Promise<number> {
    const categories = await firstValueFrom(this.xtream.getCategories(type).pipe(timeout(CHECK_TIMEOUT_MS)));
    return categories.filter(category => untagged(category.category_id).id !== ALL_CHANNELS_ID).length;
  }

  addShare(): void {
    const suggestion = this.share.suggestion();
    if (suggestion && !this.shareAdded()) {
      void this.onboarding.addGuide(suggestion.url, suggestion.label);
    }
  }

  /**
   * A guide by its address, checked and worded as the Guides page does: an
   * address that answers with no guide is taken off again. The fields are
   * emptied themselves as well as their signals: typed and sent in one go (a
   * paste and Enter, a script), the signal is back to '' before the view has
   * seen it change, and the text stayed in them.
   */
  async addOwnGuide(...fields: HTMLInputElement[]): Promise<void> {
    const url = this.guideUrl().trim();
    const problem = guideAddressProblem(url);
    if (problem) {
      this.toasts.error(t('guides.failed'), problem);
      return;
    }
    const typed = this.guideLabel().trim();
    this.guideUrl.set('');
    this.guideLabel.set('');
    fields.forEach(field => (field.value = ''));
    if (this.sources.sources().some(source => source.id === guideSourceId(url))) {
      return;
    }
    const failure = await this.onboarding.addGuide(url, typed || undefined);
    const source = this.sources.sources().find(entry => entry.id === guideSourceId(url));
    const label = guideName(source?.label ?? url);
    if (failure instanceof EmptyGuide) {
      if (source) {
        this.sources.remove(source.id);
      }
      this.toasts.error(t('guides.failed'), t('guides.emptyNotAdded', { label }));
    } else if (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      this.toasts.error(t('guides.failed'), t('guides.couldNotLoad', { label, reason: reason.length > 160 ? reason.slice(0, 160) + '…' : reason }));
    }
  }

  /** A guide's address typed on a phone (PhoneFormOfferComponent): into the fields, added with Add. */
  fromGuidePhone(fields: Record<string, string>): void {
    this.guideUrl.set(fields['guide'] ?? '');
    this.guideLabel.set(fields['name'] ?? '');
  }

  setPreview(on: boolean): void {
    this.settings.set(SETTING_KEYS.channelPreview, on ? 'on' : 'off');
  }

  /** The step after this one; Skip as well as Continue. */
  next(): void {
    const order: Step[] = ['welcome', ...this.numbered()];
    let at = order.indexOf(this.step()) + 1;
    // Nothing to read a guide for without a provider.
    if (order[at] === 'guide' && !this.providers.all().length) {
      at++;
    }
    this.step.set(order[Math.min(at, order.length - 1)]);
  }

  back(): void {
    const order: Step[] = ['welcome', ...this.numbered()];
    let at = order.indexOf(this.step()) - 1;
    if (order[at] === 'guide' && !this.providers.all().length) {
      at--;
    }
    this.step.set(order[Math.max(at, 0)]);
  }

  startWatching(): void {
    this.onboarding.finish();
    void this.router.navigate(['/for-you'], { replaceUrl: true });
  }

  syncWithAccount(): void {
    this.onboarding.finish();
    void this.router.navigate(['/sign-in'], { queryParams: { create: 1 } });
  }

  sourceState(id: string): { loading: number | null; totals: { channels: number; programmes: number } | null } {
    const loading = this.guide.loading();
    return {
      loading: loading?.sourceId === id ? loading.programmes : null,
      totals: this.totals().get(id) ?? null
    };
  }

  private async readTotals(ids: string[]): Promise<void> {
    const next = new Map<string, { channels: number; programmes: number }>();
    for (const id of ids) {
      const summary = await this.guide.summaryFor(id).catch(() => null);
      if (summary) {
        next.set(id, { channels: summary.channels ?? 0, programmes: summary.programmes ?? 0 });
      }
    }
    this.totals.set(next);
  }
}
