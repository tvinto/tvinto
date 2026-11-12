/**
 * @jest-environment jsdom
 */

import { wideLayoutNow } from './layout.utils';

/**
 * The wide layout, and the one case that is not about the window at all.
 *
 * Android shrinks the WebView to make room for the on-screen keyboard. On the
 * emulator a television went from 960x540 to 960x300 while the keyboard was
 * up -- short and wide, which is exactly the shape this query exists to catch
 * and send to the phone layout. Doing that mid-keystroke tore the focused
 * field out of the document and the keyboard shut again. So a set is wide
 * whatever its height, and nothing else is.
 */

const windowShaped = (matches: boolean): void => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({ matches, addEventListener: () => {}, removeEventListener: () => {} })
  });
};

describe('whether the wide layout applies', () => {
  afterEach(() => document.documentElement.classList.remove('tv'));

  it('follows the window on anything that is not a television', () => {
    windowShaped(true);
    expect(wideLayoutNow()).toBe(true);

    windowShaped(false);
    expect(wideLayoutNow()).toBe(false);
  });

  it('is true on a television the keyboard has made short', () => {
    windowShaped(false);
    document.documentElement.classList.add('tv');

    expect(wideLayoutNow()).toBe(true);
  });
});
