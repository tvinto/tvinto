import { TestBed } from '@angular/core/testing';
import { NEVER, of } from 'rxjs';
import { Stream } from '@shared/types';
import { XtreamService } from '../services/xtream.service';
import { ToastService } from '../services/toast.service';
import { DashboardStore } from './dashboard.store';

/**
 * The device's own guide on screen without waiting for a backend.
 *
 * On the TV emulator, after onboarding with no server, every category said
 * "0 with guide" though the guide was stored and matched: the device's read
 * sat in a forkJoin with the backend's "now" strip, asked of an address the
 * app had only guessed, which hung (8 November).
 */

const STREAM = { stream_id: 1, name: 'Stadium One', epg_channel_id: 'demo8' } as unknown as Stream;
const GUIDE = { '1': [{ title: 'Pre-Match Show', start: 1, stop: 2 }] };

describe('DashboardStore and the guide', () => {
  const build = (overrides: Partial<Record<keyof XtreamService, unknown>> = {}) => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: XtreamService,
          useValue: {
            getStreams: () => of([STREAM]),
            guideForStreams: () => of(GUIDE),
            // A backend that never answers.
            getNowEPGForStreams: () => NEVER,
            refreshEPGForStreams: () => NEVER,
            ...overrides
          }
        },
        { provide: ToastService, useValue: { error: jest.fn() } }
      ]
    });
    return TestBed.inject(DashboardStore);
  };

  it('shows the device’s guide when a category opens, whatever the backend does', () => {
    const store = build();
    store.loadStreams({ type: 'live', categoryId: '2' });

    expect(store.streams()).toEqual([STREAM]);
    expect(store.shortEpgByStreamId()).toEqual(GUIDE);
  });

  it('shows it at once on Refresh guide, before the backend has refreshed', () => {
    const store = build();
    store.loadStreams({ type: 'live', categoryId: '2' });
    const fresher = { '1': [{ title: 'The Final Whistle', start: 3, stop: 4 }] };
    TestBed.inject(XtreamService).guideForStreams = () => of(fresher);

    store.refreshNowEPGForVisible();

    expect(store.shortEpgByStreamId()).toEqual(fresher);
  });

  it('shows the list, with no guide, when the guide cannot be read', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = build({ guideForStreams: () => { throw new Error('no store'); } });
    store.loadStreams({ type: 'live', categoryId: '2' });

    expect(store.streams()).toEqual([STREAM]);
    expect(store.shortEpgByStreamId()).toEqual({});
    expect(store.error()).toBe('');
  });
});
