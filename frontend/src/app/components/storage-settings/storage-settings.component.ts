import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { SettingRowComponent } from '../../ui/setting-row.component';
import { DatabaseSpaceService } from '../../services/database-space.service';
import { TPipe } from '../../pipes/t.pipe';
import { NOTHING_TO_FREE_BYTES, size } from '../../utils/storage.utils';
import { locale, t } from '../../utils/i18n';

/**
 * Account's Storage card on Android: how big the device's database is, how
 * much of it is wasted, and "Free up space" (DatabaseSpaceService). The busy
 * screen while it runs is StorageBusyComponent's.
 */
@Component({
  selector: 'app-storage-settings',
  standalone: true,
  imports: [TPipe, HlmButton, SettingRowComponent],
  host: { class: 'contents' },
  template: `
    @if (storage.supported && storage.space(); as space) {
      <app-setting-row
        [label]="'storage.heading' | t"
        [sub]="detail(space.bytes, space.freeBytes)"
        kind="static"
        data-storage-card
      >
        <button
          rowEnd
          hlmBtn
          type="button"
          size="sm"
          [attr.aria-disabled]="nothingToFree()"
          data-storage-clean
          (click)="nothingToFree() || storage.clean()"
        >
          {{ 'storage.clean' | t }}
        </button>
      </app-setting-row>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StorageSettingsComponent {
  readonly storage = inject(DatabaseSpaceService);
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;


  readonly nothingToFree = computed(() => (this.storage.space()?.freeBytes ?? 0) < NOTHING_TO_FREE_BYTES);

  /** The last clean that gave anything back, by itself in standby or asked for. */
  readonly lastFreed = computed(() => {
    const last = this.storage.space()?.last;
    if (!last || last.state !== 'done' || !last.finishedAt) {
      return null;
    }
    const date = new Date(last.finishedAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
    return { date, size: size(Math.max(0, (last.beforeBytes ?? 0) - (last.afterBytes ?? 0))) };
  });

  constructor() {
    // From the banner (#storage): straight to the button it named.
    const fromBanner = inject(ActivatedRoute).snapshot.fragment === 'storage';
    void this.storage.refresh().then(() => {
      if (fromBanner) {
        requestAnimationFrame(() => this.host.querySelector<HTMLElement>('[data-storage-clean]')?.focus({ preventScroll: false }));
      }
    });
    // Focus back on the button when the busy screen goes, not on the page's top.
    let wasCleaning = false;
    effect(() => {
      const cleaning = this.storage.cleaning() !== null;
      if (!cleaning) {
        if (wasCleaning) {
          requestAnimationFrame(() => this.host.querySelector<HTMLElement>('[data-storage-clean]')?.focus({ preventScroll: true }));
        }
      }
      wasCleaning = cleaning;
    });
  }

  /**
   * "412 MB · 38 MB can be freed", then what the last clean gave back: the
   * grey line under Storage. The facts the card used to lay out as a table.
   */
  detail(bytes: number, freeBytes: number): string {
    const parts = [size(bytes), t('storage.freeLine', { size: size(freeBytes) })];
    const result = this.storage.result();
    const last = this.lastFreed();
    if (result !== null) {
      parts.push(t('storage.freed', { size: size(result) }));
    } else if (last) {
      parts.push(t('storage.last', last));
    }
    return parts.join(' · ');
  }

}
