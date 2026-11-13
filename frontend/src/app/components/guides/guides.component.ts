import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideDownload,
  lucideGlobe,
  lucideLightbulb,
  lucideLoaderCircle,
  lucidePlus,
  lucideRefreshCw,
  lucideSatelliteDish,
  lucideTrash2
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { ConfirmService } from '../../services/confirm.service';
import { ToastService } from '../../services/toast.service';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { EmptyGuide, GuideLoadReport, GuideLoadSummary } from '@shared/xtream/guide';
import { GuideSource } from '@shared/xtream/guideSources';
import { epgShareCountryOfUrl, epgShareFor } from '@shared/xtream/epgShare';
import { epgShareName } from '../../utils/epg-share.utils';
import { EpgShareService } from '../../services/epg-share.service';
import { PhoneFormOfferComponent } from '../phone-form-offer/phone-form-offer.component';
import { GuideService } from '../../services/guide.service';
import {
  GuideSourcesService,
  PROVIDER_GUIDE_LABEL,
  guideAddressProblem,
  guideName,
  ProviderGuide
} from '../../services/guide-sources.service';
import { XtreamService } from '../../services/xtream.service';
import { AccountService } from '../../services/account.service';
import { t } from '../../utils/i18n';
import { TPipe } from '../../pipes/t.pipe';
import { ClockService } from '../../services/clock.service';
import { SlowWaitComponent } from '../slow-wait/slow-wait.component';

/** What a source's row needs to know beyond the source itself. */
interface SourceRow {
  source: GuideSource;
  /**
   * What this device holds for it, or null if it holds nothing.
   *
   * Kept by the store when a load finishes, so the counts are there on the
   * next launch too -- seeing them only while a guide loads is the one moment
   * they are least useful.
   */
  summary: GuideLoadSummary | null;
}

/**
 * The guides this account uses.
 *
 * Replaces the screen that fetched one feed and forgot it. A guide is not a
 * thing you look at once -- it is a thing the television listing draws from
 * every time it opens, so the address has to be kept and the download has to
 * be repeatable.
 *
 * Which device has actually downloaded which guide is not account state, so
 * "last loaded" is per row and per device, and a source added on the phone
 * arrives here as something offered rather than something already here.
 */
