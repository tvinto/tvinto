import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { DatabaseSpaceService } from '../../services/database-space.service';
import { TPipe } from '../../pipes/t.pipe';
import { size } from '../../utils/storage.utils';

/**
 * On For You when the device database holds a lot it no longer needs
 * (BANNER_FREE_BYTES) -- which means the cleans in standby are not keeping
 * up. Leads to Account, where "Free up space" is; "Not now" puts it off for a
 * week.
 */
@Component({
  selector: 'app-storage-banner',
  standalone: true,
  imports: [TPipe, HlmButton],
  template: `
    @if (storage.bannerDue() && storage.space(); as space) {
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card px-5 py-4" data-storage-banner role="status">
        <p class="min-w-0 text-sm font-medium">{{ 'storage.banner' | t: { size: sized(space.freeBytes) } }}</p>
        <div class="flex gap-2">
          <button hlmBtn variant="primary" type="button" size="sm" data-storage-banner-open (click)="open()">{{ 'storage.clean' | t }}</button>
          <button hlmBtn type="button" size="sm" variant="quiet" data-storage-banner-later (click)="storage.snoozeBanner()">{{ 'storage.notNow' | t }}</button>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StorageBannerComponent {
  readonly storage = inject(DatabaseSpaceService);
  private readonly router = inject(Router);

  constructor() {
    void this.storage.refresh();
  }

  sized(bytes: number): string {
    return size(bytes);
  }

  open(): void {
    void this.router.navigate(['/account'], { queryParams: { section: 'account' }, fragment: 'storage' });
  }
}
