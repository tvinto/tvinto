import { Injectable, signal } from '@angular/core';

/** Which button answered: going ahead, the other way ahead, or neither. */
export type ConfirmChoice = 'confirm' | 'other' | null;

/** A question with two answers, or three, for ConfirmDialogComponent. */
export interface Confirmation {
  id: number;
  title: string;
  message?: string;
  /** The word on the button that goes ahead: "Remove", not "OK". */
  confirmLabel: string;
  /** Something that cannot be taken back: the button is drawn as such, and focus starts on Cancel. */
  destructive?: boolean;
  /**
   * A second way ahead, beside the first: Sign out's "Remove from this
   * device" beside "Keep on this device". Drawn as something that cannot be
   * taken back.
   */
  otherLabel?: string;
  /** The word on the button that goes no further, where "Cancel" would not say what it does. */
  cancelLabel?: string;
  answer: (choice: ConfirmChoice) => void;
}

/**
 * Asks before doing something, in the app's own dialog.
 *
 * The browser's `confirm()` did this before: a grey system box with "OK" on
 * it, outside the app's look and its remote handling, on a television drawn
 * by the WebView wherever it liked (the loose ends of 6 October). One question
 * at a time, oldest first; a question asked while another is open waits.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly asking = signal<Confirmation[]>([]);
  private nextId = 1;

  /** True when the person went ahead, false for Cancel, Back or the backdrop. */
  ask(question: Omit<Confirmation, 'id' | 'answer' | 'otherLabel'>): Promise<boolean> {
    return this.choose(question).then(choice => choice === 'confirm');
  }

  /** A question with a second way ahead (`otherLabel`); null for Cancel, Back or the backdrop. */
  choose(question: Omit<Confirmation, 'id' | 'answer'>): Promise<ConfirmChoice> {
    return new Promise(resolve => {
      const id = this.nextId++;
      this.asking.update(list => [...list, { ...question, id, answer: resolve }]);
    });
  }

  answer(id: number, choice: ConfirmChoice | boolean): void {
    const question = this.asking().find(candidate => candidate.id === id);
    if (!question) {
      return;
    }
    this.asking.update(list => list.filter(candidate => candidate.id !== id));
    question.answer(choice === true ? 'confirm' : choice === false ? null : choice);
  }
}
