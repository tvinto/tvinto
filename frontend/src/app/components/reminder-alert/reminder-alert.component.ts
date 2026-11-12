import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { RemindersService } from '../../services/reminders.service';
import { BackButtonService } from '../../services/back-button.service';
import { FocusScopeDirective } from '../../directives/focus-scope.directive';
import { TPipe } from '../../pipes/t.pipe';
import { clockTime } from '../../utils';
import { ClockService } from '../../services/clock.service';

/**
 * A reminder going off: what is starting, on which channel, and Watch already
 * in focus -- one press of OK on a remote switches to it. Back or Dismiss puts
 * it away. One at a time, oldest first.
 */
@Component({
  selector: 'app-reminder-alert',
  standalone: true,
  imports: [TPipe, HlmButton, FocusScopeDirective],
  template: `
    @if (shown(); as reminder) {
      <div
        class="fixed inset-0 z-[65] flex items-end justify-center bg-[color-mix(in_oklch,var(--background)_88%,transparent)] p-4 md:items-center"
        data-focus-scope
        data-reminder-alert
        data-enter="sheet"
        role="alertdialog"
        aria-modal="true"
        [attr.aria-label]="'remind.starting' | t: { title: reminder.title }"
      >
        <div class="flex w-full max-w-md items-center gap-4 rounded-xl bg-card p-5 shadow-2xl">
          @if (reminder.icon) {
            <img [src]="reminder.icon" alt="" class="h-14 w-14 shrink-0 rounded-md bg-background-2 object-contain p-1" />
          }
          <div class="min-w-0 flex-1">
            <p class="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {{ (heading()?.started ? 'remind.onNow' : 'remind.soon') | t: { time: heading()?.time } }}
            </p>
            <h2 class="mt-0.5 text-lg leading-snug font-bold break-words">{{ reminder.title }}</h2>
            <p class="truncate text-sm text-muted-foreground">{{ reminder.channel }}</p>
            <div class="mt-3 flex gap-2">
              <button hlmBtn variant="primary" type="button" data-focus-first (click)="reminders.watch(reminder)">{{ 'remind.watch' | t }}</button>
              <button hlmBtn variant="secondary" type="button" (click)="reminders.dismiss(reminder)">{{ 'remind.dismiss' | t }}</button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReminderAlertComponent {
  readonly reminders = inject(RemindersService);
  readonly shown = computed(() => this.reminders.ringing()[0] ?? null);

  /**
   * What had focus when it went off, for focus to go back to when it is put
   * away -- on a television, a remote whose focus was left on nothing goes
   * nowhere. Watch navigates instead, and the page it opens places focus.
   */
  private returnTo: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const open = this.shown() !== null;
      untracked(() => {
        if (open && !this.returnTo) {
          this.returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        } else if (!open && this.returnTo) {
          const back = this.returnTo;
          this.returnTo = null;
          requestAnimationFrame(() => back.isConnected && !document.querySelector('[data-focus-scope]:focus-within') && back.focus({ preventScroll: true }));
        }
      });
    });

    inject(BackButtonService).bindTo(
      computed(() => this.shown() !== null),
      () => {
        const reminder = this.shown();
        if (reminder) {
          this.reminders.dismiss(reminder);
        }
      }
    );
  }

  /** Whether the one shown has started, and when it starts: to the minute. */
  readonly heading = computed(() => {
    const reminder = this.shown();
    // Read for the minute's turn, which is when "soon" can become "on now".
    this.now();
    return reminder ? { started: Date.now() >= reminder.start, time: clockTime(reminder.start) } : null;
  });
  private readonly now = inject(ClockService).minute;
}
