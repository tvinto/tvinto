import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideChevronRight } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { Problem, ToastService } from '../../services/toast.service';
import { DialogShellComponent } from '../../ui/dialog-shell.component';
import { TPipe } from '../../pipes/t.pipe';

/**
 * A failure, in a dialog that stays until it is closed (5 October:
 * the toasts were gone before they could be read, and never said why).
 *
 * What happened and what can be done, in the viewer's words; behind Details,
 * what the player or the server said -- an error code, an HTTP status, the
 * server's own message -- with addresses taken out, since a provider's carry
 * the subscription's password. One at a time, oldest first. Back or Close
 * puts it away, and focus goes back where it was. The player's dialog
 * (round 14, DS-TV-8), over any question that is open.
 */
@Component({
  selector: 'app-error-dialog',
  standalone: true,
  imports: [TPipe, NgIcon, HlmButton, DialogShellComponent],
  providers: [provideIcons({ lucideChevronDown, lucideChevronRight })],
  template: `
    @if (shown(); as problem) {
      <app-dialog-shell
        data-error-dialog
        [heading]="problem.title"
        [message]="problem.message ?? ''"
        [alert]="true"
        [above]="true"
        (dismissed)="close(problem)"
      >
        @if (problem.detail) {
          <button
            hlmBtn
            variant="quiet"
            size="sm"
            type="button"
            [attr.aria-expanded]="detailsOpen()"
            data-error-details
            (click)="detailsOpen.set(!detailsOpen())"
          >
            <ng-icon [name]="detailsOpen() ? 'lucideChevronDown' : 'lucideChevronRight'" />
            {{ 'error.details' | t }}
          </button>
          @if (detailsOpen()) {
            <pre
              class="max-h-60 w-full overflow-auto rounded-xl bg-[var(--glass-quiet)] p-3 text-left font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground select-text"
              data-error-detail
            >{{ problem.detail }}</pre>
          }
        }
        @if (waiting() > 1) {
          <span class="text-sm text-muted-foreground">{{ 'error.more' | t: { count: waiting() - 1 } }}</span>
        }

        @if (problem.action; as action) {
          <button dialogActions hlmBtn variant="primary" type="button" data-focus-first (click)="act(problem)">{{ action.label }}</button>
        }
        @if (problem.action) {
          <button dialogActions hlmBtn type="button" (click)="close(problem)">{{ 'error.close' | t }}</button>
        } @else {
          <button dialogActions hlmBtn variant="primary" type="button" data-focus-first (click)="close(problem)">{{ 'error.close' | t }}</button>
        }
      </app-dialog-shell>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ErrorDialogComponent {
  private readonly toasts = inject(ToastService);

  readonly shown = computed(() => this.toasts.problems()[0] ?? null);
  readonly waiting = computed(() => this.toasts.problems().length);
  readonly detailsOpen = signal(false);

  constructor() {
    // Each failure opens with its details folded away. Back, the backdrop and
    // giving focus back are the dialog shell's.
    effect(() => {
      this.shown();
      untracked(() => this.detailsOpen.set(false));
    });
  }

  close(problem: Problem): void {
    this.toasts.closeProblem(problem.id);
  }

  act(problem: Problem): void {
    this.toasts.closeProblem(problem.id);
    problem.action?.run();
  }
}
