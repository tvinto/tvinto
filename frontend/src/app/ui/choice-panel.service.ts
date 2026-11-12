import { Injectable, signal } from '@angular/core';

/** One row of the panel: what it stands for, its words, and a grey word after them. */
export interface PanelChoice<T> {
  value: T;
  label: string;
  detail?: string;
  /**
   * A round picture before the words: a person's (profileFace) where the
   * choices are people, or `settings` for a row beside them that is not one.
   */
  face?: { picture: string; background: string; own: boolean } | 'settings';
}

/** A panel being shown, for ChoicePanelComponent. */
export interface PanelRequest {
  id: number;
  title: string;
  choices: readonly PanelChoice<unknown>[];
  value: unknown;
  answer: (choice: { value: unknown } | null) => void;
}

/**
 * A list of choices, in the player's panel (round 14, DS-TV-4): the subtitle
 * and audio language, the sort on a category, anything that was a dropdown.
 *
 * The browser's `<select>` did this before, and on a television it opens
 * Android's own list in another style altogether, with its own idea of focus.
 * This is the panel Audio & subtitles and the sleep timer use in the player:
 * the screen dims, the setting's name at the top left, the choices as rows
 * with a check. On a phone it is a sheet from the bottom.
 *
 * One at a time: a panel asked for while another is open replaces it, since
 * the person has moved on.
 */
@Injectable({ providedIn: 'root' })
export class ChoicePanelService {
  readonly open = signal<PanelRequest | null>(null);
  private nextId = 1;

  /**
   * Resolves with `{ value }` once a row is chosen, or null for Back, the
   * backdrop, or another panel taking its place. Wrapped, so a choice whose
   * value is null itself ("Off") is told apart from no choice.
   */
  choose<T>(title: string, choices: readonly PanelChoice<T>[], value: T): Promise<{ value: T } | null> {
    this.open()?.answer(null);
    return new Promise(resolve => {
      this.open.set({
        id: this.nextId++,
        title,
        choices,
        value,
        answer: choice => resolve(choice as { value: T } | null)
      });
    });
  }

  answer(id: number, choice: { value: unknown } | null): void {
    const request = this.open();
    if (!request || request.id !== id) {
      return;
    }
    this.open.set(null);
    request.answer(choice);
  }
}
