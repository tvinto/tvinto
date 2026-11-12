import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CardGesturesDirective } from './card-gestures.directive';

/**
 * Telling "open this" from "tell me about this" on one target.
 *
 * Everything here is a timing question, and every one of the answers is silent
 * when it is wrong: a hold that also opens the channel starts playing something
 * over the panel that was asked for, and a hold that never fires just feels
 * like a remote with a flat battery.
 *
 * Both host kinds are exercised. Two of the three cards in this app are real
 * `<button>`s, whose answer to Enter is to fire `click` on the *keydown* --
 * which would have opened the channel before a hold could possibly finish.
 */

@Component({
  standalone: true,
  imports: [CardGesturesDirective],
  template: `
    <button
      type="button"
      appCardGestures
      (activate)="opened = opened + 1"
      (menu)="menus = menus + 1"
    >
      A rail card
    </button>
    <div
      tabindex="0"
      role="button"
      appCardGestures
      (activate)="opened = opened + 1"
      (menu)="menus = menus + 1"
    >
      A grid card
    </div>
  `
})
class Host {
  opened = 0;
  menus = 0;
}

describe('CardGesturesDirective', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;

  const cards = (): HTMLElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('button, div[role="button"]'));

  const key = (element: HTMLElement, type: 'keydown' | 'keyup', over: Partial<KeyboardEventInit> = {}) => {
    const event = new KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true, ...over });
    element.dispatchEvent(event);
    return event;
  };

  const pointer = (element: HTMLElement, type: string, button = 0) => {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button }));
  };

  beforeEach(() => {
    jest.useFakeTimers();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [Host] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    host = fixture.componentInstance;
  });

  afterEach(() => jest.useRealTimers());

  describe.each([
    ['a rail card, which is a real button', 0],
    ['a grid card, which is a div', 1]
  ])('%s', (_what, index) => {
    let card: HTMLElement;

    beforeEach(() => {
      card = cards()[index];
    });

    it('opens on a press that is let go', () => {
      key(card, 'keydown');
      jest.advanceTimersByTime(120);
      key(card, 'keyup');

      expect(host.opened).toBe(1);
      expect(host.menus).toBe(0);
    });

    it('does not open on a key-up whose key-down was somewhere else', () => {
      // OK on the panel's "Add to favourites" goes down on the panel, which
      // closes and gives focus back to the card before the key comes up.
      key(card, 'keyup');

      expect(host.opened).toBe(0);
      key(card, 'keydown');
      jest.advanceTimersByTime(120);
      key(card, 'keyup');
      expect(host.opened).toBe(1);
    });

    it('opens the panel on a press that is held', () => {
      key(card, 'keydown');
      jest.advanceTimersByTime(600);

      expect(host.menus).toBe(1);
    });

    it('does not also open the card when the press is finally let go', () => {
      // The failure this is for: a held Enter that starts playing the channel
      // behind the panel it just asked for.
      key(card, 'keydown');
      jest.advanceTimersByTime(600);
      key(card, 'keyup');

      expect(host.menus).toBe(1);
      expect(host.opened).toBe(0);
    });

    it('takes Enter away from the browser, which would otherwise open it at once', () => {
      // A button's default answer to Enter fires on keydown. Left alone, the
      // hold would have nothing to answer, because the card is already open.
      const event = key(card, 'keydown');

      expect(event.defaultPrevented).toBe(true);
    });

    // What Android TV's WebView sends for a held OK, seen on the emulator on
    // 25 September: the key again and again, none of them marked as a repeat.
    // Each restarted the wait, so the hold never came and letting go opened.
    it('still opens the panel when the repeats are not marked as repeats', () => {
      key(card, 'keydown');
      for (let held = 0; held < 12; held += 1) {
        jest.advanceTimersByTime(50);
        key(card, 'keydown');
      }

      expect(host.menus).toBe(1);
      key(card, 'keyup');
      expect(host.opened).toBe(0);
    });

    it('waits afresh for the next press once the last was let go', () => {
      key(card, 'keydown');
      key(card, 'keyup');
      key(card, 'keydown');
      jest.advanceTimersByTime(600);

      expect(host.opened).toBe(1);
      expect(host.menus).toBe(1);
    });

    // The panel takes focus while OK is still down; the rest of the hold must
    // not press whatever it focused -- Play, on a channel.
    it('keeps the rest of a held key away from whatever takes focus', () => {
      const elsewhere = document.createElement('button');
      let pressed = 0;
      elsewhere.addEventListener('keydown', () => (pressed += 1));
      document.body.appendChild(elsewhere);

      key(card, 'keydown');
      jest.advanceTimersByTime(600);
      elsewhere.focus();
      const repeat = key(elsewhere, 'keydown');
      key(elsewhere, 'keyup');

      expect(pressed).toBe(0);
      expect(repeat.defaultPrevented).toBe(true);
      // And the next press on the card starts afresh.
      key(card, 'keydown');
      key(card, 'keyup');
      expect(host.opened).toBe(1);
      elsewhere.remove();
    });

    // The TV emulator, 28 September: drawing the panel held the repeats back
    // 229 ms and then 469 ms, and the second was taken for a new press.
    it('keeps a held key away however slowly its repeats arrive', () => {
      const elsewhere = document.createElement('button');
      let pressed = 0;
      elsewhere.addEventListener('keydown', () => (pressed += 1));
      document.body.appendChild(elsewhere);

      key(card, 'keydown');
      jest.advanceTimersByTime(600);
      elsewhere.focus();
      key(elsewhere, 'keydown');
      jest.advanceTimersByTime(470);
      key(elsewhere, 'keydown');
      jest.advanceTimersByTime(470);
      key(elsewhere, 'keydown');
      key(elsewhere, 'keyup');

      expect(pressed).toBe(0);
      elsewhere.remove();
    });

    it('lets a press through after a long quiet, when the key-up was never seen', () => {
      const elsewhere = document.createElement('button');
      let pressed = 0;
      elsewhere.addEventListener('keydown', () => (pressed += 1));
      document.body.appendChild(elsewhere);

      key(card, 'keydown');
      jest.advanceTimersByTime(600);
      elsewhere.focus();
      jest.advanceTimersByTime(2500);
      key(elsewhere, 'keydown');

      expect(pressed).toBe(1);
      elsewhere.remove();
    });

    it('counts a held key once, however many repeats the platform sends', () => {
      key(card, 'keydown');
      key(card, 'keydown', { repeat: true });
      key(card, 'keydown', { repeat: true });
      jest.advanceTimersByTime(600);

      expect(host.menus).toBe(1);
    });

    it('opens on a click', () => {
      pointer(card, 'pointerdown');
      pointer(card, 'pointerup');
      pointer(card, 'click');

      expect(host.opened).toBe(1);
      expect(host.menus).toBe(0);
    });

    it('opens the panel on a press held with the pointer, and not the card', () => {
      pointer(card, 'pointerdown');
      jest.advanceTimersByTime(600);
      pointer(card, 'pointerup');
      pointer(card, 'click');

      expect(host.menus).toBe(1);
      expect(host.opened).toBe(0);
    });

    it('gives up the hold if the pointer leaves', () => {
      pointer(card, 'pointerdown');
      pointer(card, 'pointerleave');
      jest.advanceTimersByTime(600);

      expect(host.menus).toBe(0);
    });

    it('opens the panel on a right-click, and shows no menu of the browser own', () => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      card.dispatchEvent(event);

      expect(host.menus).toBe(1);
      expect(event.defaultPrevented).toBe(true);
    });

    // The remote's Menu and Info keys: the same question as a hold, in one
    // press and without knowing that holding means anything.
    it.each(['ContextMenu', 'Info'])('opens the panel on the %s key, at once', name => {
      const event = key(card, 'keydown', { key: name });

      expect(host.menus).toBe(1);
      expect(host.opened).toBe(0);
      expect(event.defaultPrevented).toBe(true);
    });

    it('does not start a hold on the right button going down', () => {
      // Otherwise contextmenu and the hold both fire, and the panel opens
      // twice for one gesture.
      pointer(card, 'pointerdown', 2);
      jest.advanceTimersByTime(600);

      expect(host.menus).toBe(0);
    });

    it('leaves a key pressed on something inside the card alone', () => {
      // On a desktop the card still carries a star and a guide button. Enter
      // on the star bubbles up to here, and acting on it would favourite a
      // channel and start playing it in one keystroke.
      const inner = document.createElement('button');
      card.appendChild(inner);

      key(inner, 'keydown');
      key(inner, 'keyup');
      jest.advanceTimersByTime(600);

      expect(host.opened).toBe(0);
      expect(host.menus).toBe(0);
    });
  });
});
