/**
 * Whether a key went to text being edited: a field open for typing, not one
 * held back read-only until OK (TvNavigationService.holdBackKeyboard).
 *
 * The on-screen keyboard's "<" and ">" arrive as Left and Right on the field.
 * Anything that reads arrows as moving around the app has to leave those alone.
 */
export function isEditing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') {
    return false;
  }
  if (element.isContentEditable || element.tagName === 'TEXTAREA') {
    return true;
  }
  if (element.tagName !== 'INPUT') {
    return false;
  }
  const input = element as HTMLInputElement;
  const textual = !['checkbox', 'radio', 'button', 'submit', 'reset', 'range'].includes(input.type);
  return textual && !input.readOnly;
}
