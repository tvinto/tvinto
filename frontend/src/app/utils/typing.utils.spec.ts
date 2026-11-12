/**
 * @jest-environment jsdom
 */
import { isEditing } from './typing.utils';

describe('isEditing', () => {
  const input = (readOnly = false, type = 'text'): HTMLInputElement => {
    const element = document.createElement('input');
    element.type = type;
    element.readOnly = readOnly;
    return element;
  };

  // The keyboard's "<" on Search opened the menu behind it (29 October).
  it('is a text field open for typing', () => {
    expect(isEditing(input())).toBe(true);
  });

  it('is not a field held back from the keyboard, where Left still leaves', () => {
    expect(isEditing(input(true))).toBe(false);
  });

  it('is not a checkbox or a button', () => {
    expect(isEditing(input(false, 'checkbox'))).toBe(false);
    expect(isEditing(document.createElement('button'))).toBe(false);
  });

  it('is a text area', () => {
    expect(isEditing(document.createElement('textarea'))).toBe(true);
  });

  it('is nothing at all', () => {
    expect(isEditing(null)).toBe(false);
  });
});
