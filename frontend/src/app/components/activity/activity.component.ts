import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { StreamType } from '@shared/types';
import { XtreamService } from '../../services/xtream.service';
import { GuideService } from '../../services/guide.service';
import { GuideSourcesService, guideName } from '../../services/guide-sources.service';
import { DeviceSyncService } from '../../services/device-sync.service';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { t } from '../../utils/i18n';

/** One thing in progress, as the panel draws it. */
export interface ActivityEntry {
  key: string;
  title: string;
  detail: string;
  /** How far, 0-100, where that is known; null for a bar that only says it is moving. */
  percent: number | null;
  /** Not started yet: no bar at all. */
  waiting: boolean;
  /** What the pill says when this is the only thing loading. */
  short: string;
}

const LIBRARY_TITLE: Record<StreamType, string> = {
  live: 'activity.library.live',
  vod: 'activity.library.vod',
  series: 'activity.library.series'
};

/** Megabytes, to one decimal under ten. */
function megabytes(chars: number): string {
  const mb = chars / 1_000_000;
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

/**
 * What the app is bringing in, in one place: a small pill in the top bar, left
 * of Guides, with a ring and one short line -- the one thing loading, or how
 * many things are -- and a panel under it with the whole list when it is
 * clicked. An entry is one thing in progress -- the first sync after signing
 * in, a film, show or channel library, each guide downloading or waiting its
 * turn -- each gone when it is done, and the pill with the last.
 *
 * It was a strip of its own under the bar (13 November), which pushed every
 * page down while anything loaded, and before that a floating card, which over
 * For You covered "Browse the guide". The pill lives in room the bar already
 * has, so it covers nothing; only the panel lies over the page, and only
 * because somebody opened it. It closes on a click outside it, or Esc. On a
 * phone, where the bar is tight, the pill is only its ring.
 *
 * Where each number comes from:
 * - a library: categories written of how many the download held
 *   (`XtreamService.indexProgress`, from `Catalogue.index`); while the one
 *   request is still downloading, nothing is known and the bar only moves.
 *   On Android the listing is read a category at a time and the total is not
 *   known until the end, so it counts categories without a bar's length.
 * - a guide: channels and programmes read, and how much of the document
 *   (`GuideService.loading`, from `loadGuide`'s progress). A guide arrives
 *   compressed and with no length, so the bar only moves.
 * - the first sync: one request, so the bar only moves.
 *
 * A television hides the bar, and the shell puts the pill in the corner of the
 * page instead. There it is only the pill: nothing in it can be focused or
 * pressed, so it never takes a remote key or the focus.
 */
@Component({
  selector: 'app-activity',
  standalone: true,
  imports: [NgTemplateOutlet],
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onEscape()'
  },
  template: `
    @if (entries().length) {
      <div class="activity" data-activity>
        @if (tv.isTelevision()) {
          <div class="activity-pill" role="status" aria-live="polite" [attr.aria-label]="label()" data-activity-pill>
            <ng-container *ngTemplateOutlet="ring" />
            <span class="activity-pill-text">{{ summary() }}</span>
          </div>
        } @else {
          <button
            #pill
            type="button"
            class="activity-pill"
            data-activity-pill
            aria-controls="activity-panel"
            [attr.aria-expanded]="open()"
            [title]="openLabel()"
            (click)="toggle()"
          >
            <ng-container *ngTemplateOutlet="ring" />
            <span class="activity-pill-text" role="status" aria-live="polite">{{ summary() }}</span>
          </button>
          @if (open()) {
            <div id="activity-panel" class="activity-panel" role="region" [attr.aria-label]="label()" data-activity-panel>
              @for (entry of entries(); track entry.key) {
                <div class="activity-entry" [attr.data-activity-entry]="entry.key">
                  <p class="activity-title">{{ entry.title }}</p>
                  @if (entry.detail) {
                    <p class="activity-detail">{{ entry.detail }}</p>
                  }
                  @if (!entry.waiting) {
                    <span class="activity-track" aria-hidden="true">
                      @if (entry.percent !== null) {
                        <span class="activity-fill" [style.width.%]="entry.percent"></span>
                      } @else {
                        <span class="activity-fill activity-fill-moving"></span>
                      }
                    </span>
                  }
                </div>
              }
            </div>
          }
        }
      </div>
    }

    <!-- Filled as far as it has got when one thing is loading and that is
         known; otherwise a short arc turning. pathLength makes the dash a
         percentage. -->
    <ng-template #ring>
      <svg class="activity-ring" viewBox="0 0 20 20" aria-hidden="true" [class.activity-ring-moving]="ringPercent() === null">
        <circle class="activity-ring-track" cx="10" cy="10" r="8" />
        <circle class="activity-ring-fill" cx="10" cy="10" r="8" pathLength="100" [attr.stroke-dashoffset]="ringOffset()" />
      </svg>
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ActivityComponent {
  private readonly xtream = inject(XtreamService);
  private readonly guide = inject(GuideService);
  private readonly guideSources = inject(GuideSourcesService);
  private readonly deviceSync = inject(DeviceSyncService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly pill = viewChild<ElementRef<HTMLButtonElement>>('pill');
  readonly tv = inject(TvNavigationService);

  readonly label = computed(() => t('activity.label'));
  readonly openLabel = computed(() => t('activity.open'));

  readonly entries = computed<ActivityEntry[]>(() => {
    const entries: ActivityEntry[] = [];

    if (this.deviceSync.firstSync()) {
      entries.push({
        key: 'sync',
        title: t('activity.sync'),
        detail: '',
        percent: null,
        waiting: false,
        short: t('activity.short.sync')
      });
    }

    const library = this.xtream.indexing();
    if (library) {
      const progress = this.xtream.indexProgress();
      const title = t(LIBRARY_TITLE[library]);
      entries.push({
        key: 'library-' + library,
        title,
        detail: !progress
          ? t('activity.downloading')
          : progress.total === null
            ? t('activity.categoriesSoFar', { filed: progress.filed })
            : t('activity.categories', { filed: progress.filed, total: progress.total }),
        percent: progress?.total ? Math.min(100, (progress.filed / progress.total) * 100) : null,
        waiting: false,
        short: title
      });
    }

    const named = (sourceId: string) => {
      const source = this.guideSources.sources().find(one => one.id === sourceId);
      return source ? t('activity.guide', { name: guideName(source.label) }) : t('activity.guideUnnamed');
    };
    const loading = this.guide.loading();
    if (loading) {
      const title = named(loading.sourceId);
      entries.push({
        key: 'guide-' + loading.sourceId,
        title,
        // Counted once the reader has channels; before that, all there is to
        // say is that it is coming in.
        detail: loading.channels
          ? t('activity.guideRead', { channels: loading.channels.toLocaleString(), size: megabytes(loading.chars) })
          : t('activity.downloading'),
        percent: null,
        waiting: false,
        short: loading.channels ? t('activity.short.guide', { channels: loading.channels.toLocaleString() }) : title
      });
    }
    for (const sourceId of this.guide.queued()) {
      if (sourceId !== loading?.sourceId) {
        const title = named(sourceId);
        entries.push({ key: 'guide-' + sourceId, title, detail: t('activity.waiting'), percent: null, waiting: true, short: title });
      }
    }

    return entries;
  });

  /** Whether the panel is open. */
  readonly open = signal(false);

  constructor() {
    // Shut once nothing is loading, so a panel left open does not come back
    // by itself with the next load. An effect rather than a linkedSignal: a
    // linkedSignal is worked out only when read, and while nothing loads the
    // template does not read it, so it never saw the empty spell.
    effect(() => {
      if (!this.entries().length) {
        this.open.set(false);
      }
    });
  }

  /** The pill's one line. */
  readonly summary = computed(() => {
    const entries = this.entries();
    return entries.length === 1 ? entries[0].short : t('activity.many', { count: entries.length });
  });

  /** How far the ring is filled: known only when one thing is loading and it says. */
  readonly ringPercent = computed(() => {
    const entries = this.entries();
    return entries.length === 1 ? entries[0].percent : null;
  });

  /** Of a ring 100 long: the gap after the fill, or a 28-long arc while turning. */
  readonly ringOffset = computed(() => {
    const percent = this.ringPercent();
    return percent === null ? 72 : 100 - percent;
  });

  toggle(): void {
    this.open.update(open => !open);
  }

  onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.open.set(false);
    }
  }

  onEscape(): void {
    if (this.open()) {
      this.open.set(false);
      this.pill()?.nativeElement.focus();
    }
  }
}
