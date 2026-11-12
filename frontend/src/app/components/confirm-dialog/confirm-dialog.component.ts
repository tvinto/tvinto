import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { Confirmation, ConfirmService } from '../../services/confirm.service';
import { DialogShellComponent } from '../../ui/dialog-shell.component';
import { TPipe } from '../../pipes/t.pipe';

/**
 * The app's "are you sure", in place of the browser's `confirm()`
 * (ConfirmService). The player's dialog (round 14, DS-TV-8): the question in
 * the middle of the dimmed screen, the answers stacked under it; Back and the
 * backdrop answer no (DialogShellComponent). Something that cannot be taken
 * back starts with focus on Cancel, so an OK pressed by habit on a remote
 * takes nothing away, and says so with red words rather than a red pill.
 */
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [TPipe, HlmButton, DialogShellComponent],
  template: `
    @if (shown(); as question) {
      <app-dialog-shell
        data-confirm-dialog
        [heading]="question.title"
        [message]="question.message ?? ''"
        [alert]="true"
        (dismissed)="answer(question, false)"
      >
        @if (question.destructive) {
          <button dialogActions hlmBtn type="button" data-focus-first (click)="answer(question, false)">
            {{ 'common.cancel' | t }}
          </button>
        }
        <button
          dialogActions
          hlmBtn
          type="button"
          [variant]="question.destructive ? 'destructive' : 'primary'"
          [attr.data-focus-first]="question.destructive ? null : ''"
          data-confirm-yes
          (click)="answer(question, true)"
        >
          {{ question.confirmLabel }}
        </button>
        @if (question.otherLabel) {
          <button dialogActions hlmBtn variant="destructive" type="button" data-confirm-other (click)="answer(question, 'other')">
            {{ question.otherLabel }}
          </button>
        }
        @if (!question.destructive) {
          <button dialogActions hlmBtn type="button" data-confirm-no (click)="answer(question, false)">
            {{ question.cancelLabel ?? ('common.cancel' | t) }}
          </button>
        }
      </app-dialog-shell>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConfirmDialogComponent {
  private readonly confirm = inject(ConfirmService);

  readonly shown = computed(() => this.confirm.asking()[0] ?? null);

  answer(question: Confirmation, choice: boolean | 'other'): void {
    this.confirm.answer(question.id, choice);
  }
}
