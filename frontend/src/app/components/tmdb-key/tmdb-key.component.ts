import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { TmdbError } from '@shared/tmdb/client';
import { TMDB_KEY_ADDRESS, TMDB_KEY_ADDRESS_SHORT, TMDB_KEY_EXAMPLES, normaliseTmdbKey, tmdbKeyKind } from '@shared/tmdb/key';
import { SettingRowComponent } from '../../ui/setting-row.component';
import { PhoneFormOfferComponent } from '../phone-form-offer/phone-form-offer.component';
import { TmdbService } from '../../services/tmdb.service';
import { ToastService } from '../../services/toast.service';
import { TvNavigationService } from '../../services/tv-navigation.service';
import { qrSvg } from '../../services/phone-form.service';
import { TPipe } from '../../pipes/t.pipe';
import { t } from '../../utils/i18n';

/** TMDB's own logo, from TMDB, as its attribution page offers it. */
export const TMDB_LOGO =
  'https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg';

/**
 * The person's own TMDB key (TmdbService): the account's when signed in, the device's without one: where to get one, what it
 * looks like, the field, and TMDB's notice. The same on Settings, under
 * Descriptions, and in the first launch's TMDB step.
 *
 * Saved only once TMDB takes it. On a television the key is typed on a phone
 * (PhoneFormOfferComponent), whose page links to TMDB's API page; elsewhere
 * the address is a link, with a QR code beside it on a computer for getting
 * the key on a phone.
 */
