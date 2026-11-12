import { TestBed } from '@angular/core/testing';
import { Router, NavigationEnd, NavigationStart, Event as RouterEvent } from '@angular/router';
import { Subject } from 'rxjs';
import { PlaceMemoryService } from './place-memory.service';

/**
 * Back arriving where it left from.
 *
 * The fault this is for: back from a show, the TV Shows grid came back at its
 * top, however far down the show had been (26 September). Nothing threw; the
 * remote just had to walk the whole way down again.
 *
 * jsdom lays nothing out, so "where on screen" is not tested here -- only
 * which card, when, and when not.
 */
describe('PlaceMemoryService', () => {
  let events: Subject<RouterEvent>;
  let router: { events: Subject<RouterEvent>; url: string };
  let places: PlaceMemoryService;
  let id = 0;

  /** A focusable keyed card, drawn -- jsdom reports no boxes for anything. */
  const card = (key: string): HTMLElement => {
    const element = document.createElement('div');
    element.tabIndex = 0;
    element.setAttribute('data-focus-key', key);
    element.getClientRects = () => [{}] as unknown as DOMRectList;
    document.body.appendChild(element);
    return element;
  };

  const go = (url: string, trigger: 'imperative' | 'popstate' = 'imperative') => {
    id += 1;
    events.next(new NavigationStart(id, url, trigger));
    router.url = url;
    events.next(new NavigationEnd(id, url, url));
  };

  beforeAll(() => {
    (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
    events = new Subject<RouterEvent>();
    router = { events, url: '/for-you' };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: Router, useValue: router }] });
    places = TestBed.inject(PlaceMemoryService);
    places.install();
  });

  afterEach(() => jest.useRealTimers());

  /** On the grid, in a category, standing on a show -- then into it. */
  const intoAShow = () => {
    router.url = '/shows?category=5';
    card('stream-42').focus();
    go('/series/42?name=Gangs');
    document.body.innerHTML = '';
  };

  it('notes the card focus was on when a screen is left', () => {
    intoAShow();

    expect(places.placeAt('/shows?category=5')?.key).toBe('stream-42');
  });

  it('puts focus back on it when Back arrives there, once it is drawn', () => {
    intoAShow();
    go('/shows?category=5', 'popstate');
    jest.advanceTimersByTime(300);
    // The category is still loading: nothing to find yet.
    expect(document.activeElement).toBe(document.body);

    const show = card('stream-42');
    jest.advanceTimersByTime(100);

    expect(document.activeElement).toBe(show);
  });

  it('asks a virtual list to bring the card in while it is not drawn', () => {
    const asked: string[] = [];
    TestBed.runInInjectionContext(() => places.revealWith(key => (asked.push(key), false)));
    intoAShow();

    go('/shows?category=5', 'popstate');
    jest.advanceTimersByTime(250);

    expect(asked[0]).toBe('stream-42');
  });

  it('stops asking once the list says it knows the card', () => {
    let asked = 0;
    TestBed.runInInjectionContext(() => places.revealWith(() => ((asked += 1), true)));
    intoAShow();

    go('/shows?category=5', 'popstate');
    jest.advanceTimersByTime(1000);

    expect(asked).toBe(1);
  });

  it('leaves focus in a dialog shown on the way back, and puts the card back once it closes', () => {
    // A play from a film's page failed: the page is returned to with the error up.
    intoAShow();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    const close = document.createElement('button');
    dialog.appendChild(close);
    document.body.appendChild(dialog);
    close.focus();

    go('/shows?category=5', 'popstate');
    const show = card('stream-42');
    jest.advanceTimersByTime(500);
    expect(document.activeElement).toBe(close);

    // OK on Close answers the dialog; it is not a move away from the card.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    dialog.remove();
    jest.advanceTimersByTime(200);

    expect(document.activeElement).toBe(show);
  });

  it('leaves a screen opened afresh at its top', () => {
    // From the menu, not Back: that is asking for the screen, not returning to it.
    intoAShow();
    go('/shows?category=5');
    card('stream-42');
    jest.advanceTimersByTime(500);

    expect(document.activeElement).toBe(document.body);
  });

  it('gives up the moment somebody presses a key', () => {
    intoAShow();
    go('/shows?category=5', 'popstate');
    jest.advanceTimersByTime(200);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    card('stream-42');
    jest.advanceTimersByTime(500);

    expect(document.activeElement).toBe(document.body);
  });

  it('is not fooled by a screen rewriting its own address', () => {
    // The section notes the category it opened in the address, in place, while
    // it loads -- focus is on nothing then, and that is not where anybody was.
    intoAShow();
    go('/shows?category=5', 'popstate');
    go('/shows?category=5');
    const show = card('stream-42');
    jest.advanceTimersByTime(200);

    expect(document.activeElement).toBe(show);
    expect(places.placeAt('/shows?category=5')?.key).toBe('stream-42');
  });

  it('forgets a screen left with nothing focused, rather than returning to stale focus', () => {
    intoAShow();
    router.url = '/shows?category=5';
    go('/for-you');

    expect(places.placeAt('/shows?category=5')).toBeNull();
  });

  it('holds the card while the screen settles, and lets go once focus has moved on', () => {
    intoAShow();
    go('/shows?category=5', 'popstate');
    const show = card('stream-42');
    jest.advanceTimersByTime(100);
    expect(document.activeElement).toBe(show);

    const other = card('stream-43');
    other.focus();
    jest.advanceTimersByTime(3000);

    expect(document.activeElement).toBe(other);
  });

  it('stops looking when the app goes somewhere else before the card appears', () => {
    intoAShow();
    go('/shows?category=5', 'popstate');
    go('/movies');
    card('stream-42');
    jest.advanceTimersByTime(500);

    expect(document.activeElement).toBe(document.body);
  });
});