@Component({
  selector: 'app-guides',
  standalone: true,
  imports: [PhoneFormOfferComponent, SlowWaitComponent, TPipe, DecimalPipe, ReactiveFormsModule, NgIcon, HlmButton, HlmInput, HlmLabel, SettingGroupComponent, SettingRowComponent],
  providers: [
    provideIcons({
      lucideArrowLeft,
      lucideDownload,
      lucideGlobe,
      lucideLightbulb,
      lucideLoaderCircle,
      lucidePlus,
      lucideRefreshCw,
      lucideSatelliteDish,
      lucideTrash2
    })
  ],
  templateUrl: './guides.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GuidesComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly xtream = inject(XtreamService);
  readonly guide = inject(GuideService);
  readonly sources = inject(GuideSourcesService);
  /** EPG Share's guide for the device's country, offered as a pill. */
  readonly share = inject(EpgShareService);

  /** Whether guides may be added, switched off and removed: not by a kid at its own device. */
  readonly canChangeSetup = inject(AccountService).canChangeSetup;

  readonly form = new FormGroup({
    url: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    label: new FormControl('', { nonNullable: true })
  });

  readonly rows = signal<SourceRow[]>([]);
  /** Whether the guides on this device have been read once: until then there is no count to give. */
  readonly rowsLoaded = signal(false);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  /**
   * The guide loading now, whoever started it: a button here, or the reload a
   * guide gets on its own when it is running out (GuideReloadService). Only
   * this page's own loads used to count, so during a reload in the background
   * the page went on showing the old load times, offered Refresh, and answered
   * it with "A guide is already loading" (the TV emulator, 4 October).
   */
  readonly busy = computed(() => this.guide.loading()?.sourceId ?? null);
  // Its buttons say so with aria-disabled rather than `disabled`, and each
  // handler refuses while it lasts: a disabled button cannot keep focus, so
  // the Refresh a remote had just pressed dropped it to the page, and the
  // next press of the D-pad had nothing to move from.
  readonly lastReport = signal<GuideLoadReport | null>(null);

  /** Whether adding a provider guide is even possible on this build. */
  readonly canUseProviderGuide = this.guide.supported;

  /** "Not now" on the download offer. For this visit only: it comes back next time. */
  readonly offerDismissed = signal(false);

  /** Each provider's own guide. */
  readonly providerGuides = signal<ProviderGuide[]>([]);

  /** The providers' guides not in the list yet, for a button each -- with several providers. */
  readonly offeredGuides = computed(() =>
    this.providerGuides().filter(guide => !this.sources.sources().some(source => source.id === guide.id))
  );

  /** Each row as drawn: its name in the language in use, and when it was last loaded. */
  readonly shownRows = computed(() => {
    // Read for the turn of the minute, and so of the day: "today" becomes "yesterday".
    this.now();
    return this.rows().map(row => ({
      ...row,
      label: this.labelOf(row.source),
      loaded: row.summary ? this.lastLoaded(row.summary.loadedAt) : ''
    }));
  });

  /** Guides this device has not loaded, by name. */
  readonly missing = computed(() => this.sources.missingHere().map(source => ({ source, label: this.labelOf(source) })));

  /** The provider's guides on offer, by name. */
  readonly offered = computed(() => this.offeredGuides().map(guide => ({ guide, name: this.guideName(guide.label) })));

  private readonly now = inject(ClockService).minute;

  /** How many sources this device holds a copy of, for "2 on this device". */
  readonly loadedHereCount = computed(() => this.rows().filter(row => row.summary).length);

  /** "today at 06:12", "yesterday at 21:40", "3 days ago". */
  private lastLoaded(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) {
      return t('guides.unknownTime');
    }
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const days = Math.floor((startOfToday.getTime() - at.getTime()) / 86_400_000) + 1;
    const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    if (at.getTime() >= startOfToday.getTime()) {
      return t('guides.todayAt', { time: clock });
    }
    return days <= 1 ? t('guides.yesterdayAt', { time: clock }) : t('guides.daysAgo', { count: days });
  }

  /** A source's name. The provider's own guide is stored under an English name, and shown in the language in use. */
  private labelOf(source: GuideSource): string {
    return this.guideName(source.label);
  }

  private guideName(label: string): string {
    return guideName(label);
  }

  constructor() {
    // Whatever load ends -- one started here, or one in the background --
    // what it changed is read again: load times, channel and programme counts.
    let wasLoading = this.guide.isLoading();
    effect(() => {
      const loading = this.guide.isLoading();
      if (wasLoading && !loading) {
        untracked(() => void this.refreshRows());
      }
      wasLoading = loading;
    });
  }

  ngOnInit(): void {
    if (!this.xtream.isAuthenticated()) {
      void this.router.navigate(['/']);
      return;
    }

    void this.refreshRows();
    void this.sources.providerGuides().then(guides => this.providerGuides.set(guides));
  }

  /** To the page Guides was opened from -- the header offers it on every one -- or Live TV without one. */
  goBack(): void {
    if (history.length > 1) {
      history.back();
    } else {
      void this.router.navigate(['/tv']);
    }
  }

  async add(): Promise<void> {
    if (this.busy()) {
      return;
    }
    const url = this.form.controls.url.value.trim();
    const problem = guideAddressProblem(url);
    if (problem) {
      this.failed(problem);
      return;
    }
    const typed = this.form.controls.label.value.trim();
    // EPG Share's guide, under the name the pill filled in: stored under its
    // English name, which every device shows in its own language.
    const share = epgShareFor(epgShareCountryOfUrl(url));
    const label = share && typed === epgShareName(share.country) ? share.label : typed;

    this.sources.add(url, label || undefined);
    this.form.reset({ url: '', label: '' });
    await this.refreshRows();

    // Added and then loaded, rather than added and left dark. A source that is
    // listed but empty looks like a broken one.
    const added = this.sources.sources().find(source => source.url === url);
    if (added && (await this.load(added, true)) instanceof EmptyGuide) {
      // Not a guide at all -- a web page, a playlist, an error -- so not one
      // to keep: listed, it read as a guide "added on another device" that
      // this one had not loaded yet.
      this.sources.remove(added.id);
      await this.refreshRows();
    }
  }

  /**
   * Adds the subscription's own guide.
   *
   * One button rather than a URL to find, because the app already holds the
   * credentials it is built from -- and because on a television, typing a URL
   * with a password in it is close to impossible.
   */
  async addProviderGuide(): Promise<void> {
    if (this.busy()) {
      return;
    }

    const added = await this.sources.addProviderGuide();
    if (!added) {
      this.failed(t('guides.noSubscription'));
      return;
    }

    await this.refreshRows();
    const source = this.sources.sources().find(entry => entry.label === PROVIDER_GUIDE_LABEL);
    if (source) {
      await this.load(source);
    }
  }

  /** Adds one provider's own guide, and loads it. */
  async addGuideOf(guide: ProviderGuide): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.sources.add(guide.url, guide.label);
    await this.refreshRows();
    const source = this.sources.sources().find(entry => entry.id === guide.id);
    if (source) {
      await this.load(source);
    }
  }

  /** Loads a source; hands back what went wrong, if anything. `justAdded` says which words an empty answer gets. */
  async load(source: GuideSource, justAdded = false): Promise<unknown> {
    if (this.busy()) {
      return null;
    }

    try {
      const report = await this.guide.load(source.id, source.url);
      this.lastReport.set(report);
      const loaded = t('guides.loaded', {
        channels: t('guides.channels', { count: report.channels }),
        programmes: t('guides.programmes', { count: report.programmes })
      });
      this.toast.success(this.labelOf(source), report.dropped > 0 ? `${loaded} ${t('guides.skipped', { count: report.dropped })}` : loaded);
      return null;
    } catch (failure) {
      if (failure instanceof EmptyGuide) {
        this.failed(t(justAdded ? 'guides.emptyNotAdded' : 'guides.emptyKept', { label: this.labelOf(source) }));
        return failure;
      }
      // Cut short: a database error quotes the statement it failed on, and an
      // insert of a thousand programmes filled the screen with guide text.
      const reason = failure instanceof Error ? failure.message : String(failure);
      this.failed(
        t('guides.couldNotLoad', { label: this.labelOf(source), reason: reason.length > 160 ? reason.slice(0, 160) + '…' : reason })
      );
      return failure;
    }
  }

  async toggle(source: GuideSource): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.sources.setEnabled(source.id, !source.enabled);
    await this.refreshRows();
  }

  /** Asks first (DS-TV-8): on 31 October Remove took a guide away at once. */
  async remove(source: GuideSource): Promise<void> {
    if (this.busy()) {
      return;
    }
    const sure = await this.confirm.ask({
      title: t('guides.removeTitle', { label: this.labelOf(source) }),
      message: t('guides.removeBody'),
      confirmLabel: t('common.remove'),
      destructive: true
    });
    if (!sure || this.busy()) {
      return;
    }
    this.sources.remove(source.id);
    await this.refreshRows();
  }

  /** Fills in what this particular device has, which the account does not know. */
  private async refreshRows(): Promise<void> {
    const rows: SourceRow[] = [];

    for (const source of this.sources.sources()) {
      rows.push({ source, summary: await this.guide.summaryFor(source.id) });
    }

    this.rows.set(rows);
    this.rowsLoaded.set(true);
    await this.sources.refreshMissing();
  }

  /** "24 channels · 588 programmes · last loaded today at 23:11", or that it is off or not here. */
  rowLine(row: { source: GuideSource; summary: GuideLoadSummary | null; loaded: string }): string {
    if (!row.source.enabled) {
      return t('guides.off');
    }
    if (!row.summary) {
      return t('guides.notLoaded');
    }
    return [
      t('guides.channels', { count: row.summary.channels }),
      t('guides.programmes', { count: row.summary.programmes }),
      t('guides.lastLoaded', { when: row.loaded })
    ].join(' · ');
  }

  /**
   * EPG Share's guide for the device's country (DS-TV-7), filled into the form
   * rather than given as an address to copy. With no guide for the country,
   * the pill asks for one first.
   */
  async useEpgShare(): Promise<void> {
    if (!this.share.suggestion() && !(await this.share.chooseCountry())) {
      return;
    }
    const suggestion = this.share.suggestion();
    if (suggestion) {
      this.form.patchValue({ url: suggestion.url, label: epgShareName(suggestion.country) });
    }
  }

  /** What was typed on a phone (PhoneFormOfferComponent): into the form, added only with Add. */
  fromPhone(fields: Record<string, string>): void {
    this.form.patchValue({ url: fields['guide'] ?? '', label: fields['name'] ?? '' });
  }

  /** A failure, in the error dialog as everywhere (5 October). */
  private failed(message: string): void {
    this.toast.error(t('guides.failed'), message);
  }
}
