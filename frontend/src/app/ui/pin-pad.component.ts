import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideDelete } from '@ng-icons/lucide';
import { TPipe } from '../pipes/t.pipe';

/**
 * The PIN's keys (round 14, DS-TV-9): round glass keys in a grid, white when
 * focused; the digits given so far as dots filling in. Delete is a round key
 * beside 0. What the digits are for, and the number keys on a remote, belong
 * to the dialog it sits in.
 */
@Component({
  selector: 'app-pin-pad',
  standalone: true,
  imports: [NgIcon, TPipe],
  providers: [provideIcons({ lucideDelete })],
  template: `
    <!-- Dots rather than digits: somebody may be reading over a shoulder,
         which is the whole of what a parental PIN defends against. A wrong
         PIN shakes them once, keyed on the count so it shakes again. -->
    @for (shake of [wobble()]; track shake) {
      <div class="pin-dots" [class.pin-wobble]="shake > 0" role="img" [attr.aria-label]="'lock.pad.entered' | t: { count: entered() }">
        @for (dot of dots(); track $index) {
          <span class="pin-dot" [class.pin-dot-on]="dot"></span>
        }
      </div>
    }
    <div class="pin-keys" data-pin-keys>
      @for (key of keys; track key) {
        <button
          type="button"
          class="pin-key"
          [attr.data-focus-first]="key === '5' ? '' : null"
          [attr.data-pin-digit]="key"
          [disabled]="disabled()"
          (click)="digit.emit(key)"
        >
          {{ key }}
        </button>
      }
      <span aria-hidden="true"></span>
      <button type="button" class="pin-key" data-pin-digit="0" [disabled]="disabled()" (click)="digit.emit('0')">0</button>
      <button type="button" class="pin-key" data-pin-erase [attr.aria-label]="'lock.pad.delete' | t" (click)="erase.emit()">
        <ng-icon name="lucideDelete" aria-hidden="true" />
      </button>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PinPadComponent {
  /** How many digits the PIN has. */
  readonly length = input(4);
  /** How many have been given so far. */
  readonly entered = input(0);
  /** Paused after too many wrong tries: the digits wait, Delete does not. */
  readonly disabled = input(false);
  /** Raised by one at each wrong PIN, to shake the dots. */
  readonly wobble = input(0);

  /** A digit key was pressed: "0" to "9". */
  readonly digit = output<string>();
  readonly erase = output<void>();

  readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  readonly dots = computed(() => Array.from({ length: this.length() }, (_, n) => n < this.entered()));
}
