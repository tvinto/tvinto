/**
 * How big everything is drawn, on this device (26 September).
 *
 * For somebody who sees less well, and for a screen that is much bigger or
 * much nearer than the one the layout was drawn for. A handful of steps rather
 * than a slider: on a remote a slider is a dozen presses, and nobody needs 107%.
 */

export type DisplaySize = 'smaller' | 'standard' | 'larger' | 'largest';

export interface DisplaySizeOption {
  id: DisplaySize;
  label: string;
  /** How much bigger than standard everything is drawn. */
  factor: number;
}

export const DISPLAY_SIZES: readonly DisplaySizeOption[] = [
  { id: 'smaller', label: 'Smaller', factor: 0.9 },
  { id: 'standard', label: 'Standard', factor: 1 },
  { id: 'larger', label: 'Larger', factor: 1.15 },
  { id: 'largest', label: 'Largest', factor: 1.3 }
];

/** What was stored, or standard for anything else -- an old value, a typo, nothing. */
export const displaySizeFrom = (stored: string | null | undefined): DisplaySizeOption =>
  DISPLAY_SIZES.find(option => option.id === stored) ?? DISPLAY_SIZES[1];
