import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Category, SETTING_KEYS, StreamType } from '@shared/types';
import { SettingsService } from './settings.service';
import { NativePlayerService } from './native-player.service';
import {
  CategorySets,
  DEFAULT_IDLE_MINUTES,
  LockSettings,
  categoriesShown,
  hashPin,
  lockIsDue,
  newSalt,
  noCategories,
  readCategorySets,
  readLockSettings,
  withCategory,
  writeCategorySets
} from '../utils/category-lock.utils';

/** What the PIN pad on screen is being asked for. See PinDialogComponent. */
export interface PinRequest {
  /** 'enter' checks a PIN against the stored one; 'create' asks for a new one twice. */
  mode: 'enter' | 'create';
  /** What the PIN is being asked for -- a category's name -- said under the title. */
  subject?: string;
  /** For 'enter': whether this is the PIN. The pad stays open until it is, or until it is closed. */
  check?: (pin: string) => Promise<boolean>;
  /** The chosen PIN for 'create', the PIN given for 'enter', or null if closed. */
  finish: (pin: string | null) => void;
}

/** How often an unlocked device looks at whether it has been left alone long enough. */
const IDLE_CHECK_MS = 20_000;

/**
 * Hidden categories, locked categories, and whether this device is unlocked.
 *
 * The lists and the PIN are account settings (see category-lock.utils.ts);
 * being unlocked is this device's alone and lasts until it locks again -- on
 * the next start, after the idle time, or on "Lock now". Everything that lists
 * categories or what is in them asks this, through XtreamService, so a locked
 * category disappears from the category list, Browse, favourites, history,
 * search and For You together.
 */
@Injectable({ providedIn: 'root' })
export class ParentalLockService {
  private readonly settings = inject(SettingsService);
  private readonly nativePlayer = inject(NativePlayerService);

  readonly hidden = computed<CategorySets>(() =>
    readCategorySets(this.settings.get(SETTING_KEYS.hiddenCategories))
  );

  readonly lockSettings = computed<LockSettings | null>(() =>
    readLockSettings(this.settings.get(SETTING_KEYS.parentalLock))
  );

  readonly hasPin = computed(() => this.lockSettings() !== null);

  /**
   * Locked categories. None without a PIN: a lock nobody can open would only
   * be a category gone for good.
   */
  readonly locked = computed<CategorySets>(() =>
    this.hasPin() ? readCategorySets(this.settings.get(SETTING_KEYS.lockedCategories)) : noCategories()
  );

  /** This device, since it last started or locked. Never stored anywhere. */
  readonly unlocked = signal(false);

  /** Whether locked categories are being kept out of sight right now. */
  readonly engaged = computed(() => this.hasPin() && !this.unlocked());

  readonly idleMinutes = computed(() => this.lockSettings()?.idleMinutes ?? DEFAULT_IDLE_MINUTES);

  /** Whether anything is locked at all -- what decides if "Lock now" is worth showing. */
  readonly anyLocked = computed(() => {
    const locked = this.locked();
    return locked.live.length + locked.vod.length + locked.series.length > 0;
  });

  /** Changes whenever what a list should show could have changed. */
  readonly revision = computed(() => ({
    hidden: this.hidden(),
    locked: this.locked(),
    engaged: this.engaged()
  }));

  /** The PIN pad's current job, for the one PinDialogComponent the shell holds. */
  readonly request = signal<PinRequest | null>(null);

  private lastActivity = Date.now();

