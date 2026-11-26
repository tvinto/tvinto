import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { StreamType } from '@shared/types';
import { afterFirstLibraries } from '../utils/library-refresh.utils';
import { FirstLoadService, RETRY_MS, TRIES } from './first-load.service';
import { GuideService } from './guide.service';
import { GuideSourcesService } from './guide-sources.service';
import { ProviderAccessService } from './provider-access.service';
import { XtreamService } from './xtream.service';

/** A first load during the walk-through (card 42): what it brings in, in what order, and what it leaves pending. */
describe('FirstLoadService', () => {
  let held: Set<StreamType>;
  let arrives: (type: StreamType) => boolean;
  let fetched: StreamType[];

  const setup = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: XtreamService,
          useValue: {
            indexing: signal(null),
            indexProgress: signal(null),
            libraryTitles: signal({}),
            libraryHeld: async (type: StreamType) => held.has(type),
            fetchLibraryIfNeverHeld: async (type: StreamType) => {
              fetched.push(type);
              const ok = arrives(type);
              if (ok) {
                held.add(type);
              }
              return ok;
            }
          }
        },
        { provide: GuideService, useValue: { loading: signal(null), queued: signal([]) } },
        { provide: GuideSourcesService, useValue: { sources: signal([]) } },
        { provide: ProviderAccessService, useValue: { supported: true } }
      ]
    });
    return TestBed.inject(FirstLoadService);
  };

  beforeEach(() => {
    localStorage.clear();
    held = new Set();
    arrives = () => true;
    fetched = [];
  });

  it('brings in channels, films and shows in turn, and the guide only after them', async () => {
    const load = setup();
    let guideWent = false;
    const started = load.start();
    void afterFirstLibraries().then(() => (guideWent = fetched.length === 3));
    expect(load.pending()).toBe(true);

    await started;
    await Promise.resolve();

    expect(fetched).toEqual(['live', 'vod', 'series']);
    expect(guideWent).toBe(true);
    expect(load.librariesIn()).toBe(true);
    expect(load.pending()).toBe(false);
  });

  it('passes a library already held at once, asking the provider nothing for it', async () => {
    held = new Set<StreamType>(['live', 'vod']);
    const load = setup();

    await load.start();

    expect(fetched).toEqual(['series']);
    expect(load.librariesIn()).toBe(true);
  });

  it('tries a library that did not arrive again, then gives up for the launch and stays pending for the next', async () => {
    jest.useFakeTimers();
    try {
      arrives = type => type !== 'vod';
      const load = setup();
      const started = load.start();
      for (let i = 0; i < TRIES; i++) {
        await jest.advanceTimersByTimeAsync(RETRY_MS);
      }
      await started;

      expect(fetched.filter(type => type === 'vod').length).toBe(TRIES);
      expect(fetched).toContain('series');
      expect(load.failed()).toBe(true);
      expect(load.librariesIn()).toBe(true);
      expect(load.pending()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
