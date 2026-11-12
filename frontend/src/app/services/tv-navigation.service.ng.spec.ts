import { TestBed } from '@angular/core/testing';
import { TvNavigationService } from './tv-navigation.service';

/** What Capacitor says this is. Android unless a test says otherwise. */
let mockPlatform = 'android';

/**
 * Moving focus with a remote, and keeping it.
 *
 * Every one of these is silent when it is wrong. Focus is not drawn by this
 * code -- it is drawn by the stylesheet reacting to where focus happens to be
 * -- so a fault here does not throw, log, or fail a build. It shows up as a
 * remote that stops working half way down a list, which is a thing only a
 * person holding one ever finds out.
 *
 * jsdom lays nothing out, so every rectangle here is declared. That is not a
 * weakness of the test: this service's whole job is choosing between
 * rectangles, and choosing correctly between rectangles somebody wrote down is
 * exactly the claim worth making.
 */

jest.mock('@capacitor/core', () => ({
  // No Television plugin here: these tests are about the D-pad path, which is
  // what a device that cannot say it is a television still gets.
  Capacitor: {
    isNativePlatform: (): boolean => true,
    getPlatform: (): string => mockPlatform,
    isPluginAvailable: (): boolean => false
  },
  registerPlugin: jest.fn()
}));

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const rects = new WeakMap<Element, Box>();

/** Things that have a size but cannot be seen, as an unfocused card's star has. */
const invisible = new WeakSet<Element>();

/** Declared overflow, since jsdom runs no cascade. */
const overflows = new WeakMap<Element, { x: string; y: string }>();

const boxOf = (element: Element): DOMRect => {
  const box = rects.get(element) ?? { top: 0, left: 0, width: 0, height: 0 };

  return {
    ...box,
    right: box.left + box.width,
    bottom: box.top + box.height,
    x: box.left,
    y: box.top,
    toJSON: () => box
  } as DOMRect;
};

/** Somewhere on screen, since nothing in jsdom has a size of its own. */
const at = <T extends HTMLElement>(element: T, box: Box): T => {
  rects.set(element, box);
  return element;
};

const press = (key: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
};

/** What the browser does when a scroll recycles the row focus was on. */
const recycle = (element: HTMLElement): void => {
  element.remove();
  document.dispatchEvent(new Event('scroll'));
};

