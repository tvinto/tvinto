import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { GuideReloadService } from './guide-reload.service';
import { GuideService } from './guide.service';
import { GuideSourcesService } from './guide-sources.service';
import { NativePlayerService } from './native-player.service';

/**
 * Which guide is reloaded first when several are due: the smallest, so a big
 * guide listed first does not hold up a small one for as long as it takes
 * (28 October).
 */
describe('GuideReloadService, with several guides due', () => {
  const loaded: string[] = [];
  const DAY = 24 * 60 * 60 * 1000;

  const setup = (sizes: Record<string, number | null>, playing = false) => {
    loaded.length = 0;
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: GuideService,
          useValue: {
            supported: true,
            isLoading: signal(false),
            // Loaded three days ago and running out in two hours: due.
            lastLoadedAt: async () => new Date(Date.now() - 3 * DAY).toISOString(),
            runsOutAt: async () => Date.now() + 2 * 60 * 60 * 1000,
            summaryFor: async (id: string) => (sizes[id] === null ? null : { loadedAt: '', channels: 1, programmes: sizes[id] }),
            load: async (id: string) => {
              loaded.push(id);
              return { channels: 1, programmes: 1 };
            }
          }
        },
        {
          provide: GuideSourcesService,
          useValue: { enabled: () => Object.keys(sizes).map(id => ({ id, url: `http://guide/${id}`, label: id })) }
        },
        { provide: NativePlayerService, useValue: { active: () => playing } }
      ]
    });
    return TestBed.inject(GuideReloadService);
  };

  it('reloads the smallest first, whatever order they are listed in', async () => {
    await setup({ big: 200_000, small: 600, middle: 20_000 }).check();

    expect(loaded).toEqual(['small', 'middle', 'big']);
  });

  it('leaves one whose size is not known until last, and keeps the listed order between equals', async () => {
    await setup({ unknown: null, a: 500, b: 500 }).check();

    expect(loaded).toEqual(['a', 'b', 'unknown']);
  });

  it('reloads small guides while something plays, and leaves the big ones for later', async () => {
    // A television that opens onto the last channel and is only ever watched
    // never reloaded at all when every guide stood aside (28 October).
    await setup({ provider: 200_000, share: 27_580, unknown: null }, true).check();

    expect(loaded).toEqual(['share']);
  });
});
