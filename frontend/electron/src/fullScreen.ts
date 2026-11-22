import { BrowserWindow, Rectangle, screen } from 'electron';
import { playbackLog } from './playbackLog';

/**
 * Full screen that covers the whole display, every time.
 *
 * On 14 November the owner saw the picture stop about 70 px above the bottom
 * of the screen in full screen, over a black band -- the height of the
 * Windows taskbar at 150 %, so most likely a window left at the display's
 * work area instead of the display. It did not happen on the development PC
 * (one 1920x1080 monitor at 100 %): from a window, from a maximised one, by
 * the page's full screen and by the window's, with the old menu bar and
 * without, at a simulated 150 %. So this checks, after each entry, that the
 * window is the size of its display, puts it there when it is not, and
 * writes both sizes to the playback log either way: the next time it
 * happens, the log says what it was.
 */
export function keepFullScreenWhole(window: BrowserWindow): void {
  const check = (how: string) => {
    // After Windows has finished moving it.
    setTimeout(() => {
      if (window.isDestroyed() || !window.isFullScreen()) {
        return;
      }
      const bounds = window.getBounds();
      const content = window.getContentBounds();
      const display = screen.getDisplayMatching(bounds);
      const whole = covers(bounds, display.bounds) && covers(content, display.bounds);
      playbackLog(
        `full screen (${how}): window ${size(bounds)}, content ${size(content)}, display ${size(display.bounds)} ` +
          `at ${display.scaleFactor}x, work area ${size(display.workArea)}${whole ? '' : ' -- short of the display, covering it'}`
      );
      if (!whole) {
        window.setBounds(display.bounds);
      }
    }, 300);
  };
  window.on('enter-full-screen', () => check('window'));
  window.on('enter-html-full-screen', () => check('page'));
}

function covers(inner: Rectangle, outer: Rectangle): boolean {
  return inner.x <= outer.x && inner.y <= outer.y && inner.x + inner.width >= outer.x + outer.width && inner.y + inner.height >= outer.y + outer.height;
}

function size(rectangle: Rectangle): string {
  return `${rectangle.width}x${rectangle.height}+${rectangle.x}+${rectangle.y}`;
}
