import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StreamType } from '@shared/types';
import { ActivityComponent } from './activity.component';
import { XtreamService } from '../../services/xtream.service';
import { GuideLoadProgress, GuideService } from '../../services/guide.service';
import { GuideSourcesService } from '../../services/guide-sources.service';
import { DeviceSyncService } from '../../services/device-sync.service';

/**
 * The activity notice (12 November): one entry per thing loading, progress
 * where it is known, gone when nothing is.
 */
describe('ActivityComponent', () => {
  const firstSync = signal(false);
  const indexing = signal<StreamType | null>(null);
  const indexProgress = signal<{ filed: number; total: number | null } | null>(null);
  const loading = signal<GuideLoadProgress | null>(null);
  const queued = signal<readonly string[]>([]);

  const build = () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: DeviceSyncService, useValue: { firstSync } },
        { provide: XtreamService, useValue: { indexing, indexProgress } },
        { provide: GuideService, useValue: { loading, queued } },
        { provide: GuideSourcesService, useValue: { sources: () => [{ id: 'a', label: 'Sport' }, { id: 'b', label: 'Filmovi' }] } }
      ]
    });
    const fixture = TestBed.createComponent(ActivityComponent);
    fixture.detectChanges();
    return fixture;
  };
  const entries = (fixture: { nativeElement: HTMLElement }) =>
    [...fixture.nativeElement.querySelectorAll('[data-activity-entry]')].map(entry =>
      [...entry.querySelectorAll('p')].map(line => line.textContent?.trim()).join(' | ')
    );

  beforeEach(() => {
    firstSync.set(false);
    indexing.set(null);
    indexProgress.set(null);
    loading.set(null);
    queued.set([]);
  });

  it('is not there when nothing is loading', () => {
    expect(build().nativeElement.querySelector('[data-activity]')).toBeNull();
  });

  it('has an entry for each thing in progress, a waiting guide included', () => {
    firstSync.set(true);
    indexing.set('vod');
    loading.set({ sourceId: 'a', channels: 1200, programmes: 40000, chars: 12_500_000 });
    queued.set(['b']);
    const fixture = build();

    expect(entries(fixture)).toEqual([
      'Bringing in your history and favourites',
      'Film library | Downloading',
      `TV guide · Sport | ${(1200).toLocaleString()} channels · 13 MB read`,
      'TV guide · Filmovi | Waiting its turn'
    ]);
    // The waiting guide has no bar; the rest move without a length.
    expect(fixture.nativeElement.querySelectorAll('.activity-track')).toHaveLength(3);
  });

  it("measures a library's categories once their number is known", () => {
    indexing.set('series');
    indexProgress.set({ filed: 30, total: 120 });
    const fixture = build();

    expect(entries(fixture)).toEqual(['Show library | 30 of 120 categories']);
    const fill = fixture.nativeElement.querySelector('.activity-fill') as HTMLElement;
    expect(fill.style.width).toBe('25%');
    expect(fill.classList).not.toContain('activity-fill-moving');
  });

  it('lets each entry go as it finishes, and itself with the last', () => {
    firstSync.set(true);
    indexing.set('vod');
    const fixture = build();

    firstSync.set(false);
    fixture.detectChanges();
    expect(entries(fixture)).toEqual(['Film library | Downloading']);

    indexing.set(null);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-activity]')).toBeNull();
  });

  it('has nothing that takes focus', () => {
    firstSync.set(true);
    loading.set({ sourceId: 'a', channels: 0, programmes: 0, chars: 0 });
    const fixture = build();

    expect(fixture.nativeElement.querySelector('button, a, input, [tabindex]')).toBeNull();
  });
});
