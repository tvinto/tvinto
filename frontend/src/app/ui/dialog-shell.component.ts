import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, input, output } from '@angular/core';
import { BackButtonService } from '../services/back-button.service';
import { FocusScopeDirective } from '../directives/focus-scope.directive';

let nextShell = 1;

/**
 * A dialog, the player's way (round 14, DS-TV-8): the screen dimmed, the
 * question in the middle, at most one grey sentence under it, and the answers
 * stacked as full-width pills. No box and no border. On a phone it is a sheet
 * from the bottom (DS-P-3).
 *
 * Put it inside the `@if` that shows the dialog. While it exists, Back and the
 * backdrop send `dismissed`; when it goes, focus returns to whatever had it
 * before. The answers are projected, and the one marked `data-focus-first`
 * takes focus -- the safe one, for anything that cannot be undone.
 */
@Component({
  selector: 'app-dialog-shell',
  standalone: true,
  imports: [FocusScopeDirective],
  template: `
    <div
      class="dialog-screen"
      [class.dialog-screen-above]="above()"
      data-focus-scope
      data-dialog-shell
      data-enter="sheet"
      [attr.role]="alert() ? 'alertdialog' : 'dialog'"
      aria-modal="true"
      [attr.aria-labelledby]="titleId"
      [attr.aria-describedby]="message() ? messageId : null"
      (click)="dismissed.emit()"
    >
      <div class="dialog" [class.dialog-wide]="wide()" (click)="$event.stopPropagation()">
        <h2 class="dialog-title" [id]="titleId">{{ heading() }}</h2>
        @if (message()) {
          <p class="dialog-message" [id]="messageId">{{ message() }}</p>
        }
        <ng-content />
        <div class="dialog-actions">
          <ng-content select="[dialogActions]" />
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DialogShellComponent implements OnDestroy {
  /** The question, or what went wrong: "Remove the guide “Croatia”?" */
  readonly heading = input.required<string>();
  /** What happens, in one sentence. */
  readonly message = input<string>('');
  /** Something that needs an answer before anything else (alertdialog). */
  readonly alert = input(false);
  /** Room for more than words between the title and the answers: a list, a keypad. */
  readonly wide = input(false);
  /** Over any other dialog: a failure that happens while a question is open. */
  readonly above = input(false);
  /**
   * Back is the dialog's own business: the PIN's Back takes a digit off
   * before it closes anything.
   */
  readonly ownBack = input(false);

  readonly dismissed = output<void>();

  private readonly id = nextShell++;
  readonly titleId = `dialog-title-${this.id}`;
  readonly messageId = `dialog-message-${this.id}`;

  /** What had focus as the dialog opened, to hand it back. */
  private readonly returnTo: HTMLElement | null = (() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && !active.closest('[data-dialog-shell]') ? active : null;
  })();

  constructor() {
    inject(BackButtonService).bindTo(
      computed(() => !this.ownBack()),
      () => this.dismissed.emit()
    );
  }

  ngOnDestroy(): void {
    const back = this.returnTo;
    if (back) {
      requestAnimationFrame(() => back.isConnected && back.focus({ preventScroll: true }));
    }
  }
}
