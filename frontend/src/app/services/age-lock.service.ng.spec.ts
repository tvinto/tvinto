import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { SETTING_KEYS, Stream } from '@shared/types';
import { AgeLockService } from './age-lock.service';
import { DescriptionsService } from './descriptions.service';
import { ParentalLockService } from './parental-lock.service';
import { SettingsService } from './settings.service';
import { TmdbService } from './tmdb.service';

/**
 * The age-rating lock (TV-31): a rated title over the limit asks for the
 * PIN before it plays, an unrated one plays, nothing is asked while the
 * device is unlocked, and a change that opens anything up needs the PIN.
 */
describe('AgeLockService', () => {
  const setup = (options: { lock?: string; ratings?: Record<number, Record<string, string> | null>; pinGiven?: boolean; unlocked?: boolean } = {}) => {
    const values = signal<Record<string, string>>({ [SETTING_KEYS.ageLock]: options.lock ?? '{"limit":16,"country":"HR"}' });
    const asked = { pin: 0, tmdb: 0, chosen: 0 };
    const unlocked = signal(options.unlocked ?? false);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsService,
          useValue: { get: (key: string) => values()[key] ?? '', set: (key: string, value: string) => values.update(all => ({ ...all, [key]: value })) }
        },
        {
          provide: ParentalLockService,
          useValue: {
            hasPin: signal(true),
            engaged: computed(() => !unlocked()),
            unlock: async () => {
              asked.pin++;
              return options.pinGiven ?? false;
            },
            choosePin: async () => {
              asked.chosen++;
              return true;
            }
          }
        },
        {
          provide: TmdbService,
          useValue: {
            ownKey: signal(''),
            client: async () => ({
              certifications: async (_kind: string, id: number) => {
                asked.tmdb++;
                return options.ratings?.[id] ?? {};
              }
            })
          }
        },
        { provide: DescriptionsService, useValue: { filmTmdbId: async () => null, showTmdbId: async () => null, filmTmdbIdByName: async (name: string) => (name.includes('Matrix') ? 603 : null) } }
      ]
    });
    return { ages: TestBed.inject(AgeLockService), asked, values };
  };

  beforeEach(() => localStorage.clear());

  it('asks for the PIN before a film rated over the limit plays', async () => {
    const { ages, asked } = setup({ ratings: { 603: { DE: '16' } } });
    expect(await ages.mayPlay('movie', async () => 603, 'The Matrix')).toBe(false);
    expect(asked.pin).toBe(1);
  });

  it('lets an unrated or unknown title play without asking', async () => {
    const { ages, asked } = setup({ ratings: { 7: {} } });
    expect(await ages.mayPlay('movie', async () => 7, 'Unrated')).toBe(true);
    expect(await ages.mayPlay('movie', async () => null, 'Unknown')).toBe(true);
    expect(asked.pin).toBe(0);
  });

  it('asks nothing while the device is unlocked, or with the lock off', async () => {
    expect(await setup({ unlocked: true, ratings: { 603: { DE: '18' } } }).ages.mayPlay('movie', async () => 603, 'x')).toBe(true);
    const off = setup({ lock: '', ratings: { 603: { DE: '18' } } });
    expect(await off.ages.mayPlay('movie', async () => 603, 'x')).toBe(true);
    expect(off.asked.tmdb).toBe(0);
  });

  it('keeps a rating, and shows a known locked poster', async () => {
    const { ages, asked } = setup({ ratings: { 603: { US: 'R' } } });
    await ages.learn('movie', [603]);
    await ages.learn('movie', [603]);
    expect(asked.tmdb).toBe(1);
    expect(ages.lockedLabel('movie', 603)).toBe('R');
    expect(ages.lockedLabel('movie', 604)).toBe('');
  });

  it('covers a library poster whose title TMDB rates over the limit, found by its name alone', async () => {
    const { ages } = setup({ ratings: { 603: { DE: '16' } } });
    const stream = (id: number, name: string) => ({ stream_id: String(id), name }) as unknown as Stream;
    await ages.learnStreams('vod', [stream(1, 'EN - The Matrix (1999)'), stream(2, 'EN - Unknown (2020)')]);
    expect(ages.lockedStreamLabel('vod', 1)).toBe('16');
    expect(ages.lockedStreamLabel('vod', 2)).toBe('');
    expect(ages.lockedStreamLabel('live', 1)).toBe('');
  });

  it('needs the PIN to open anything up, not to tighten', async () => {
    const { ages, asked, values } = setup({ pinGiven: false });
    expect(await ages.save({ limit: 12, country: 'HR' })).toBe(true);
    expect(asked.pin).toBe(0);
    expect(await ages.save({ limit: 0, country: 'HR' })).toBe(false);
    expect(asked.pin).toBe(1);
    expect(JSON.parse(values()[SETTING_KEYS.ageLock])).toEqual({ limit: 12, country: 'HR' });
  });
});