describe('TvNavigationService', () => {
  let service: TvNavigationService;

  /** A card carrying an id that outlives the element, as the templates do. */
  const card = (key: string, box: Box, controls: string[] = []): HTMLElement => {
    const element = at(document.createElement('div'), box);
    element.tabIndex = 0;
    element.setAttribute('data-focus-key', key);

    controls.forEach((name, index) => {
      const button = at(document.createElement('button'), {
        ...box,
        top: box.top + box.height - 10,
        height: 10,
        left: box.left + index * 20,
        width: 20
      });
      button.textContent = name;
      element.appendChild(button);
    });

    document.body.appendChild(element);
    return element;
  };

  const focused = (): Element | null => document.activeElement;

  beforeAll(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return boxOf(this);
    };
    Element.prototype.scrollIntoView = jest.fn();

    // jsdom leaves this null for everything, and a null offsetParent is how
    // this service recognises something that is not laid out at all.
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(): Element | null {
        return document.body.contains(this as Node) ? document.body : null;
      }
    });

    // jsdom runs no cascade, so computed opacity comes back as the empty
    // string for everything -- which the service reads as fully transparent
    // and skips, leaving nothing on screen at all. Declared here instead,
    // which also makes "invisible" something a test can ask for: the star on
    // an unfocused card really is at opacity zero, and must not take focus.
    window.getComputedStyle = ((element: Element) =>
      ({
        visibility: invisible.has(element) ? 'hidden' : 'visible',
        opacity: invisible.has(element) ? '0' : '1',
        overflowX: overflows.get(element)?.x ?? 'visible',
        overflowY: overflows.get(element)?.y ?? 'visible'
      }) as CSSStyleDeclaration) as typeof window.getComputedStyle;
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.className = '';
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    service = TestBed.inject(TvNavigationService);
    service.install();
  });

  // Guides, Account and Search opened with nothing focused: the page's Back
  // button comes first and is hidden on a television, and focusing it did
  // nothing. Found by tools/qa/tv-walk.js.
  it('on arrival, focuses the first control that is on screen, not a hidden one', () => {
    jest.useFakeTimers();
    try {
      const main = document.createElement('main');
      const back = document.createElement('button');
      Object.defineProperty(back, 'offsetParent', { get: () => null });
      const refresh = document.createElement('button');
      main.append(back, refresh);
      document.body.appendChild(main);

      service.isTelevision.set(true);
      service.focusContentWhenReady();
      jest.advanceTimersByTime(1500);

      expect(focused()).toBe(refresh);
    } finally {
      jest.useRealTimers();
    }
  });

  // Up and Down on a focused select change its value in Android's WebView, with
  // no list on screen: the subtitle language on Account changed and saved with
  // every press, and the remote could not get off it.
  it('moves off a select instead of letting the arrows change it', () => {
    const select = at(document.createElement('select'), { top: 0, left: 0, width: 200, height: 40 });
    document.body.appendChild(select);
    const below = card('stream-1', { top: 60, left: 0, width: 200, height: 40 });

    select.focus();
    const down = press('ArrowDown');

    expect(focused()).toBe(below);
    expect(down.defaultPrevented).toBe(true);
  });

  it('keeps every arrow from changing a select with nothing beyond it', () => {
    const select = at(document.createElement('select'), { top: 0, left: 0, width: 200, height: 40 });
    document.body.appendChild(select);
    select.focus();

    // What the navigation sees on the way up: Left at the edge still arrives
    // unanswered, which is how it knows to open.
    let seenUnprevented = false;
    const listener = (event: KeyboardEvent) => (seenUnprevented = !event.defaultPrevented);
    document.addEventListener('keydown', listener);
    try {
      for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        select.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(seenUnprevented).toBe(true);
    } finally {
      document.removeEventListener('keydown', listener);
    }
    expect(focused()).toBe(select);
  });

  // "Left/Right never changes row" (FY-TV). Left from the first film on For
  // You went up to the channel in the row above instead of opening the
  // navigation; with nothing level with it, the press must go unanswered.
  it('does not change row on Left or Right, and leaves the press for the navigation', () => {
    card('fy-recent-live-1', { top: 0, left: 0, width: 40, height: 100 });
    const film = card('fy-added-vod-1', { top: 150, left: 50, width: 100, height: 150 });
    const next = card('fy-added-vod-2', { top: 150, left: 160, width: 100, height: 150 });

    film.focus();
    const left = press('ArrowLeft');

    expect(focused()).toBe(film);
    expect(left.defaultPrevented).toBe(false);

    press('ArrowRight');
    expect(focused()).toBe(next);
  });

  // Arrange's position boxes are read-only because its keypad types into them.
  // OK opened them as though they were held back, and raised Android's
  // keyboard over the list.
  it('leaves a field that is read-only in its own right read-only on OK', () => {
    const position = at(document.createElement('input'), { top: 0, left: 0, width: 60, height: 40 });
    position.readOnly = true;
    document.body.appendChild(position);

    position.focus();
    press('Enter');

    expect(position.readOnly).toBe(true);
  });

  it('opens a field it held back itself on OK', () => {
    const from = card('stream-1', { top: 0, left: 0, width: 200, height: 40 });
    const filter = at(document.createElement('input'), { top: 60, left: 0, width: 200, height: 40 });
    document.body.appendChild(filter);

    from.focus();
    press('ArrowDown');
    expect(filter.readOnly).toBe(true);

    press('Enter');
    expect(filter.readOnly).toBe(false);
  });

  // Holding Down in the guide queued repeats faster than moves were drawn, and
  // the screen froze for seconds working through them.
  it('drops a held key’s repeats until the last move has been drawn', () => {
    const top = card('guide-1', { top: 0, left: 0, width: 100, height: 50 });
    const middle = card('guide-2', { top: 60, left: 0, width: 100, height: 50 });
    card('guide-3', { top: 120, left: 0, width: 100, height: 50 });

    top.focus();
    press('ArrowDown');
    const repeat = new KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true, bubbles: true, cancelable: true });
    document.dispatchEvent(repeat);

    expect(focused()).toBe(middle);
    expect(repeat.defaultPrevented).toBe(true);
  });

  // As TiviMate does it: one row at a time at first, further per step once the
  // button has been held a while.
  it('moves further per step the longer Down is held in the guide', () => {
    jest.useFakeTimers();
    const clock = jest.spyOn(performance, 'now');
    try {
      const rows = Array.from({ length: 8 }, (_, index) => {
        const row = at(document.createElement('div'), { top: index * 60, left: 0, width: 600, height: 50 });
        row.setAttribute('data-tv-guide-row', '');
        const channel = at(document.createElement('div'), { top: index * 60, left: 0, width: 100, height: 50 });
        channel.tabIndex = 0;
        channel.setAttribute('data-focus-key', `guide-${index}`);
        row.appendChild(channel);
        document.body.appendChild(row);
        return channel;
      });
      const hold = (at: number, repeat: boolean) => {
        clock.mockReturnValue(at);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', repeat, bubbles: true, cancelable: true }));
        jest.advanceTimersByTime(50);
      };

      rows[0].focus();
      hold(0, false);
      // Too soon after the last move, in the steady first seconds: dropped.
      hold(50, true);
      expect(focused()).toBe(rows[1]);
      hold(500, true);
      expect(focused()).toBe(rows[2]);

      hold(4500, true);
      expect(focused()).toBe(rows[6]);
    } finally {
      clock.mockRestore();
      jest.useRealTimers();
    }
  });

  it('finds the next guide row among the rows beside it', () => {
    const row = (top: number, key: string): HTMLElement => {
      const element = at(document.createElement('div'), { top, left: 0, width: 600, height: 50 });
      element.setAttribute('data-tv-guide-row', '');
      const channel = at(document.createElement('div'), { top, left: 0, width: 100, height: 50 });
      channel.tabIndex = 0;
      channel.setAttribute('data-focus-key', key);
      element.appendChild(channel);
      document.body.appendChild(element);
      return channel;
    };
    const first = row(0, 'guide-1');
    const second = row(60, 'guide-2');

    first.focus();
    press('ArrowDown');

    expect(focused()).toBe(second);
  });

  it('moves to the nearest thing in the direction pressed', () => {
    const top = card('stream-1', { top: 0, left: 0, width: 100, height: 50 });
    const below = card('stream-2', { top: 60, left: 0, width: 100, height: 50 });
    card('stream-3', { top: 60, left: 400, width: 100, height: 50 });

    top.focus();
    press('ArrowDown');

    expect(focused()).toBe(below);
  });

  // Search's field is as wide as the page: under its middle was the TV Shows
  // chip, nearer than the chosen one at its left (round 11).
  it('goes Down to what a control names, when it is on screen', () => {
    const field = card('field', { top: 0, left: 0, width: 1600, height: 50 });
    const chosen = card('chosen', { top: 70, left: 0, width: 120, height: 40 });
    card('middle', { top: 70, left: 760, width: 120, height: 40 });
    chosen.setAttribute('aria-pressed', 'true');
    field.setAttribute('data-tv-down', "[aria-pressed='true']");

    field.focus();
    press('ArrowDown');

    expect(focused()).toBe(chosen);
  });

  it('goes to the nearest when what is named is not on screen', () => {
    const field = card('field', { top: 0, left: 0, width: 1600, height: 50 });
    const middle = card('middle', { top: 70, left: 760, width: 120, height: 40 });
    field.setAttribute('data-tv-down', '[data-nowhere]');

    field.focus();
    press('ArrowDown');

    expect(focused()).toBe(middle);
  });

  it('prefers straight ahead over near but off to the side', () => {
    // Without the drift penalty, three presses of Down walk diagonally out of
    // the column they started in.
    const from = card('stream-1', { top: 0, left: 200, width: 100, height: 50 });
    const ahead = card('stream-2', { top: 120, left: 200, width: 100, height: 50 });
    card('stream-3', { top: 60, left: 0, width: 100, height: 50 });

    from.focus();
    press('ArrowDown');

    expect(focused()).toBe(ahead);
  });

  // Channel names are as wide as their text and share a left edge. Measured
  // centre to centre, the short name two rows down was nearer the line than
  // the long one directly below, and Down stepped over a channel.
  it('does not skip a wider neighbour for a narrower one further on', () => {
    const from = card('guide-1', { top: 0, left: 26, width: 100, height: 16 });
    const wideBelow = card('guide-2', { top: 41, left: 26, width: 174, height: 16 });
    card('guide-3', { top: 82, left: 26, width: 90, height: 16 });

    from.focus();
    press('ArrowDown');

    expect(focused()).toBe(wideBelow);
  });

  // Every block in the next lane that overlaps a long programme is equally
  // "on the line"; the one under its middle is the one meant.
  it('goes to the block underneath the middle, not the first one that overlaps', () => {
    const block = (box: Box): HTMLElement =>
      document.body.appendChild(at(document.createElement('button'), box));

    const from = block({ top: 0, left: 200, width: 600, height: 40 });
    block({ top: 50, left: 150, width: 200, height: 40 });
    const middle = block({ top: 50, left: 400, width: 200, height: 40 });
    block({ top: 50, left: 650, width: 200, height: 40 });

    from.focus();
    press('ArrowDown');

    expect(focused()).toBe(middle);
  });

  describe('along a guide row', () => {
    /** A lane holding programme blocks, as the guide draws each channel's row. */
    const lane = (top: number, blocks: Array<[left: number, width: number]>): HTMLElement[] => {
      const row = at(document.createElement('div'), { top, left: 200, width: 800, height: 40 });
      row.setAttribute('data-tv-guide-lane', '');
      document.body.appendChild(row);
      return blocks.map(([left, width]) =>
        row.appendChild(at(document.createElement('button'), { top: top + 2, left, width, height: 36 }))
      );
    };

    it('stays at the end of a row rather than jumping to one that reaches further', () => {
      // HR| HRT 4's last programme ends at 700; ZDRAVA TV, four rows down, has a
      // sliver at 980. Right used to land on the sliver.
      const [, last] = lane(0, [[200, 250], [460, 240]]);
      lane(200, [[200, 300], [980, 12]]);

      last.focus();
      const event = press('ArrowRight');

      expect(focused()).toBe(last);
      expect(event.defaultPrevented).toBe(true);
    });

    it('still steps along its own row', () => {
      const [first, second] = lane(0, [[200, 250], [460, 240]]);
      lane(50, [[455, 40]]);

      first.focus();
      press('ArrowRight');

      expect(focused()).toBe(second);
    });

    it('goes back to the channel on Left from the first programme', () => {
      const channel = card('guide-1', { top: 0, left: 0, width: 180, height: 40 });
      const [first] = lane(0, [[200, 250]]);
      card('guide-2', { top: 50, left: 0, width: 180, height: 40 });

      first.focus();
      press('ArrowLeft');

      expect(focused()).toBe(channel);
    });

    it('goes back to the channel on Left from a programme that began under the names', () => {
      // Zvijezde u podne, 16:15 to 18:20, in a guide opened at 18:00: most of
      // it lies under the channel names, and Left went nowhere (23 October).
      const row = at(document.createElement('div'), { top: 0, left: 0, width: 1000, height: 40 });
      row.setAttribute('data-tv-guide-row', '');
      const names = row.appendChild(at(document.createElement('div'), { top: 0, left: 0, width: 240, height: 40 }));
      const channel = names.appendChild(at(document.createElement('button'), { top: 0, left: 0, width: 240, height: 40 }));
      channel.setAttribute('data-focus-key', 'guide-1');
      const laneRow = row.appendChild(at(document.createElement('div'), { top: 0, left: 0, width: 1000, height: 40 }));
      laneRow.setAttribute('data-tv-guide-lane', '');
      const begunEarlier = laneRow.appendChild(at(document.createElement('button'), { top: 2, left: -400, width: 750, height: 36 }));
      document.body.appendChild(row);

      begunEarlier.focus();
      press('ArrowLeft');

      expect(focused()).toBe(channel);
    });

    describe('in lanes that scroll sideways', () => {
      /** The lanes' scroller, scrolled to `left`, which a test can read back. */
      const lanes = (left: number): HTMLElement => {
        const scroller = at(document.createElement('div'), { top: 0, left: 0, width: 1000, height: 400 });
        overflows.set(scroller, { x: 'auto', y: 'auto' });
        let position = left;
        Object.defineProperty(scroller, 'scrollLeft', {
          configurable: true,
          get: () => position,
          set: (value: number) => (position = value)
        });
        document.body.appendChild(scroller);
        return scroller;
      };
      const block = (scroller: HTMLElement, top: number, left: number, width: number): HTMLElement => {
        const row = at(document.createElement('div'), { top, left: 0, width: 1000, height: 40 });
        row.setAttribute('data-tv-guide-lane', '');
        scroller.appendChild(row);
        const button = at(document.createElement('button'), { top: top + 2, left, width, height: 36 });
        // Bringing all of it into view, as the browser does, means scrolling
        // back to where it starts.
        button.scrollIntoView = jest.fn(() => (scroller.scrollLeft = 0));
        return row.appendChild(button);
      };

      it('keeps the lanes where they are when Down reaches a programme that began further back', () => {
        // Three presses down an evening guide showed the afternoon (10 October).
        const scroller = lanes(500);
        const from = block(scroller, 0, 300, 200);
        const below = block(scroller, 50, 0, 600);

        from.focus();
        press('ArrowDown');

        expect(focused()).toBe(below);
        expect(scroller.scrollLeft).toBe(500);
      });

      it('still moves through time on Right', () => {
        const scroller = lanes(500);
        const from = block(scroller, 0, 100, 200);
        const row = from.parentElement!;
        const next = row.appendChild(at(document.createElement('button'), { top: 2, left: 310, width: 200, height: 36 }));
        next.scrollIntoView = jest.fn(() => (scroller.scrollLeft = 0));

        from.focus();
        press('ArrowRight');

        expect(focused()).toBe(next);
        expect(scroller.scrollLeft).toBe(0);
      });
    });
  });

  it('turns on the television presentation at the first press of a direction', () => {
    expect(service.isTelevision()).toBe(false);

    press('ArrowDown');

    expect(service.isTelevision()).toBe(true);
    expect(document.documentElement.classList.contains('tv')).toBe(true);
  });

  it('leaves the desktop app alone, whatever arrow is pressed', () => {
    // The first arrow on a keyboard turned the desktop window into the
    // television layout, with no way back (26 September).
    mockPlatform = 'electron';
    try {
      TestBed.resetTestingModule();
      document.documentElement.className = '';
      const desktop = TestBed.inject(TvNavigationService);
      desktop.install();
      service = desktop;
      card('a', { top: 0, left: 0, width: 100, height: 100 }).focus();
      const event = press('ArrowRight');

      expect(desktop.isTelevision()).toBe(false);
      expect(document.documentElement.classList.contains('tv')).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      mockPlatform = 'android';
    }
  });

  describe('when the scroller recycles the row being stood on', () => {
    beforeEach(() => {
      // A D-pad press with nothing on screen yet, which is all it takes: this
      // service does nothing for a scroll until it has seen one, and by the
      // time anybody is scrolling a list with a remote it has.
      press('ArrowDown');
    });

    it('puts focus back on the same item once it is rendered again', () => {
      // The fault this exists for. The element focus was on is gone; the
      // channel it stood for is not, and the person's place is the channel.
      const standing = card('stream-412', { top: 200, left: 0, width: 100, height: 50 });
      standing.focus();

      recycle(standing);
      const rebuilt = card('stream-412', { top: 140, left: 0, width: 100, height: 50 });
      document.dispatchEvent(new Event('scroll'));

      expect(focused()).toBe(rebuilt);
    });

    it('puts it back on the same control inside that item', () => {
      // A card holds a star and a guide button as well as itself, so the item
      // alone is not enough to say where somebody was.
      const standing = card('stream-412', { top: 200, left: 0, width: 100, height: 50 }, [
        'star',
        'guide'
      ]);
      const guide = standing.querySelectorAll('button')[1];
      guide.focus();

      recycle(standing);
      const rebuilt = card('stream-412', { top: 140, left: 0, width: 100, height: 50 }, [
        'star',
        'guide'
      ]);
      document.dispatchEvent(new Event('scroll'));

      expect(focused()).toBe(rebuilt.querySelectorAll('button')[1]);
    });

    it('settles for the item when the control inside it has gone', () => {
      // Leaving arrange mode takes two chevrons off every row.
      const standing = card('category-9', { top: 100, left: 0, width: 100, height: 30 }, [
        'name',
        'up',
        'down'
      ]);
      standing.querySelectorAll('button')[2].focus();

      recycle(standing);
      const rebuilt = card('category-9', { top: 100, left: 0, width: 100, height: 30 }, ['name']);
      document.dispatchEvent(new Event('scroll'));

      expect(focused()).toBe(rebuilt.querySelector('button'));
    });

    it('lands where the eye was when the item has really gone', () => {
      // A filter typed, or the category changed underneath. There is no right
      // row any more, so the nearest thing to where it was beats the top of
      // the list -- which is where this used to go, and why a lost row felt
      // like being thrown out of the list altogether.
      card('stream-1', { top: 0, left: 0, width: 100, height: 50 });
      const near = card('stream-99', { top: 620, left: 0, width: 100, height: 50 });

      const standing = card('stream-412', { top: 600, left: 0, width: 100, height: 50 });
      standing.focus();
      recycle(standing);

      expect(focused()).toBe(near);
    });

    it('answers the next press by coming back, not by moving from nowhere', () => {
      // The scroll hook is the one that makes the ring reappear unprompted,
      // and it depends on a scroll event this cannot promise. A press must put
      // things right even when nothing else did.
      const standing = card('stream-412', { top: 300, left: 0, width: 100, height: 50 });
      card('stream-1', { top: 0, left: 0, width: 100, height: 50 });

      standing.focus();
      standing.remove();
      const rebuilt = card('stream-412', { top: 300, left: 0, width: 100, height: 50 });

      press('ArrowDown');

      expect(focused()).toBe(rebuilt);
    });

  });

  it('does not take focus back on a device that has never seen a D-pad', () => {
    // Every phone and tablet runs this too, and no arrow is pressed above.
    // Focus resting on the body after a scroll is ordinary there, and taking
    // it back would raise the keyboard over whatever somebody was reading.
    const standing = card('stream-412', { top: 300, left: 0, width: 100, height: 50 });
    standing.focus();
    standing.remove();
    card('stream-412', { top: 300, left: 0, width: 100, height: 50 });

    document.dispatchEvent(new Event('scroll'));

    expect(focused()).toBe(document.body);
  });

  describe('a search box being walked past', () => {
    /** A field, laid out below whatever the test focuses first. */
    const field = (box: Box): HTMLInputElement => {
      const input = at(document.createElement('input'), box);
      input.type = 'text';
      document.body.appendChild(input);
      return input;
    };

    it('does not let it summon the on-screen keyboard', () => {
      // Photographed on the television: focus reached the category filter and
      // Android's keyboard came up over the bottom two thirds of the screen,
      // covering the list being walked through. Nothing was going to be typed;
      // the field was simply in the way.
      const from = card('stream-1', { top: 0, left: 0, width: 100, height: 50 });
      const search = field({ top: 60, left: 0, width: 100, height: 40 });

      from.focus();
      press('ArrowDown');

      expect(focused()).toBe(search);
      expect(search.readOnly).toBe(true);
    });

    it('gives the keyboard back when somebody presses Enter on it', () => {
      const from = card('stream-1', { top: 0, left: 0, width: 100, height: 50 });
      const search = field({ top: 60, left: 0, width: 100, height: 40 });

      from.focus();
      press('ArrowDown');
      press('Enter');

      expect(search.readOnly).toBe(false);
      expect(focused()).toBe(search);
    });

    it('leaves the arrows alone once somebody is typing', () => {
      // Left and right move the caret. Taking those would make the field
      // unusable with the only input device in the room. "Typing" is the point
      // after Enter, which is what hands the keyboard over -- before it there
      // is no caret for an arrow to move.
      const from = card('stream-1', { top: 0, left: 0, width: 100, height: 50 });
      const search = field({ top: 60, left: 0, width: 100, height: 40 });
      card('stream-2', { top: 60, left: 200, width: 100, height: 50 });

      from.focus();
      press('ArrowDown');
      press('Enter');
      press('ArrowRight');

      expect(focused()).toBe(search);
    });

    it('carries on past a field nobody has started typing in', () => {
      // The other half of the same rule, and the one that was wrong. A field
      // being walked past is read-only and has no caret, so holding the arrows
      // there only strands whatever sits beside it: the category panel's filter
      // is next to Arrange, and Right on it reached nothing at all.
      const from = card('stream-1', { top: 0, left: 0, width: 100, height: 50 });
      field({ top: 60, left: 0, width: 100, height: 40 });
      const beside = card('stream-2', { top: 60, left: 200, width: 100, height: 50 });

      from.focus();
      press('ArrowDown');
      press('ArrowRight');

      expect(focused()).toBe(beside);
    });
  });

  it('will not put focus on a control that cannot be seen', () => {
    // The star on an unfocused card is at opacity zero and still has a size.
    // Focusing it would light the card up around a cross nobody can see, and
    // the next press of Enter would unstar what looked like it was about to
    // open.
    const from = card('stream-1', { top: 0, left: 0, width: 100, height: 50 });
    const below = card('stream-2', { top: 60, left: 0, width: 100, height: 50 }, ['star']);
    invisible.add(below.querySelector('button') as Element);

    from.focus();
    press('ArrowDown');

    expect(focused()).toBe(below);
  });

  describe('things cut off by a box around them', () => {
    /** A container with declared overflow and, optionally, content to scroll. */
    const container = (
      box: Box,
      overflow: { x: string; y: string },
      scroll: { width?: number; height?: number } = {}
    ): HTMLElement => {
      const element = at(document.createElement('div'), box);
      overflows.set(element, overflow);
      Object.defineProperty(element, 'clientWidth', { value: box.width });
      Object.defineProperty(element, 'clientHeight', { value: box.height });
      Object.defineProperty(element, 'scrollWidth', { value: scroll.width ?? box.width });
      Object.defineProperty(element, 'scrollHeight', { value: scroll.height ?? box.height });
      document.body.appendChild(element);
      return element;
    };

    // The collapsed category sidebar: a strip ten pixels wide, whose rows go
    // on measuring two hundred and lie invisibly under the channel column. Down
    // from a channel found the row underneath it and focus vanished into the
    // hidden list.
    it('measures a row by the part of it a clipping strip leaves showing', () => {
      const strip = container({ top: 0, left: 0, width: 10, height: 400 }, { x: 'hidden', y: 'hidden' });
      // Squeezed to two pixels, as on the emulator: the rows overflow it
      // sideways, so it technically scrolls in that direction too.
      const list = container(
        { top: 0, left: 0, width: 2, height: 400 },
        { x: 'auto', y: 'auto' },
        { width: 200, height: 4000 }
      );
      strip.appendChild(list);
      const hiddenRow = at(document.createElement('button'), { top: 20, left: 0, width: 200, height: 30 });
      list.appendChild(hiddenRow);

      const channel = card('guide-1', { top: 0, left: 20, width: 150, height: 16 });
      const nextChannel = card('guide-2', { top: 41, left: 20, width: 100, height: 16 });

      channel.focus();
      press('ArrowDown');

      expect(focused()).toBe(nextChannel);
    });

    // The channel grid: a vertical scroller inside an overflow-y: hidden
    // wrapper. Clipping by the wrapper would make every row below the fold
    // unreachable, and the list could never be walked past its first screen.
    it('still reaches the row below the fold of a list inside a clipped wrapper', () => {
      const wrapper = container({ top: 0, left: 0, width: 400, height: 200 }, { x: 'auto', y: 'hidden' });
      const scroller = container(
        { top: 0, left: 0, width: 400, height: 200 },
        { x: 'auto', y: 'auto' },
        { height: 2000 }
      );
      wrapper.appendChild(scroller);
      const visible = at(document.createElement('button'), { top: 100, left: 0, width: 100, height: 80 });
      const belowFold = at(document.createElement('button'), { top: 190, left: 0, width: 100, height: 80 });
      scroller.append(visible, belowFold);

      visible.focus();
      press('ArrowDown');

      expect(focused()).toBe(belowFold);
    });
  });
});