  constructor() {
    const touch = () => this.noteActivity();
    // Not passive, however tempting for a listener that only notes the time.
    // zone.js, while the app had it, gave each target, event and phase one
    // native listener, made with the options of whoever registered first --
    // and this registers first. Passive, it made every later capture listener on the window
    // unable to cancel a key: holding OK chose the panel's first action again,
    // the hold-OK fix of 28 September silently undone (29 September).
    const options = { capture: true } as const;
    for (const event of ['keydown', 'pointerdown', 'touchstart', 'wheel'] as const) {
      window.addEventListener(event, touch, options);
    }
    const timer = setInterval(() => this.lockIfIdle(), IDLE_CHECK_MS);

    // A player closing is somebody who was watching until a moment ago. The
    // page behind a native player hears nothing while it plays, so without
    // this the first check after a long film would find it "idle" for the
    // length of the film.
    effect(() => {
      this.nativePlayer.active();
      untracked(() => this.noteActivity());
    });

    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      for (const event of ['keydown', 'pointerdown', 'touchstart', 'wheel'] as const) {
        window.removeEventListener(event, touch, options);
      }
    });
  }

  // --- What to show --------------------------------------------------------

  shown(type: StreamType, categories: Category[]): Category[] {
    return categoriesShown(categories, this.hidden()[type], this.locked()[type], this.engaged());
  }

  isHidden(type: StreamType, categoryId: string): boolean {
    return this.hidden()[type].includes(String(categoryId));
  }

  isLocked(type: StreamType, categoryId: string): boolean {
    return this.locked()[type].includes(String(categoryId));
  }

  /** Whether a category's contents are out of sight right now: hidden, or locked and not opened. */
  keepsOut(type: StreamType, categoryId: string | number | null | undefined): boolean {
    if (categoryId === null || categoryId === undefined) {
      return false;
    }
    const id = String(categoryId);
    return this.hidden()[type].includes(id) || (this.engaged() && this.locked()[type].includes(id));
  }

  /** The locked categories whose contents must not show anywhere right now. */
  lockedOutOf(type: StreamType): string[] {
    return this.engaged() ? this.locked()[type] : [];
  }

  // --- Changing them ---------------------------------------------------------

  setHidden(type: StreamType, categoryId: string, hidden: boolean): void {
    this.settings.set(
      SETTING_KEYS.hiddenCategories,
      writeCategorySets(withCategory(this.hidden(), type, categoryId, hidden))
    );
  }

  /**
   * Locks or unlocks one category. Locking the first one asks for a PIN to be
   * chosen; changing anything while locked asks for the PIN first, or a child
   * could simply take the lock off.
   */
  async setLocked(type: StreamType, categoryId: string, locked: boolean, name?: string): Promise<boolean> {
    if (!this.hasPin()) {
      if (!locked || !(await this.choosePin())) {
        return false;
      }
    } else if (!(await this.unlock(name))) {
      return false;
    }
    this.settings.set(
      SETTING_KEYS.lockedCategories,
      writeCategorySets(withCategory(this.locked(), type, categoryId, locked))
    );
    return true;
  }

  /**
   * Hidden and locked categories moved to a replaced provider's new ids (see
   * shared/providers/carryOver.ts). No PIN asked: nothing is unlocked, the
   * same categories stay behind it under their new names.
   */
  moveCategories(type: StreamType, moves: ReadonlyMap<string, string>): number {
    let count = 0;
    const moved = (sets: CategorySets): CategorySets | null => {
      const ids = sets[type].map(id => moves.get(id) ?? id);
      const changed = ids.filter((id, i) => id !== sets[type][i]).length;
      count += changed;
      return changed ? { ...sets, [type]: ids } : null;
    };
    const hidden = moved(this.hidden());
    if (hidden) {
      this.settings.set(SETTING_KEYS.hiddenCategories, writeCategorySets(hidden));
    }
    const locked = this.hasPin() ? moved(this.locked()) : null;
    if (locked) {
      this.settings.set(SETTING_KEYS.lockedCategories, writeCategorySets(locked));
    }
    return count;
  }

  // --- The PIN -----------------------------------------------------------------

  /** Asks for the PIN if this device is locked. True once it is unlocked. */
  async unlock(subject?: string): Promise<boolean> {
    const stored = this.lockSettings();
    if (!stored || this.unlocked()) {
      return true;
    }
    const pin = await this.ask({
      mode: 'enter',
      subject,
      check: async given => (await hashPin(given, stored.salt)) === stored.hash
    });
    if (pin === null) {
      return false;
    }
    this.unlocked.set(true);
    this.noteActivity();
    return true;
  }

  /**
   * Asks for another account's PIN, for entering that account's profile on
   * this device (FamilyProfilesService) -- without unlocking anything here.
   */
  async askForPinOf(stored: LockSettings, subject: string): Promise<boolean> {
    const pin = await this.ask({
      mode: 'enter',
      subject,
      check: async given => (await hashPin(given, stored.salt)) === stored.hash
    });
    return pin !== null;
  }

  lockNow(): void {
    this.unlocked.set(false);
  }

  /** A new PIN, or the first one. Changing one asks for the old one first. */
  async choosePin(): Promise<boolean> {
    if (this.hasPin() && !(await this.unlock())) {
      return false;
    }
    const pin = await this.ask({ mode: 'create' });
    if (pin === null) {
      return false;
    }
    const salt = newSalt();
    const stored: LockSettings = { salt, hash: await hashPin(pin, salt), idleMinutes: this.idleMinutes() };
    this.settings.set(SETTING_KEYS.parentalLock, JSON.stringify(stored));
    // Whoever just chose it is the one person entitled to be past it.
    this.unlocked.set(true);
    this.noteActivity();
    return true;
  }

  /** Takes the PIN away, and with it every lock -- after asking for it. */
  async removePin(): Promise<boolean> {
    if (!this.hasPin()) {
      return true;
    }
    if (!(await this.unlock())) {
      return false;
    }
    this.settings.set(SETTING_KEYS.lockedCategories, writeCategorySets(noCategories()));
    this.settings.set(SETTING_KEYS.parentalLock, '');
    this.unlocked.set(false);
    return true;
  }

  async setIdleMinutes(minutes: number): Promise<void> {
    const stored = this.lockSettings();
    if (!stored || stored.idleMinutes === minutes || !(await this.unlock())) {
      return;
    }
    this.settings.set(SETTING_KEYS.parentalLock, JSON.stringify({ ...stored, idleMinutes: minutes }));
  }

  // --- Idle ----------------------------------------------------------------------

  /** Something happened that a person did, or a player reported playing. */
  noteActivity(): void {
    this.lastActivity = Date.now();
  }

  private lockIfIdle(): void {
    const due = lockIsDue({
      unlocked: this.unlocked(),
      playing: this.nativePlayer.active(),
      idleMinutes: this.idleMinutes(),
      lastActivityMs: this.lastActivity,
      nowMs: Date.now()
    });
    if (due) {
      this.lockNow();
    }
  }

  private ask(request: Omit<PinRequest, 'finish'>): Promise<string | null> {
    // One at a time: a second question closes the first unanswered.
    this.request()?.finish(null);
    return new Promise(resolve => {
      const asked: PinRequest = {
        ...request,
        finish: pin => {
          if (this.request() === asked) {
            this.request.set(null);
          }
          resolve(pin);
        }
      };
      this.request.set(asked);
    });
  }
}