@Component({
  selector: 'app-tmdb-key',
  standalone: true,
  imports: [TPipe, HlmButton, HlmInput, HlmLabel, SettingRowComponent, PhoneFormOfferComponent],
  host: { class: 'contents' },
  template: `
    @if (keys.ownKey()) {
      <app-setting-row [label]="'describe.ownKey' | t" [sub]="(keys.onAccount() ? 'describe.ownKeyOnAccount' : 'describe.ownKeyInUse') | t" kind="static" data-tmdb-own-key>
        <button rowEnd hlmBtn variant="quiet" size="sm" type="button" (click)="removeKey()">{{ 'describe.ownKeyRemove' | t }}</button>
      </app-setting-row>
    } @else {
      <div class="setting-block flex flex-col gap-4" data-tmdb-own-key>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <span hlmLabel>{{ 'describe.ownKey' | t }}</span>
            <p class="text-sm text-muted-foreground">{{ 'tmdbKey.how' | t }}</p>
            @if (tv.isTelevision()) {
              <p class="font-mono text-sm font-semibold" data-tmdb-address>{{ addressShort }}</p>
            } @else {
              <a class="self-start font-mono text-sm font-semibold underline underline-offset-4" [href]="address" target="_blank" rel="noopener noreferrer" data-tmdb-address>
                {{ addressShort }}
              </a>
            }
          </div>
          <!-- For a computer: the page opened on a phone, where TMDB's site is easier. -->
          @if (!tv.isTelevision()) {
            <img class="hidden size-24 shrink-0 rounded-lg bg-white p-1.5 sm:block" [src]="addressQr" [alt]="'tmdbKey.qrAlt' | t" data-tmdb-qr />
          }
        </div>

        <!-- Which of the two values TMDB shows, with made-up ones of the right shape. -->
        <div class="flex flex-col gap-2" data-tmdb-examples>
          <p class="text-sm text-muted-foreground">{{ 'tmdbKey.looksLike' | t }}</p>
          <dl class="flex flex-col gap-2 rounded-md bg-card-2 px-3 py-2.5 text-xs">
            <div class="flex min-w-0 flex-col gap-0.5">
              <dt class="font-semibold">{{ 'tmdbKey.apiKey' | t }} <span class="font-normal text-muted-foreground">· {{ 'tmdbKey.apiKeyShape' | t }}</span></dt>
              <dd class="truncate font-mono text-muted-foreground">{{ examples.apiKey }}</dd>
            </div>
            <div class="flex min-w-0 flex-col gap-0.5">
              <dt class="font-semibold">{{ 'tmdbKey.token' | t }} <span class="font-normal text-muted-foreground">· {{ 'tmdbKey.tokenShape' | t }}</span></dt>
              <dd class="truncate font-mono text-muted-foreground">{{ examples.token }}</dd>
            </div>
          </dl>
        </div>

        <label class="flex flex-col gap-2">
          <span class="sr-only">{{ 'describe.ownKey' | t }}</span>
          <span class="flex flex-wrap items-center gap-3">
            <input
              hlmInput
              class="min-w-0 flex-1 font-mono"
              type="password"
              autocomplete="off"
              spellcheck="false"
              [placeholder]="'describe.ownKeyPlaceholder' | t"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.enter)="saveKey()"
              data-tmdb-key-input
            />
            <button hlmBtn variant="primary" type="button" [disabled]="!draft().trim() || checking()" (click)="saveKey()" data-tmdb-key-save>
              {{ (checking() ? 'describe.ownKeyChecking' : 'describe.ownKeySave') | t }}
            </button>
          </span>
        </label>
        @if (notAKey()) {
          <p class="text-sm text-muted-foreground" role="status" data-tmdb-not-a-key>{{ 'tmdbKey.notAKey' | t }}</p>
        }
        <!-- On a television: the key typed on a phone, which opens TMDB's page from there. -->
        <app-phone-form-offer kind="tmdb" [compact]="compact()" (arrived)="fromPhone($event)" />
      </div>
    }

    <!-- TMDB's terms ask for their logo and this line wherever their data is used. -->
    <div class="setting-block flex items-center gap-3" data-tmdb-attribution>
      <img [src]="logo" alt="TMDB" class="h-4 w-auto shrink-0" />
      <p class="text-xs text-muted-foreground">{{ 'describe.attribution' | t }}</p>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TmdbKeyComponent {
  readonly keys = inject(TmdbService);
  readonly tv = inject(TvNavigationService);
  private readonly toasts = inject(ToastService);

  readonly logo = TMDB_LOGO;
  readonly address = TMDB_KEY_ADDRESS;
  readonly addressShort = TMDB_KEY_ADDRESS_SHORT;
  readonly addressQr = qrSvg(TMDB_KEY_ADDRESS);
  readonly examples = TMDB_KEY_EXAMPLES;

  /** A smaller phone offer: Settings has the room, the first launch's card less so. */
  readonly compact = input(false);

  /** The key being typed, not yet saved. */
  readonly draft = signal('');
  readonly checking = signal(false);

  /** Something typed that is neither of TMDB's two values: said, but still sent, as TMDB has the last word. */
  readonly notAKey = computed(() => {
    const typed = normaliseTmdbKey(this.draft());
    return typed.length >= 8 && tmdbKeyKind(typed) === null;
  });

  /** What came from a phone: into the field, saved with Save on the TV like anything typed. */
  fromPhone(fields: Record<string, string>): void {
    this.draft.set(fields['key'] ?? '');
  }

  /** Kept only once TMDB takes it; a refusal is said in a dialog, with TMDB's answer. */
  async saveKey(): Promise<void> {
    if (!this.draft().trim() || this.checking()) {
      return;
    }
    this.checking.set(true);
    try {
      await this.keys.setOwnKey(this.draft());
      this.draft.set('');
    } catch (error) {
      const refused = error instanceof TmdbError && (error.status === 401 || error.status === 403);
      this.toasts.error(
        t(refused ? 'describe.ownKeyRefused' : 'describe.ownKeyUnreachable'),
        refused ? t('describe.ownKeyRefusedBody') : undefined,
        { detail: error instanceof Error ? error.message : String(error) }
      );
    } finally {
      this.checking.set(false);
    }
  }

  /** Signed in, from the account: every device of it stops using it. */
  async removeKey(): Promise<void> {
    try {
      await this.keys.clearOwnKey();
    } catch (error) {
      this.toasts.error(t('os.serviceUnreachable'), undefined, { detail: error instanceof Error ? error.message : String(error) });
    }
  }
}
