import { Injectable, signal } from '@angular/core';

/** What a toast is about, which is what colours it. */
export type ToastKind = 'error' | 'info' | 'success';

/** Something a toast offers to do, such as playing another version of a film. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  action?: ToastAction;
}

/**
 * Something that failed, for the error dialog (ErrorDialogComponent): what
 * happened and what can be done, and behind Details what the player or the
 * server actually said.
 */
export interface Problem {
  id: number;
  title: string;
  message?: string;
  /** The technical side, addresses already taken out (failure-messages.utils.ts). */
  detail?: string;
  action?: ToastAction;
}

/** How long a toast stays, by what it asks of the person reading it. */
const SHOWN_FOR_MS = { plain: 6000, error: 8000, action: 15000 } as const;

/** More than this at once is a wall, not a message. The oldest goes. */
const MOST_AT_ONCE = 3;

/**
 * Short messages in a corner of the screen, for things that happened.
 *
 * Failures used to land in a line of red at the top of whichever page was
 * open -- or nowhere: a film that would not play closed its player and left
 * nothing to say why, and a provider that stopped answering looked like an
 * empty category. A user asked for "nice toast error messages if something
 * fails, even on Xtream API" (24 September). So anything that fails says so
 * here, in words about the viewer's situation rather than the code's.
 *
 * A toast with an action stays longer and can be reached with a remote -- see
 * ToastsComponent -- and is the one kind that takes focus, because the action
 * is the reason it is there.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);

  /** Failures waiting to be read, oldest first: one dialog at a time. */
  readonly problems = signal<Problem[]>([]);

  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * A failure, said in a dialog rather than a toast: a toast was gone before
   * it could be read, and said nothing of why (5 October). The
   * same failure twice before the first is closed is one dialog.
   */
  error(title: string, message?: string, extra: { action?: ToastAction; detail?: string } = {}): number {
    const same = this.problems().find(problem => problem.title === title && problem.message === message);
    if (same) {
      return same.id;
    }
    const id = this.nextId++;
    this.problems.update(waiting => [...waiting, { id, title, message, action: extra.action, detail: extra.detail || undefined }]);
    return id;
  }

  /** The failure read and closed. */
  closeProblem(id: number): void {
    this.problems.update(waiting => waiting.filter(problem => problem.id !== id));
  }

  info(title: string, message?: string, action?: ToastAction): number {
    return this.show({ kind: 'info', title, message, action });
  }

  success(title: string, message?: string): number {
    return this.show({ kind: 'success', title, message });
  }

  show(toast: Omit<Toast, 'id'>): number {
    // The same message twice in a row is one message: a category that fails
    // to load on every retry should not stack three identical toasts.
    const same = this.toasts().find(shown => shown.title === toast.title && shown.message === toast.message);
    if (same) {
      this.dismissLater(same.id, toast);
      return same.id;
    }

    const id = this.nextId++;
    this.toasts.update(shown => [...shown, { ...toast, id }].slice(-MOST_AT_ONCE));
    this.dismissLater(id, toast);
    return id;
  }

  dismiss(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.toasts.update(shown => shown.filter(toast => toast.id !== id));
  }

  private dismissLater(id: number, toast: Omit<Toast, 'id'>): void {
    clearTimeout(this.timers.get(id));
    const after = toast.action
      ? SHOWN_FOR_MS.action
      : toast.kind === 'error'
        ? SHOWN_FOR_MS.error
        : SHOWN_FOR_MS.plain;
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), after)
    );
  }
}
