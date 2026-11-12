import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, output, signal, untracked } from '@angular/core';
import { PhoneFormService, PhoneOffer } from '../../services/phone-form.service';
import { PhoneFormKind } from '../../utils/phone-form.utils';
import { TPipe } from '../../pipes/t.pipe';
import { HlmButton } from '@spartan-ng/helm/button';

/**
 * "Type it on your phone instead": a QR code beside a form on a television
 * (phone-form.service.ts). Nothing on a phone or a computer, which have
 * keyboards, and nothing when the TV is not on a network.
 */
@Component({
  selector: 'app-phone-form-offer',
  standalone: true,
  imports: [TPipe, HlmButton],
  host: { class: 'contents' },
  template: `
    @if (offer(); as shown) {
      <div class="flex items-center gap-5 rounded-xl bg-[var(--glass-quiet)] p-4" data-phone-offer>
        <img class="shrink-0 rounded-lg bg-white p-1.5" [class.size-36]="!compact()" [class.size-24]="compact()" [src]="shown.qr" [alt]="'phoneForm.qrAlt' | t" />
        <div class="flex min-w-0 flex-col gap-1.5">
          <p class="text-base font-semibold text-foreground">{{ 'phoneForm.offer' | t }}</p>
          @if (!compact()) {
            <p class="text-sm text-muted-foreground">{{ 'phoneForm.offerHow' | t }}</p>
          }
          <p class="truncate font-mono text-xs text-muted-foreground">{{ shown.address }}</p>
        </div>
      </div>
    } @else if (received()) {
      <!-- What came from the phone is in the form. A typo there is fixed by sending again. -->
      <div class="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--glass-quiet)] px-4 py-3" data-phone-received>
        <p class="text-sm text-muted-foreground">{{ 'phoneForm.received' | t }}</p>
        <button hlmBtn variant="quiet" size="sm" type="button" (click)="again()">{{ 'phoneForm.again' | t }}</button>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PhoneFormOfferComponent {
  private readonly phone = inject(PhoneFormService);

  readonly kind = input.required<PhoneFormKind>();
  /** A smaller code and one line, where the screen has little room (the sign-in page on a TV). */
  readonly compact = input(false);
  /** The fields a phone sent, opened; the screen fills its own form with them. */
  readonly arrived = output<Record<string, string>>();

  readonly offer = signal<PhoneOffer | null>(null);
  /** A form has come from the phone and been handed on. */
  readonly received = signal(false);
  /** Bumped to put a fresh code up after one was used. */
  private readonly round = signal(0);
  private lastKind: PhoneFormKind | null = null;

  again(): void {
    this.received.set(false);
    this.round.update(n => n + 1);
  }

  constructor() {
    // One offer at a time, for the form being shown: a new kind closes the old page.
    effect(onCleanup => {
      const kind = this.kind();
      this.round();
      // Another kind of form is another page: what came for the last one does not stand in for it.
      if (kind !== this.lastKind) {
        this.lastKind = kind;
        untracked(() => this.received.set(false));
      }
      if (untracked(() => this.received())) {
        return;
      }
      let current: PhoneOffer | null = null;
      let gone = false;
      untracked(() => {
        void this.phone
          .offer(kind, fields => {
            this.offer.set(null);
            this.received.set(true);
            this.arrived.emit(fields);
          })
          .then(made => {
            if (gone) {
              made?.close();
              return;
            }
            current = made;
            this.offer.set(made);
          });
      });
      onCleanup(() => {
        gone = true;
        current?.close();
        this.offer.set(null);
      });
    });
    inject(DestroyRef).onDestroy(() => this.offer()?.close());
  }
}
