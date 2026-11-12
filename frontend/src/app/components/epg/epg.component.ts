import { ToastService } from '../../services/toast.service';
import { RecordingsService } from '../../services/recordings.service';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked
} from '@angular/core';
import { calculateUnixProgress, clockTime, millisecondsOf } from '../../utils';
import { EpgStore } from '../../stores/epg.store';
import { EPGProgram, Stream } from '@shared/types';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBell, lucideCalendarOff, lucideCircleDot, lucideHistory, lucideLoaderCircle, lucideRepeat, lucideRotateCcw } from '@ng-icons/lucide';
import { RemindersService } from '../../services/reminders.service';
import { ClockService } from '../../services/clock.service';
import { CatchUpKind, catchUpKind } from '@shared/xtream/catchUp';
import { HlmButton } from '@spartan-ng/helm/button';
import { locale, t } from '../../utils/i18n';
import { TPipe } from '../../pipes/t.pipe';

/** A local calendar day, as "2026-09-08", for grouping the listing. */
const dayKey = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const dayStart = (key: string): Date => {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
};

/**
 * One channel's programme guide (TV-4).
 *
 * What is on and what follows on the left, with the way to watch it; the day's
 * listing on the right, a day at a time, with the previous and next day a press
 * away. The guide is held for about a day ahead, so there are usually two days
 * to move between.
 */
