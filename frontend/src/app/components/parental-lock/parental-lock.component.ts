import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { ChoiceChipsComponent } from '../../ui/choice-chips.component';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { SETTING_KEYS } from '@shared/types';
import { TPipe } from '../../pipes/t.pipe';
import { ParentalLockService } from '../../services/parental-lock.service';
import { AgeLockService } from '../../services/age-lock.service';
import { AGE_COUNTRIES, AGE_LIMITS, ratingCountries } from '@shared/tmdb/age';
import { locale, t } from '../../utils/i18n';
import { SettingsService } from '../../services/settings.service';
import { IDLE_CHOICES, countOf, noCategories, writeCategorySets } from '../../utils/category-lock.utils';

/**
 * The PIN and the lock, on the account page.
 *
 * Which categories are locked is chosen where the categories are, with Hide
 * and lock on the category list; this is for the PIN itself, how soon it
 * locks again, and a way back for categories that were hidden and forgotten.
 *
 * Buttons rather than a select for the idle time: on a television the arrows
 * change a select's value as focus passes through it (21 September).
 */
@Component({
  selector: 'app-parental-lock',
  standalone: true,
  imports: [HlmButton, TPipe, ChoiceChipsComponent, SettingGroupComponent, SettingRowComponent],
  host: { class: 'contents' },
  template: `
    <!-- Round 14 (DS-TV-2): the lock as groups of rows. Choices are chips,
         not selects: on a television an arrow would change one. -->
    <app-setting-group data-parental-lock>
      @if (lock.hasPin()) {
        <!-- The answer to "is it on?" before anything else (D-17). -->
        <app-setting-row
          [label]="(lock.engaged() ? 'lock.account.stateLocked' : 'lock.account.stateOpen') | t: { count: lockedCount() }"
          [sub]="'lock.account.locked' | t: { count: lockedCount() }"
          kind="static"
          data-lock-state
        >
          @if (lock.engaged()) {
            <button rowEnd hlmBtn variant="primary" size="sm" type="button" (click)="lock.unlock()">{{ 'lock.unlock' | t }}</button>
          } @else {
            <button rowEnd hlmBtn variant="primary" size="sm" type="button" (click)="lock.lockNow()">{{ 'lock.lockNow' | t }}</button>
          }
        </app-setting-row>
        <app-setting-row [label]="'lock.account.lockAfter' | t" kind="static">
          <app-choice-chips
            rowEnd
            [label]="'lock.account.lockAfter' | t"
            [choices]="idleChoiceList()"
            [value]="lock.idleMinutes()"
            (valueChange)="$event !== null && lock.setIdleMinutes($event)"
            focusKey="lock-after"
          />
        </app-setting-row>
        <app-setting-row [label]="'lock.account.changePin' | t" focusKey="lock-change-pin" (activate)="lock.choosePin()" />
        <app-setting-row [label]="'lock.account.removePin' | t" focusKey="lock-remove-pin" (activate)="lock.removePin()" />
      } @else {
        <app-setting-row [label]="'lock.account.choosePin' | t" focusKey="lock-choose-pin" (activate)="lock.choosePin()" />
      }

      @if (hiddenCount() > 0) {
        <app-setting-row [label]="'lock.account.hidden' | t: { count: hiddenCount() }" kind="static">
          <button rowEnd hlmBtn variant="quiet" size="sm" type="button" (click)="showHidden()">{{ 'lock.account.showHidden' | t }}</button>
        </app-setting-row>
      }
    </app-setting-group>

    <!-- By age rating (TV-31, D-21, P-19): only where TMDB can rate titles. -->
    @if (ages.available()) {
      <app-setting-group [heading]="'lock.age.title' | t" data-age-lock>
        <app-setting-row [label]="'lock.age.lockTitles' | t" kind="static">
          <app-choice-chips rowEnd [label]="'lock.age.lockTitles' | t" [choices]="limitChoices()" [value]="limit()" (valueChange)="$event !== null && limit.set($event)" focusKey="age-limit" />
        </app-setting-row>
        @if (limit() > 0) {
          <app-setting-row [label]="'lock.age.country' | t" [sub]="'lock.age.order' | t: { countries: order() }" kind="static" data-age-order>
            <app-choice-chips rowEnd [label]="'lock.age.country' | t" [choices]="countryChoices()" [value]="country()" (valueChange)="$event && country.set($event)" focusKey="age-country" />
          </app-setting-row>
          <p class="setting-block text-sm text-muted-foreground" data-age-unrated>{{ 'lock.age.unrated' | t }}</p>
        }
        @if (changed()) {
          <div class="setting-block flex flex-wrap items-center gap-3" data-age-save>
            <button hlmBtn variant="primary" size="sm" type="button" (click)="save()">{{ 'cat.save' | t }}</button>
            <button hlmBtn variant="quiet" size="sm" type="button" (click)="cancel()">{{ 'cat.cancel' | t }}</button>
            <span class="text-sm text-muted-foreground">{{ 'lock.age.unsaved' | t }}</span>
          </div>
        }
      </app-setting-group>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ParentalLockComponent {
  readonly lock = inject(ParentalLockService);
  private readonly settings = inject(SettingsService);

  readonly ages = inject(AgeLockService);

  readonly idleChoices = IDLE_CHOICES;
  readonly limits = AGE_LIMITS;
  readonly countries = AGE_COUNTRIES;

  readonly idleChoiceList = computed(() =>
    this.idleChoices.map(minutes => ({ value: minutes, label: minutes === 0 ? t('lock.account.onRestart') : t('lock.account.minutes', { count: minutes }) }))
  );
  readonly limitChoices = computed(() => this.limits.map(age => ({ value: age, label: age === 0 ? t('lock.age.off') : t('lock.age.over', { age }) })));
  readonly countryChoices = computed(() => this.countries.map(code => ({ value: code, label: this.countryName(code) })));

  /** The choice on screen, which applies only on Save. Follows the saved one until changed. */
  readonly limit = linkedSignal(() => this.ages.lock().limit);
  readonly country = linkedSignal(() => this.ages.lock().country);
  readonly changed = computed(
    () => this.limit() !== this.ages.lock().limit || (this.limit() > 0 && this.country() !== this.ages.lock().country)
  );
  /** "Croatia → Germany → United States": whose rating is read, in order. */
  readonly order = computed(() => ratingCountries(this.country()).map(code => this.countryName(code)).join(' → '));

  countryName(code: string): string {
    try {
      return new Intl.DisplayNames([locale()], { type: 'region' }).of(code) ?? code;
    } catch {
      return code;
    }
  }

  async save(): Promise<void> {
    await this.ages.save({ limit: this.limit(), country: this.limit() > 0 ? this.country() : this.ages.lock().country });
  }

  cancel(): void {
    this.limit.set(this.ages.lock().limit);
    this.country.set(this.ages.lock().country);
  }
  readonly lockedCount = computed(() => countOf(this.lock.locked()));
  readonly hiddenCount = computed(() => countOf(this.lock.hidden()));

  /** Every hidden category back, for when one has been hidden and nobody remembers where. */
  showHidden(): void {
    this.settings.set(SETTING_KEYS.hiddenCategories, writeCategorySets(noCategories()));
  }
}
