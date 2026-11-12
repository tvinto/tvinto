import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { webcrypto } from 'crypto';
import { Category } from '@shared/types';
import { SettingsService } from './settings.service';
import { NativePlayerService } from './native-player.service';
import { ParentalLockService } from './parental-lock.service';

/**
 * The lock as somebody meets it: a PIN chosen when the first category is
 * locked, locked categories gone until it is given, a wrong PIN turned away,
 * and nothing about the lock changeable from a locked device.
 */

// jsdom has no SubtleCrypto; the app's targets all do.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const PIN = '2468';

const category = (id: string): Category =>
  ({ category_id: id, category_name: `C${id}`, parent_id: '0' }) as Category;

describe('ParentalLockService', () => {
  let values: ReturnType<typeof signal<Record<string, string>>>;
  let lock: ParentalLockService;

  beforeEach(() => {
    values = signal<Record<string, string>>({});
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsService,
          useValue: {
            get: (key: string) => values()[key] ?? null,
            set: (key: string, value: string) => values.update(current => ({ ...current, [key]: value }))
          }
        },
        { provide: NativePlayerService, useValue: { active: signal(false) } }
      ]
    });
    lock = TestBed.inject(ParentalLockService);
  });

  /** Answers the pad the way a person would: `pins` in turn, then gives up. */
  const answer = (...pins: string[]) => {
    const asked: string[] = [];
    let busy = false;
    const respond = async () => {
      const request = lock.request();
      if (!request || busy) {
        return;
      }
      busy = true;
      asked.push(request.mode);
      const pin = pins.shift();
      if (pin === undefined) {
        request.finish(null);
      } else if (request.mode === 'enter') {
        if (await request.check!(pin)) {
          request.finish(pin);
        }
      } else {
        request.finish(pin);
      }
      busy = false;
    };
    const timer = setInterval(respond, 1);
    return { asked, stop: () => clearInterval(timer) };
  };

  it('asks for a PIN to be chosen when the first category is locked, and keeps only its hash', async () => {
    const pad = answer(PIN);
    expect(await lock.setLocked('vod', '7', true)).toBe(true);
    pad.stop();

    expect(pad.asked).toEqual(['create']);
    expect(lock.isLocked('vod', '7')).toBe(true);
    expect(values()['parentalLock']).not.toContain(PIN);
    // Whoever chose it is past it.
    expect(lock.unlocked()).toBe(true);
  });

  it('keeps locked categories out of the list until the PIN is given, and turns a wrong one away', async () => {
    let pad = answer(PIN);
    await lock.setLocked('vod', '7', true);
    pad.stop();
    lock.lockNow();

    const all = [category('6'), category('7')];
    expect(lock.shown('vod', all).map(c => c.category_id)).toEqual(['6']);
    expect(lock.keepsOut('vod', '7')).toBe(true);

    pad = answer('1111', PIN);
    expect(await lock.unlock()).toBe(true);
    pad.stop();
    expect(lock.shown('vod', all).map(c => c.category_id)).toEqual(['6', '7']);
  });

  it('leaves the lock alone when the PIN is not given', async () => {
    let pad = answer(PIN);
    await lock.setLocked('vod', '7', true);
    pad.stop();
    lock.lockNow();

    pad = answer();
    expect(await lock.setLocked('vod', '7', false)).toBe(false);
    expect(await lock.removePin()).toBe(false);
    pad.stop();
    expect(lock.isLocked('vod', '7')).toBe(true);
    expect(lock.hasPin()).toBe(true);
  });

  it('takes every lock away with the PIN', async () => {
    let pad = answer(PIN);
    await lock.setLocked('series', '3', true);
    pad.stop();
    lock.lockNow();

    pad = answer(PIN);
    expect(await lock.removePin()).toBe(true);
    pad.stop();
    expect(lock.hasPin()).toBe(false);
    expect(lock.anyLocked()).toBe(false);
    expect(lock.engaged()).toBe(false);
  });

  it('notes activity with listeners that leave keys cancellable', () => {
    // zone.js shares one native listener per target, event and phase, made
    // with the first registration's options: a passive one here took the
    // hold-OK fix's ability to cancel OK away from every later listener.
    const added = jest.spyOn(window, 'addEventListener');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsService, useValue: { get: () => null, set: () => undefined } },
        { provide: NativePlayerService, useValue: { active: signal(false) } }
      ]
    });
    TestBed.inject(ParentalLockService);
    const passive = added.mock.calls.filter(
      ([, , options]) => typeof options === 'object' && options !== null && (options as AddEventListenerOptions).passive
    );
    expect(passive).toEqual([]);
    added.mockRestore();
  });

  it('hides without a PIN, and a hidden category stays out whether locked or not', () => {
    lock.setHidden('live', '9', true);
    expect(lock.shown('live', [category('9'), category('10')]).map(c => c.category_id)).toEqual(['10']);
    expect(lock.request()).toBeNull();
    lock.setHidden('live', '9', false);
    expect(lock.keepsOut('live', '9')).toBe(false);
  });
});
