import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideLoaderCircle } from '@ng-icons/lucide';
import { TPipe } from '../../pipes/t.pipe';
import { t } from '../../utils/i18n';
import { FirstLoadService, LoadPart, PartView } from '../../services/first-load.service';

const LABEL: Record<LoadPart, string> = { live: 'firstLoad.channels', vod: 'firstLoad.films', series: 'firstLoad.shows', guide: 'firstLoad.guide' };

/**
 * What a first load has brought in so far (FirstLoadService, card 42): a
 * line under the steps of the walk-through, and on its last screen (`full`)
 * a row a part with a rough time left. Shows nothing until a load begins.
 */
@Component({
  selector: 'app-first-load-strip',
  standalone: true,
  imports: [TPipe, NgIcon],
  providers: [provideIcons({ lucideCheck, lucideLoaderCircle })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (load.started()) {
      @if (full()) {
        <div class="flex flex-col" role="status" data-first-load>
          @for (one of load.parts(); track one.part) {
            <div class="flex items-center gap-3 border-b border-border py-3" [attr.data-first-load-part]="one.part">
              <span class="flex size-4 shrink-0 items-center justify-center">
                @if (one.state === 'done') {
                  <ng-icon name="lucideCheck" size="16" class="text-live" />
                } @else if (one.state === 'loading') {
                  <ng-icon name="lucideLoaderCircle" size="16" class="animate-spin" />
                }
              </span>
              <span class="min-w-0 flex-1 truncate text-sm" [class.text-muted-foreground]="one.state === 'waiting'">{{ label(one) }}</span>
              <span class="shrink-0 text-sm font-semibold tabular-nums">{{ amount(one) }}</span>
            </div>
          }
          @if (timeLeft(); as left) {
            <p class="pt-3 text-sm text-muted-foreground" data-first-load-left>{{ left }}</p>
          }
          @if (load.retrying()) {
            <p class="pt-3 text-sm text-muted-foreground">{{ 'firstLoad.retrying' | t }}</p>
          } @else if (load.failed()) {
            <p class="pt-3 text-sm text-muted-foreground">{{ 'firstLoad.failed' | t }}</p>
          }
        </div>
      } @else {
        <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums" role="status" data-first-load-strip>
          @for (one of load.parts(); track one.part) {
            <span class="flex items-center gap-1" [class.text-foreground]="one.state === 'loading'" [attr.data-first-load-part]="one.part">
              @if (one.state === 'done') {
                <ng-icon name="lucideCheck" size="12" class="text-live" />
              } @else if (one.state === 'loading') {
                <ng-icon name="lucideLoaderCircle" size="12" class="animate-spin" />
              }
              {{ label(one) }}
              @if (amount(one); as shown) {
                <span class="font-semibold">{{ shown }}</span>
              }
            </span>
          }
        </p>
      }
    }
  `
})
export class FirstLoadStripComponent {
  readonly load = inject(FirstLoadService);
  /** The last screen's view: a row a part, time left, and what went wrong. */
  readonly full = input(false);

  readonly timeLeft = computed(() => {
    const seconds = this.load.secondsLeft();
    if (seconds === null) {
      return null;
    }
    return seconds < 60 ? t('firstLoad.underMinute') : t('firstLoad.minutesLeft', { count: Math.round(seconds / 60) });
  });

  label(one: PartView): string {
    return t(LABEL[one.part]);
  }

  /** Titles so far, or the listing's megabytes while it downloads; nothing when not known. */
  amount(one: PartView): string {
    if (one.count !== null) {
      return t('firstLoad.count', { count: one.count });
    }
    if (one.bytes !== null && one.bytes >= 100_000) {
      return t('firstLoad.megabytes', { size: Math.round(one.bytes / 100_000) / 10 });
    }
    return one.state === 'failed' ? t('firstLoad.notIn') : '';
  }
}
