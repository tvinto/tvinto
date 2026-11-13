import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { StreamType } from '@shared/types';
import { XtreamService } from '../../services/xtream.service';
import { GuideService } from '../../services/guide.service';
import { GuideSourcesService, guideName } from '../../services/guide-sources.service';
import { DeviceSyncService } from '../../services/device-sync.service';
import { t } from '../../utils/i18n';

/** One thing in progress, as the notice draws it. */
export interface ActivityEntry {
  key: string;
  title: string;
  detail: string;
  /** How far, 0-100, where that is known; null for a bar that only says it is moving. */
  percent: number | null;
  /** Not started yet: no bar at all. */
  waiting: boolean;
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
 * What the app is bringing in, in one place: a strip at the top right of
 * every page, taking its own room above it, one entry per thing in progress -- the first sync after
 * signing in, a film, show or channel library, each guide downloading or
 * waiting its turn -- each gone when it is done, and the notice with them
 * (12 November: For You said it in sentences between its rows).
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
 * Nothing in it can be focused or pressed: on a television it must never take
 * a remote key or the focus. It sits above the page rather than over it, so
 * it covers no control anywhere.
 */
@Component({
  selector: 'app-activity',
  standalone: true,
  template: `
    @if (entries().length) {
      <div class="activity" role="status" aria-live="polite" [attr.aria-label]="label()" data-activity>
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
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ActivityComponent {
  private readonly xtream = inject(XtreamService);
  private readonly guide = inject(GuideService);
  private readonly guideSources = inject(GuideSourcesService);
  private readonly deviceSync = inject(DeviceSyncService);

  readonly label = computed(() => t('activity.label'));

  readonly entries = computed<ActivityEntry[]>(() => {
    const entries: ActivityEntry[] = [];

    if (this.deviceSync.firstSync()) {
      entries.push({ key: 'sync', title: t('activity.sync'), detail: '', percent: null, waiting: false });
    }

    const library = this.xtream.indexing();
    if (library) {
      const progress = this.xtream.indexProgress();
      entries.push({
        key: 'library-' + library,
        title: t(LIBRARY_TITLE[library]),
        detail: !progress
          ? t('activity.downloading')
          : progress.total === null
            ? t('activity.categoriesSoFar', { filed: progress.filed })
            : t('activity.categories', { filed: progress.filed, total: progress.total }),
        percent: progress?.total ? Math.min(100, (progress.filed / progress.total) * 100) : null,
        waiting: false
      });
    }

    const named = (sourceId: string) => {
      const source = this.guideSources.sources().find(one => one.id === sourceId);
      return source ? t('activity.guide', { name: guideName(source.label) }) : t('activity.guideUnnamed');
    };
    const loading = this.guide.loading();
    if (loading) {
      entries.push({
        key: 'guide-' + loading.sourceId,
        title: named(loading.sourceId),
        // Counted once the reader has channels; before that, all there is to
        // say is that it is coming in.
        detail: loading.channels
          ? t('activity.guideRead', { channels: loading.channels.toLocaleString(), size: megabytes(loading.chars) })
          : t('activity.downloading'),
        percent: null,
        waiting: false
      });
    }
    for (const sourceId of this.guide.queued()) {
      if (sourceId !== loading?.sourceId) {
        entries.push({ key: 'guide-' + sourceId, title: named(sourceId), detail: t('activity.waiting'), percent: null, waiting: true });
      }
    }

    return entries;
  });
}
