import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StreamType } from '@shared/types';
import { ActivityComponent } from './activity.component';
import { XtreamService } from '../../services/xtream.service';
import { GuideLoadProgress, GuideService } from '../../services/guide.service';
import { GuideSourcesService } from '../../services/guide-sources.service';
import { DeviceSyncService } from '../../services/device-sync.service';
import { TvNavigationService } from '../../services/tv-navigation.service';

/**
 * The loading pill (14 November): one short line for what is loading, or how
 * many things are, and the whole list in a panel when it is clicked; gone when
 * nothing is. On a television only the pill, which nothing can focus.
 */
describe('ActivityComponent', () => {
  const firstSync = signal(false);
  const indexing = signal<StreamType | null>(null);
  const indexProgress = signal<{ filed: number; total: number | null } | null>(null);
  const loading = signal<GuideLoadProgress | null>(null);
  const queued = signal<readonly string[]>([]);
  const isTelevision = signal(false);

  const build = () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: DeviceSyncService, useValue: { firstSync } },
        { provide: XtreamService, useValue: { indexing, indexProgress } },
        { provide: GuideService, useValue: { loading, queued } },
        { provide: GuideSourcesService, useValue: { sources: () => [{ id: 'a', label: 'Sport' }, { id: 'b', label: 'Filmovi' }] } },
        { provide: TvNavigationService, useValue: { isTelevision } }
      ]
    });
    const fixture = TestBed.createComponent(ActivityComponent);
    fixture.detectChanges();
    return fixture;
  };
  const element = (fixture: ComponentFixture<ActivityComponent>) => fixture.nativeElement as HTMLElement;
  const pill = (fixture: ComponentFixture<ActivityComponent>) => element(fixture).querySelector<HTMLElement>('[data-activity-pill]');
  const pillText = (fixture: ComponentFixture<ActivityComponent>) =>
    pill(fixture)?.querySelector('.activity-pill-text')?.textContent?.trim();
  const openPanel = (fixture: ComponentFixture<ActivityComponent>) => {
    pill(fixture)!.click();
    fixture.detectChanges();
  };
  const entries = (fixture: ComponentFixture<ActivityComponent>) =>
    [...element(fixture).querySelectorAll('[data-activity-entry]')].map(entry =>
      [...entry.querySelectorAll('p')].map(line => line.textContent?.trim()).join(' | ')
    );

  beforeEach(() => {
    firstSync.set(false);
    indexing.set(null);
    indexProgress.set(null);
    loading.set(null);
    queued.set([]);
    isTelevision.set(false);
  });

  it('is not there when nothing is loading', () => {
    expect(element(build()).querySelector('[data-activity]')).toBeNull();
  });

  it('names the one thing loading, short', () => {
    loading.set({ sourceId: 'a', channels: 10197, programmes: 40000, chars: 17_000_000 });
    const fixture = build();

    expect(pillText(fixture)).toBe(`TV guide · ${(10197).toLocaleString()} channels`);
    expect(element(fixture).querySelector('[data-activity-panel]')).toBeNull();
  });

  it('counts several, and lists each in the panel, a waiting guide included', () => {
    firstSync.set(true);
    indexing.set('vod');
    loading.set({ sourceId: 'a', channels: 1200, programmes: 40000, chars: 12_500_000 });
    queued.set(['b']);
    const fixture = build();

    expect(pillText(fixture)).toBe('Loading 4 things');
    openPanel(fixture);
    expect(entries(fixture)).toEqual([
      'Bringing in your history and favourites',
      'Film library | Downloading',
      `TV guide · Sport | ${(1200).toLocaleString()} channels · 13 MB read`,
      'TV guide · Filmovi | Waiting its turn'
    ]);
    // The waiting guide has no bar; the rest move without a length.
    expect(element(fixture).querySelectorAll('.activity-track')).toHaveLength(3);
    expect(element(fixture).querySelector('.activity-ring-moving')).not.toBeNull();
  });

  it("fills the ring and the bar with a library's categories once their number is known", () => {
    indexing.set('series');
    indexProgress.set({ filed: 30, total: 120 });
    const fixture = build();

    expect(pillText(fixture)).toBe('Show library');
    expect(element(fixture).querySelector('.activity-ring-moving')).toBeNull();
    expect(element(fixture).querySelector('.activity-ring-fill')?.getAttribute('stroke-dashoffset')).toBe('75');

    openPanel(fixture);
    expect(entries(fixture)).toEqual(['Show library | 30 of 120 categories']);
    const fill = element(fixture).querySelector('.activity-fill') as HTMLElement;
    expect(fill.style.width).toBe('25%');
    expect(fill.classList).not.toContain('activity-fill-moving');
  });

  it('closes the panel on a click outside it, and on Esc', () => {
    firstSync.set(true);
    const fixture = build();

    openPanel(fixture);
    expect(pill(fixture)!.getAttribute('aria-expanded')).toBe('true');
    document.body.click();
    fixture.detectChanges();
    expect(element(fixture).querySelector('[data-activity-panel]')).toBeNull();

    openPanel(fixture);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(element(fixture).querySelector('[data-activity-panel]')).toBeNull();
  });

  it('lets each entry go as it finishes, and itself with the last, panel and all', () => {
    firstSync.set(true);
    indexing.set('vod');
    const fixture = build();
    openPanel(fixture);

    firstSync.set(false);
    fixture.detectChanges();
    expect(entries(fixture)).toEqual(['Film library | Downloading']);

    indexing.set(null);
    fixture.detectChanges();
    expect(element(fixture).querySelector('[data-activity]')).toBeNull();

    // The next load brings the pill back, not the panel nobody opened.
    indexing.set('live');
    fixture.detectChanges();
    expect(pill(fixture)).not.toBeNull();
    expect(element(fixture).querySelector('[data-activity-panel]')).toBeNull();
  });

  it('on a television is only the pill, with nothing that takes focus', () => {
    isTelevision.set(true);
    firstSync.set(true);
    loading.set({ sourceId: 'a', channels: 0, programmes: 0, chars: 0 });
    const fixture = build();

    expect(pillText(fixture)).toBe('Loading 2 things');
    expect(element(fixture).querySelector('button, a, input, [tabindex]')).toBeNull();
  });
});