@Component({
  selector: 'app-epg',
  standalone: true,
  imports: [TPipe, NgIcon, HlmButton],
  providers: [EpgStore, provideIcons({ lucideBell, lucideCalendarOff, lucideCircleDot, lucideHistory, lucideLoaderCircle, lucideRepeat, lucideRotateCcw })],
  templateUrl: './epg.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class EpgComponent implements OnDestroy {
  readonly stream = input<Stream | null>(null);
  readonly compact = input(false);

  /** Whether "Watch now" is offered: only where the caller can play it. */
  readonly canWatch = input(false);

  readonly watch = output<void>();

  /**
   * Whether catch-up is offered: only where the caller has a player that can
   * take it. What each programme allows is then the channel's to say.
   */
  readonly canCatchUp = input(false);

  /** A finished programme to play, or the one on air to start over. */
  readonly catchUp = output<{ start: number; stop: number; title: string }>();

  readonly store = inject(EpgStore);
  readonly reminders = inject(RemindersService);
  readonly recordings = inject(RecordingsService);
  private readonly toasts = inject(ToastService);

  /** The booking for a programme on this channel, if there is one. */
  bookingOf(program: EPGProgram) {
    const stream = this.stream();
    return stream ? this.recordings.bookingFor(String(stream.stream_id), millisecondsOf(program.start_timestamp)) : null;
  }

  cancelBooking(id: string): void {
    void this.recordings.cancelBooking(id);
  }

  /** The rule recording this programme's title every time on this channel, if there is one. */
  ruleOf(program: EPGProgram) {
    const stream = this.stream();
    return stream ? this.recordings.ruleFor(String(stream.stream_id), program.title ?? '') : null;
  }

  async recordEvery(program: EPGProgram, device: string): Promise<void> {
    const stream = this.stream();
    if (stream && (await this.recordings.recordEvery(stream, stream.name, program.title ?? '', device))) {
      this.toasts.info(t('recordings.everyBooked', { title: program.title ?? '' }));
    }
  }

  stopEvery(ruleId: string): void {
    void this.recordings.stopEvery(ruleId);
  }

  /** Books a programme still to come for a device that records. Says why when it cannot. */
  async book(program: EPGProgram, device: string): Promise<void> {
    const stream = this.stream();
    if (!stream || !this.isFuture(program, Date.now()) || this.bookingOf(program)) {
      return;
    }
    try {
      const result = await this.recordings.book(
        stream,
        stream.name,
        { title: program.title, startMs: millisecondsOf(program.start_timestamp), stopMs: millisecondsOf(program.stop_timestamp) },
        device
      );
      if ('clash' in result) {
        this.toasts.error(t('recordings.clash'), t('recordings.clashBody', { title: result.clash[0].title }));
      } else if ('portal' in result) {
        this.toasts.error(t('recordings.portalBooking'));
      } else if ('booked' in result) {
        const where = device === this.recordings.deviceKey ? '' : ` · ${this.recordings.deviceName(device)}`;
        this.toasts.info(t('recordings.booked', { title: result.booked.title }), clockTime(result.booked.startMs) + where);
      }
    } catch (error) {
      this.toasts.error(t('recordings.couldNot'), undefined, { detail: String(error) });
    }
  }

  /** Now, to the minute: what has finished, what is to come, minutes left. */
  private readonly now = inject(ClockService).minute;

  /** Whether a programme has not started, and so can be reminded of. */
  private isFuture(program: EPGProgram, now: number): boolean {
    return millisecondsOf(program.start_timestamp) > now;
  }

  /** Whether a reminder is set for a programme on this channel. */
  private isReminded(program: EPGProgram): boolean {
    const stream = this.stream();
    return !!stream && this.reminders.has(stream.stream_id, millisecondsOf(program.start_timestamp));
  }

  /** Sets a reminder for a programme that has not started, or takes it away. */
  toggleReminder(program: EPGProgram): void {
    const stream = this.stream();
    if (stream && this.isFuture(program, Date.now())) {
      this.reminders.toggle(stream, program);
    }
  }
  readonly currentProgress = signal<number>(0);
  private progressInterval: ReturnType<typeof setInterval> | null = null;

  /** The day the listing shows. Starts on today, or the first day there is. */
  readonly selectedDay = signal<string>(dayKey(Date.now()));

  private readonly days = computed(() =>
    [...new Set(this.store.programs().map(program => dayKey(millisecondsOf(program.start_timestamp))))].sort()
  );

  readonly dayPrograms = computed(() =>
    this.store.programs().filter(program => dayKey(millisecondsOf(program.start_timestamp)) === this.selectedDay())
  );

  readonly previousDay = computed(() => {
    const days = this.days();
    const at = days.indexOf(this.selectedDay());
    return at > 0 ? days[at - 1] : null;
  });

  readonly nextDay = computed(() => {
    const days = this.days();
    const at = days.indexOf(this.selectedDay());
    return at >= 0 && at < days.length - 1 ? days[at + 1] : null;
  });

  /**
   * The programme the listing has focus on, whose details the left side
   * shows; null for the one on air. Moving along the list and seeing nothing
   * change on the left, where the description lives, was a user's first
   * complaint about this screen (25 September).
   */
  readonly focused = signal<EPGProgram | null>(null);

  /** What the left side describes: the programme focused, or the one on air. */
  readonly detail = computed(() => this.focused() ?? this.store.currentProgram());

  /** "Tuesday 8 September". */
  readonly dayLabel = computed(() =>
    dayStart(this.selectedDay()).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })
  );

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;

  /** Whether focus has been put on the listing for this load yet. */
  private focusedListing = false;

  constructor() {
    // The channel's guide, read again whenever the channel changes.
    effect(() => {
      const stream = this.stream();
      if (stream) {
        untracked(() => this.loadEPG(stream));
      }
    });

    // A guide that has nothing today -- loaded late in the evening, say --
    // opens on the first day it does have rather than on an empty list.
    effect(() => {
      const days = this.days();
      if (days.length && !days.includes(this.selectedDay())) {
        this.selectedDay.set(days[0]);
      }
    });

    // Focus on the programme on air, once the listing exists (TV-4). The
    // dialog's focus scope places focus as it opens, before the guide has been
    // read, and settled on Back -- so the first press of OK closed the thing
    // somebody had just asked to see. Only if focus has not moved into the
    // listing by some other way.
    effect(() => {
      if (this.store.loading() || !this.dayPrograms().length || this.focusedListing) {
        return;
      }
      this.focusedListing = true;
      setTimeout(() => {
        const row = this.host.querySelector<HTMLElement>('[data-focus-first] button');
        if (row && !this.host.contains(document.activeElement)) {
          row.focus({ preventScroll: true });
          row.scrollIntoView({ block: 'center' });
        }
      });
    });
  }


  ngOnDestroy(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
  }

  private loadEPG(stream: Stream): void {
    // The whole channel's guide, and `compact` decides how much of it is drawn
    // rather than how much is fetched. It used to be a `limit` sent to the
    // backend; the device answers with the window it holds, and cutting that
    // down here would only mean asking again to see the rest.
    this.store.loadForStream(stream);
    this.selectedDay.set(dayKey(Date.now()));
    this.focused.set(null);
    this.focusedListing = false;
    this.startProgressUpdate();
  }

  private startProgressUpdate(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    this.progressInterval = setInterval(() => {
      const current = this.store.currentProgram();
      if (current) {
        this.currentProgress.set(calculateUnixProgress(current.start_timestamp, current.stop_timestamp));
      }
    }, 1000);
  }

  private isCurrentProgram(program: EPGProgram): boolean {
    return this.store.currentProgram()?.id === program.id;
  }

  /** What catch-up allows for this programme on this channel, if anything. */
  private catchUpOf(program: EPGProgram, now: number): CatchUpKind | null {
    if (!this.canCatchUp()) {
      return null;
    }
    return catchUpKind(this.stream(), this.timesOf(program), now);
  }

  /**
   * The programme the left side describes when it is not the one on air:
   * everything the template shows of it, worked out when it or the minute
   * changes rather than at every check.
   */
  readonly detailView = computed(() => {
    const program = this.detail();
    if (!program || this.isCurrentProgram(program)) {
      return null;
    }
    const now = this.now();
    return {
      program,
      when: this.whenLabel(program, now),
      timeRange: this.timeRange(program),
      minutes: this.durationMinutes(program),
      replay: this.catchUpOf(program, now) === 'replay',
      future: this.isFuture(program, now),
      reminded: this.isReminded(program)
    };
  });

  /** The one on air, when the left side shows it. */
  readonly currentView = computed(() => {
    const program = this.store.currentProgram();
    const shown = this.detail();
    if (!program || (shown && shown.id !== program.id)) {
      return null;
    }
    const now = this.now();
    return {
      program,
      timeRange: this.timeRange(program),
      elapsed: Math.max(0, Math.round((now - millisecondsOf(program.start_timestamp)) / 60_000)),
      left: Math.max(0, Math.round((millisecondsOf(program.stop_timestamp) - now) / 60_000)),
      startOver: this.catchUpOf(program, now) === 'startOver'
    };
  });

  /** What follows, under the one on air. */
  readonly nextView = computed(() => {
    const program = this.store.nextProgram();
    const shown = this.detail();
    if (!program || (shown && !this.isCurrentProgram(shown))) {
      return null;
    }
    return { program, start: this.clock(program.start_timestamp), minutes: this.durationMinutes(program) };
  });

  /** The day's listing, a row per programme, with what each row shows. */
  readonly rows = computed(() => {
    const now = this.now();
    return this.dayPrograms().map(program => {
      const current = this.isCurrentProgram(program);
      const past = millisecondsOf(program.stop_timestamp) <= now;
      const replay = !current && this.catchUpOf(program, now) === 'replay';
      return {
        program,
        current,
        past,
        replay,
        reminded: !current && !replay && this.isReminded(program),
        dimmed: !current && past && !replay,
        clock: this.clock(program.start_timestamp),
        minutes: this.durationMinutes(program)
      };
    });
  });

  /** "Mon" and "Wed", for the buttons to the previous and next day. */
  readonly previousDayLabel = computed(() => {
    const day = this.previousDay();
    return day ? this.shortDay(day) : null;
  });
  readonly nextDayLabel = computed(() => {
    const day = this.nextDay();
    return day ? this.shortDay(day) : null;
  });

  /** A row pressed: the one on air watches the channel, a finished one with catch-up plays. */
  pressed(program: EPGProgram): void {
    if (this.isCurrentProgram(program)) {
      if (this.canWatch()) {
        this.watch.emit();
      }
      return;
    }
    if (this.catchUpOf(program, Date.now()) === 'replay') {
      this.playFromStart(program);
      return;
    }
    // A programme still to come: OK sets a reminder, and OK again takes it
    // away. These rows did nothing before, so this costs the remote nothing.
    this.toggleReminder(program);
  }

  /** Plays a programme from its start: a finished one, or the one on air started over. */
  playFromStart(program: EPGProgram): void {
    this.catchUp.emit({ ...this.timesOf(program), title: program.title ?? '' });
  }

  private timesOf(program: EPGProgram): { start: number; stop: number } {
    return { start: millisecondsOf(program.start_timestamp), stop: millisecondsOf(program.stop_timestamp) };
  }

  /** "20:45", 24-hour, as everywhere else in the guide. */
  private clock(timestamp: number | string | undefined): string {
    const ms = millisecondsOf(timestamp);
    return Number.isFinite(ms) ? clockTime(ms) : '';
  }

  /** "20:45 – 22:45". */
  private timeRange(program: EPGProgram): string {
    return `${this.clock(program.start_timestamp)} – ${this.clock(program.stop_timestamp)}`;
  }

  private durationMinutes(program: EPGProgram): number {
    return Math.max(
      0,
      Math.round((millisecondsOf(program.stop_timestamp) - millisecondsOf(program.start_timestamp)) / 60_000)
    );
  }

  /** "Earlier", "Later", or the day when it is not today: "Sat". */
  private whenLabel(program: EPGProgram, now: number): string {
    const key = dayKey(millisecondsOf(program.start_timestamp));
    if (key !== dayKey(now)) {
      return this.shortDay(key);
    }
    return millisecondsOf(program.stop_timestamp) <= now ? t('common.earlier') : t('common.later');
  }

  /** "Mon", for the previous and next day buttons. */
  private shortDay(key: string): string {
    return dayStart(key).toLocaleDateString(locale(), { weekday: 'short' });
  }
}
