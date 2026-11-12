import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck } from '@ng-icons/lucide';

/** One of the choices: what it stands for, and the words on it. */
export interface Choice<T> {
  value: T;
  label: string;
}

/**
 * One of a few, as chips (round 14, DS-TV-1): Display size, the app's
 * language, what Search looks through. The one that is on carries a check;
 * focus is the white fill on a television, as on every pill.
 *
 * A radio group to anything reading the page. Each chip is its own stop for
 * the remote -- the navigation moves by where things are -- and for Tab, which
 * on the desktop is one press more than a roving radio group and keeps every
 * chip reachable the same way on every device.
 */
@Component({
  selector: 'app-choice-chips',
  standalone: true,
  imports: [NgIcon],
  providers: [provideIcons({ lucideCheck })],
  template: `
    <div class="flex flex-wrap items-center gap-2" role="radiogroup" [attr.aria-label]="label()" data-choice-chips>
      @for (choice of choices(); track choice.value) {
        <button
          type="button"
          class="chip"
          role="radio"
          [attr.aria-checked]="choice.value === value()"
          [attr.data-focus-key]="focusKey() ? focusKey() + '-' + choice.value : null"
          [disabled]="disabled()"
          (click)="value.set(choice.value)"
        >
          @if (choice.value === value()) {
            <ng-icon name="lucideCheck" aria-hidden="true" />
          }
          <span>{{ choice.label }}</span>
        </button>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChoiceChipsComponent<T extends string | number> {
  readonly choices = input.required<readonly Choice<T>[]>();
  readonly value = model<T | null>(null);
  /** What the choice is about, for a screen reader: "Display size". */
  readonly label = input.required<string>();
  /** A stem for each chip's `data-focus-key`, so focus can be put back on one. */
  readonly focusKey = input<string | null>(null);
  readonly disabled = input(false);
}

/**
 * Several of many, in an order (DS-TV-3): your languages. Pressing one that is
 * not chosen puts it at the end; pressing a chosen one takes it out. A chosen
 * chip shows its place where a choice of one shows a check.
 */
@Component({
  selector: 'app-order-chips',
  standalone: true,
  template: `
    <div class="flex flex-wrap items-center gap-2" role="group" [attr.aria-label]="label()" data-order-chips>
      @for (choice of choices(); track choice.value) {
        <button
          type="button"
          class="chip"
          [attr.aria-pressed]="place(choice.value) > 0"
          [attr.data-focus-key]="focusKey() ? focusKey() + '-' + choice.value : null"
          [disabled]="!place(choice.value) && full()"
          (click)="toggle(choice.value)"
        >
          @if (place(choice.value); as n) {
            <span data-chip-place>{{ n }}</span>
          }
          <span>{{ choice.label }}</span>
        </button>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OrderChipsComponent<T extends string | number> {
  readonly choices = input.required<readonly Choice<T>[]>();
  readonly values = model<readonly T[]>([]);
  readonly label = input.required<string>();
  readonly focusKey = input<string | null>(null);
  /** How many may be chosen; the rest wait until one is taken out. */
  readonly max = input(Number.POSITIVE_INFINITY);

  readonly full = computed(() => this.values().length >= this.max());

  private readonly places = computed(() => new Map(this.values().map((value, index) => [value, index + 1])));

  /** 1 for the first chosen, 0 for one not chosen. */
  place(value: T): number {
    return this.places().get(value) ?? 0;
  }

  toggle(value: T): void {
    const now = this.values();
    if (now.includes(value)) {
      this.values.set(now.filter(chosen => chosen !== value));
    } else if (!this.full()) {
      this.values.set([...now, value]);
    }
  }
}
