import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SETTING_KEYS } from '@shared/types';
import { CopyChoicesService } from './copy-choices.service';
import { SettingsService } from './settings.service';

/**
 * The copy chosen for a film or show, kept for the account: another device
 * sees it, and what this device chose before is carried over once the
 * account's settings are in -- under the account's, never over them.
 */
describe('CopyChoicesService', () => {
  const setup = (stored: Record<string, string> = {}, loaded = false) => {
    const values = signal<Record<string, string>>(stored);
    const isLoaded = signal(loaded);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsService,
          useValue: {
            loaded: isLoaded,
            get: (key: string) => values()[key] ?? '',
            set: (key: string, value: string) => values.update(all => ({ ...all, [key]: value }))
          }
        }
      ]
    });
    return { choices: TestBed.inject(CopyChoicesService), values, isLoaded };
  };

  beforeEach(() => localStorage.clear());

  it("keeps a choice in the account's settings", () => {
    const { choices, values } = setup();
    choices.choose('films', '603', 12);
    choices.choose('shows', 95396, '7');
    expect(choices.chosen('films', 603)).toBe('12');
    expect(choices.chosen('shows', '95396')).toBe('7');
    expect(values()[SETTING_KEYS.copyChoices]).toContain('"603"');
  });

  it("carries this device's old choices over once the account's are in, under them", () => {
    localStorage.setItem('xtream_copy_choice', JSON.stringify({ '603': 'device', '604': 'device' }));
    const { choices, values, isLoaded } = setup({ [SETTING_KEYS.copyChoices]: '{"films":[["603","account"]],"shows":[]}' });
    expect(choices.chosen('films', '604')).toBe('device');
    TestBed.tick();
    expect(localStorage.getItem('xtream_copy_choice')).not.toBeNull();

    isLoaded.set(true);
    TestBed.tick();
    expect(localStorage.getItem('xtream_copy_choice')).toBeNull();
    expect(choices.chosen('films', '603')).toBe('account');
    expect(choices.chosen('films', '604')).toBe('device');
    expect(values()[SETTING_KEYS.copyChoices]).toContain('"604"');
  });
});
