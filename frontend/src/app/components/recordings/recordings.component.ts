import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCircleStop, lucidePlay, lucideTrash2 } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { Recording, RecordingVolume } from '@shared/recording/recording';
import { RecordingsService } from '../../services/recordings.service';
import { NativePlayerService } from '../../services/native-player.service';
import { ConfirmService } from '../../services/confirm.service';
import { ToastService } from '../../services/toast.service';
import { TPipe } from '../../pipes/t.pipe';
import { t } from '../../utils/i18n';
import { describePlaybackFailure } from '../../utils/failure-messages.utils';

/** How long recordings may be kept, in days; beyond the last is "until deleted". */
const KEEP_STEPS = [3, 7, 14, 30, 60, 90];

/**
 * What this device recorded (private plan: recording), newest first: play,
 * stop one still recording, delete. Recordings stay on the device that made
 * them.
 */
@Component({
  selector: 'app-recordings',
  standalone: true,
  imports: [TPipe, NgIcon, HlmButton],
  providers: [provideIcons({ lucideCheck, lucideCircleStop, lucidePlay, lucideTrash2 })],
  template: `
    <section class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8" data-recordings>
      <header class="flex flex-col gap-1">
        <h1 class="text-2xl font-bold">{{ 'recordings.title' | t }}</h1>
        <p class="text-sm text-muted-foreground">{{ 'recordings.lead' | t }}</p>
      </header>

      @if (!recordings.available() && !recordings.planned().length) {
        <p class="text-muted-foreground">{{ 'recordings.notHere' | t }}</p>
      } @else if (!recordings.recordings().length && !recordings.planned().length) {
        <p class="text-muted-foreground">{{ 'recordings.none' | t }}</p>
      } @else {
        @if (recordings.planned().length) {
          <h2 class="text-sm font-semibold tracking-wider text-muted-foreground uppercase">{{ 'recordings.upcoming' | t }}</h2>
          <ul class="flex flex-col gap-2" data-bookings>
            @for (one of recordings.planned(); track one.id) {
              <li class="flex flex-wrap items-center gap-4 rounded-xl bg-[var(--glass-quiet)] px-4 py-3">
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p class="truncate font-semibold">{{ one.title }}</p>
                  <p class="truncate text-sm text-muted-foreground">
                    {{ one.channel }} · {{ when(one.startMs) }}@if (one.device !== recordings.deviceKey) { · {{ 'recordings.on' | t: { device: recordings.deviceName(one.device) } }}}
                  </p>
                </div>
                <button hlmBtn variant="quiet" size="sm" type="button" (click)="cancel(one.id)">{{ 'recordings.cancelBooking' | t }}</button>
              </li>
            }
          </ul>
        }
        <ul class="flex flex-col gap-2">
          @for (one of recordings.recordings(); track one.id) {
            <li class="flex flex-wrap items-center gap-4 rounded-xl bg-[var(--glass-quiet)] px-4 py-3" data-recording>
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <p class="truncate font-semibold">{{ one.title }}</p>
                <p class="truncate text-sm text-muted-foreground">{{ lineFor(one) }}</p>
              </div>
              @if (one.state === 'recording') {
                <span class="rounded-full bg-[var(--live,#e5484d)] px-2 py-0.5 text-xs font-bold text-white">{{ 'recordings.now' | t }}</span>
                <button hlmBtn variant="secondary" size="sm" type="button" (click)="stop(one)">
                  <ng-icon name="lucideCircleStop" />{{ 'recordings.stop' | t }}
                </button>
              } @else {
                <button hlmBtn variant="primary" size="sm" type="button" [disabled]="one.state === 'failed'" (click)="play(one)">
                  <ng-icon name="lucidePlay" />{{ 'recordings.play' | t }}
                </button>
                <button hlmBtn variant="quiet" size="sm" type="button" (click)="remove(one)">
                  <ng-icon name="lucideTrash2" />{{ 'recordings.delete' | t }}
                </button>
              }
            </li>
          }
        </ul>
      }

      @if (recordings.volumes().length > 1) {
        <!-- This device's own: a USB drive or memory card, when one is in. -->
        <h2 class="text-sm font-semibold tracking-wider text-muted-foreground uppercase">{{ 'recordings.where' | t }}</h2>
        <ul class="flex flex-col gap-2" data-recording-volumes>
          @for (volume of recordings.volumes(); track volume.id) {
            <li>
              <button
                type="button"
                class="flex w-full flex-wrap items-center gap-4 rounded-xl bg-[var(--glass-quiet)] px-4 py-3 text-left"
                [attr.aria-pressed]="volume.chosen"
                (click)="recordings.chooseVolume(volume.id)"
              >
                <span class="min-w-0 flex-1 font-semibold">{{ volumeName(volume) }}</span>
                <span class="text-sm text-muted-foreground tabular-nums">{{ 'recordings.free' | t: { size: size(volume.freeBytes) } }}</span>
                @if (volume.chosen) {
                  <ng-icon name="lucideCheck" />
                }
              </button>
            </li>
          }
        </ul>
      }

      @if (recordings.rules().length) {
        <h2 class="text-sm font-semibold tracking-wider text-muted-foreground uppercase">{{ 'recordings.rules' | t }}</h2>
        <ul class="flex flex-col gap-2" data-recording-rules>
          @for (rule of recordings.rules(); track rule.id) {
            <li class="flex flex-wrap items-center gap-4 rounded-xl bg-[var(--glass-quiet)] px-4 py-3">
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <p class="truncate font-semibold">{{ rule.title }}</p>
                <p class="truncate text-sm text-muted-foreground">{{ 'recordings.ruleLine' | t: { channel: rule.channel, device: recordings.deviceName(rule.device) } }}</p>
              </div>
              <button hlmBtn variant="quiet" size="sm" type="button" (click)="stopEvery(rule.id)">{{ 'recordings.stopEvery' | t }}</button>
            </li>
          }
        </ul>
      }

      @if (recordings.available() || recordings.planned().length) {
        <!-- For the account: every device records with these. -->
        <h2 class="mt-2 text-sm font-semibold tracking-wider text-muted-foreground uppercase">{{ 'recordings.optionsTitle' | t }}</h2>
        <ul class="flex flex-col gap-2" data-recording-options>
          @for (row of optionRows(); track row.key) {
            <li class="flex flex-wrap items-center gap-4 rounded-xl bg-[var(--glass-quiet)] px-4 py-3">
              <p class="min-w-0 flex-1 font-semibold">{{ row.label | t }}</p>
              <button hlmBtn variant="quiet" size="sm" type="button" [attr.aria-label]="'recordings.less' | t" [disabled]="!row.canLess" (click)="step(row.key, -1)">−</button>
              <span class="min-w-[6em] text-center tabular-nums" [attr.data-option]="row.key">{{ row.shown }}</span>
              <button hlmBtn variant="quiet" size="sm" type="button" [attr.aria-label]="'recordings.more' | t" [disabled]="!row.canMore" (click)="step(row.key, 1)">+</button>
            </li>
          }
        </ul>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RecordingsComponent {
  readonly recordings = inject(RecordingsService);
  private readonly player = inject(NativePlayerService);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);

  constructor() {
    void this.recordings.refresh();
  }

  when(ms: number): string {
    return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /** The three settings as rows: minutes before, minutes after, days kept. */
  readonly optionRows = computed(() => {
    const now = this.recordings.options();
    const minutes = (count: number) => t('recordings.minutes', { count });
    const keep = now.keepDays === null ? t('recordings.keepAlways') : t('recordings.keepDays', { count: now.keepDays });
    return [
      { key: 'beforeMin' as const, label: 'recordings.before', shown: minutes(now.beforeMin), canLess: now.beforeMin > 0, canMore: now.beforeMin < 30 },
      { key: 'afterMin' as const, label: 'recordings.after', shown: minutes(now.afterMin), canLess: now.afterMin > 0, canMore: now.afterMin < 60 },
      { key: 'keepDays' as const, label: 'recordings.keep', shown: keep, canLess: now.keepDays !== KEEP_STEPS[0], canMore: now.keepDays !== null }
    ];
  });

  /** One step up or down: minutes by one, then five; days through KEEP_STEPS, after which is "until deleted". */
  step(key: 'beforeMin' | 'afterMin' | 'keepDays', by: 1 | -1): void {
    const now = this.recordings.options();
    if (key === 'keepDays') {
      const steps: Array<number | null> = [...KEEP_STEPS, null];
      const at = Math.max(0, steps.indexOf(now.keepDays));
      this.recordings.setOptions({ ...now, keepDays: steps[Math.min(steps.length - 1, Math.max(0, at + by))] });
      return;
    }
    const value = now[key];
    const size = value + by > 5 || (by < 0 && value > 5) ? 5 : 1;
    this.recordings.setOptions({ ...now, [key]: Math.max(0, value + by * size) });
  }

  volumeName(volume: RecordingVolume): string {
    return volume.label || t(volume.removable ? 'recordings.removable' : 'recordings.builtIn');
  }

  size(bytes: number): string {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 1e6))} MB`;
  }

  stopEvery(id: string): void {
    void this.recordings.stopEvery(id);
  }

  cancel(id: string): void {
    void this.recordings.cancelBooking(id);
  }

  /** "HRT 1 · Tue 10 Nov 20:15 · 1.2 GB", or why it failed. */
  lineFor(one: Recording): string {
    const when = new Date(one.startedAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const size = one.bytes >= 1e9 ? `${(one.bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(one.bytes / 1e6))} MB`;
    const tail = one.state === 'failed' ? t('recordings.failed', { why: one.failure ?? '' }) : size;
    return [one.channel, when, tail].filter(Boolean).join(' · ');
  }

  async play(one: Recording): Promise<void> {
    const result = await this.player.play({
      url: one.path,
      title: one.title,
      startAtSeconds: 0,
      presentation: { kind: 'film', heading: one.channel, title: one.title, poster: null }
    });
    if (result?.errorCode) {
      const said = describePlaybackFailure(result.errorCode, t('recordings.thisOne'));
      this.toasts.error(said.title, said.message, { detail: said.detail });
    }
  }

  stop(one: Recording): void {
    void this.recordings.stop(one.id);
  }

  async remove(one: Recording): Promise<void> {
    if (await this.confirm.ask({ title: t('recordings.deleteTitle', { title: one.title }), confirmLabel: t('recordings.delete'), destructive: true })) {
      await this.recordings.remove(one.id);
    }
  }
}
