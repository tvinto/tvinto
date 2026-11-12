import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { TPipe } from '../../pipes/t.pipe';
import { DialogShellComponent } from '../../ui/dialog-shell.component';
import { PinPadComponent } from '../../ui/pin-pad.component';
import { ParentalLockService } from '../../services/parental-lock.service';
import { BackButtonService } from '../../services/back-button.service';
import { PIN_LENGTH } from '../../utils/category-lock.utils';

/** Wrong PINs in a row before the pad makes you wait (TV-24). */
const TRIES_BEFORE_PAUSE = 5;
const PAUSE_MS = 30_000;

/**
 * The PIN pad, for whatever ParentalLockService is asking (TV-23, TV-24, P-13).
 *
 * One of these, in the app's root, rather than one per screen that can ask:
 * the lock is asked from the category list, the account page and anywhere a
 * locked thing is reached, and they all want the same pad.
 *
 * Digits on screen, because a television has no keyboard and a text field
 * would raise Android's over the pad. A strict 3×4 grid, so the D-pad moves
 * as on a phone keypad, starting on 5, the centre -- two presses from any key.
 * A keyboard's or the remote's own digits work as well, and the fourth one
 * submits, so there is no OK to find.
 */
@Component({
  selector: 'app-pin-dialog',
  standalone: true,
  imports: [TPipe, HlmButton, DialogShellComponent, PinPadComponent],
  templateUrl: './pin-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PinDialogComponent {
  private readonly lock = inject(ParentalLockService);
  private readonly back = inject(BackButtonService);

  readonly request = this.lock.request;
  readonly open = computed(() => this.request() !== null);

  readonly typed = signal('');
  /** The first entry of a new PIN, while waiting for it again. */
  private readonly first = signal<string | null>(null);
  readonly problem = signal<'wrong' | 'mismatch' | null>(null);
  readonly checking = signal(false);
  /** Bumped on a wrong PIN, so the dots can shake once more each time. */
  readonly wobble = signal(0);

  /** Wrong PINs in a row, and until when the pad refuses more (kept across openings). */
  private failures = 0;
  readonly pausedUntil = signal(0);
  readonly secondsLeft = signal(0);


  readonly title = computed(() => {
    if (this.request()?.mode === 'enter') {
      return this.problem() === 'wrong' ? 'lock.pad.wrongTitle' : 'lock.pad.enterTitle';
    }
    if (this.problem() === 'mismatch') {
      return 'lock.pad.mismatchTitle';
    }
    return this.first() === null ? 'lock.pad.createTitle' : 'lock.pad.confirmTitle';
  });

  /** The line under the title: what it is for, or which step. */
  readonly subtitle = computed(() => {
    const asking = this.request();
    if (!asking) {
      return '';
    }
    if (asking.mode === 'create') {
      if (this.problem() === 'mismatch') {
        return 'lock.pad.stepAgain';
      }
      return this.first() === null ? 'lock.pad.stepOne' : 'lock.pad.stepTwo';
    }
    return asking.subject ? 'lock.pad.for' : '';
  });

  /** Where focus was when the pad opened, to go back to when it closes. */
  private returnTo: HTMLElement | null = null;
  private release: (() => void) | null = null;
  private ticking: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const asking = this.request();
      untracked(() => {
        this.typed.set('');
        this.first.set(null);
        this.problem.set(null);
        this.checking.set(false);
        if (asking) {
          this.returnTo = document.activeElement as HTMLElement | null;
          this.listenForBack();
        } else {
          this.release?.();
          this.release = null;
          if (this.returnTo) {
            const back = this.returnTo;
            this.returnTo = null;
            requestAnimationFrame(() => {
              if (back.isConnected) {
                back.focus({ preventScroll: true });
              }
            });
          }
        }
      });
    });

    // On the window in the capture phase, ahead of the screens underneath: the
    // guide takes digits as channel numbers, and they are the PIN's here.
    const onKey = (event: KeyboardEvent) => {
      if (!this.open()) {
        return;
      }
      const key = event.key;
      if (key >= '0' && key <= '9' && key.length === 1) {
        this.press(key);
      } else if (key === 'Backspace') {
        this.backspace();
      } else if (key === 'Escape') {
        this.cancel();
      } else {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('keydown', onKey, true);
      this.stopTicking();
    });
  }

  press(digit: string): void {
    if (this.checking() || this.typed().length >= PIN_LENGTH || this.paused()) {
      return;
    }
    if (this.problem() === 'wrong') {
      this.problem.set(null);
    }
    this.typed.set(this.typed() + digit);
    if (this.typed().length === PIN_LENGTH) {
      void this.submit();
    }
  }

  backspace(): void {
    if (!this.checking()) {
      this.typed.set(this.typed().slice(0, -1));
    }
  }

  cancel(): void {
    this.request()?.finish(null);
  }

  readonly paused = computed(() => this.secondsLeft() > 0 && this.pausedUntil() > Date.now());

  /**
   * Back deletes the last digit when there is one, and otherwise cancels (TV-23).
   * The back service forgets a layer as it calls it, so one that stays open
   * after a delete registers itself again.
   */
  private listenForBack(): void {
    this.release?.();
    this.release = this.back.whileOpen(() => {
      this.release = null;
      if (this.typed()) {
        this.backspace();
        this.listenForBack();
      } else {
        this.cancel();
      }
    });
  }

  private async submit(): Promise<void> {
    const asking = this.request();
    const pin = this.typed();
    if (!asking) {
      return;
    }

    if (asking.mode === 'enter') {
      this.checking.set(true);
      const right = await (asking.check?.(pin) ?? Promise.resolve(false));
      this.checking.set(false);
      if (right) {
        this.failures = 0;
        asking.finish(pin);
      } else {
        this.failures++;
        this.problem.set('wrong');
        this.typed.set('');
        this.wobble.update(count => count + 1);
        if (this.failures >= TRIES_BEFORE_PAUSE) {
          this.failures = 0;
          this.pause();
        }
      }
      return;
    }

    const first = this.first();
    if (first === null) {
      this.first.set(pin);
      this.problem.set(null);
      this.typed.set('');
    } else if (first === pin) {
      asking.finish(pin);
    } else {
      this.first.set(null);
      this.typed.set('');
      this.problem.set('mismatch');
      this.wobble.update(count => count + 1);
    }
  }

  /** Five wrong in a row: thirty seconds before the pad takes more (TV-24). */
  private pause(): void {
    this.pausedUntil.set(Date.now() + PAUSE_MS);
    this.secondsLeft.set(PAUSE_MS / 1000);
    this.stopTicking();
    this.ticking = setInterval(() => {
      const left = Math.ceil((this.pausedUntil() - Date.now()) / 1000);
      this.secondsLeft.set(Math.max(0, left));
      if (left <= 0) {
        this.stopTicking();
      }
    }, 500);
  }

  private stopTicking(): void {
    if (this.ticking !== null) {
      clearInterval(this.ticking);
      this.ticking = null;
    }
  }

}
