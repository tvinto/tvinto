import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronRight } from '@ng-icons/lucide';

/**
 * Settings under a plain heading, with a hairline between the rows (round 14,
 * DS-TV-2) -- in place of a boxed card with a blue capital heading.
 */
@Component({
  selector: 'app-setting-group',
  standalone: true,
  template: `
    <section class="setting-group" [attr.aria-label]="heading() || null">
      @if (heading()) {
        <h2 class="setting-group-title">{{ heading() }}</h2>
      }
      <div class="setting-group-rows">
        <ng-content />
      </div>
      <ng-content select="[groupAfter]" />
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingGroupComponent {
  readonly heading = input<string>('');
}

/**
 * One setting: its name, what it is set to, and where it leads (DS-TV-2).
 *
 * - `link`: opens something -- its page or the panel -- with an arrow.
 * - `switch`: on or off; the row itself is the switch (`role="switch"`), and
 *   the picture of one at its end only shows which.
 * - `static`: says something, with whatever is projected into `[rowEnd]` at
 *   its end (Display size's chips). Not a control itself.
 *
 * The whole row is one stop for the remote, as a row in the player's panel is.
 */
@Component({
  selector: 'app-setting-row',
  standalone: true,
  imports: [NgIcon, NgTemplateOutlet],
  providers: [provideIcons({ lucideChevronRight })],
  host: { class: 'block' },
  template: `
    @switch (kind()) {
      @case ('static') {
        <div class="setting-row" [attr.data-focus-key]="focusKey()">
          <ng-container *ngTemplateOutlet="words" />
          <div class="setting-row-end"><ng-content select="[rowEnd]" /></div>
        </div>
      }
      @case ('switch') {
        <button
          type="button"
          class="setting-row"
          role="switch"
          [attr.aria-checked]="checked()"
          [attr.aria-disabled]="disabled() || null"
          [attr.data-focus-key]="focusKey()"
          (click)="press()"
        >
          <ng-container *ngTemplateOutlet="words" />
          <span class="setting-row-end"><span class="switch" aria-hidden="true"></span></span>
        </button>
      }
      @default {
        <button
          type="button"
          class="setting-row"
          [attr.aria-disabled]="disabled() || null"
          [attr.data-focus-key]="focusKey()"
          (click)="press()"
        >
          <ng-container *ngTemplateOutlet="words" />
          @if (value()) {
            <span class="setting-row-value">{{ value() }}</span>
          }
          <span class="setting-row-end"><ng-icon name="lucideChevronRight" aria-hidden="true" /></span>
        </button>
      }
    }
    <ng-template #words>
      <span class="setting-row-text">
        <span class="setting-row-label">
          {{ label() }}
          @if (tag()) {
            <span class="tag">{{ tag() }}</span>
          }
        </span>
        @if (sub()) {
          <span class="setting-row-sub">{{ sub() }}</span>
        }
      </span>
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingRowComponent {
  readonly label = input.required<string>();
  /** One grey line under the name: a fact ("Not signed in"), never how to use the screen. */
  readonly sub = input<string>('');
  /** What kind of thing it is, as a quiet tag after the name: XTREAM, M3U. */
  readonly tag = input<string>('');
  /** What it is set to, in grey at the end: "English". */
  readonly value = input<string>('');
  readonly kind = input<'link' | 'switch' | 'static'>('link');
  readonly checked = input(false);
  /**
   * Unavailable for now, but still a stop for the remote: aria-disabled, not
   * disabled, so focus is not dropped to the page (see styles.css).
   */
  readonly disabled = input(false);
  readonly focusKey = input<string | null>(null);

  /** The row was pressed: open its page or panel, or flip the switch. */
  readonly activate = output<void>();

  press(): void {
    if (!this.disabled()) {
      this.activate.emit();
    }
  }
}
