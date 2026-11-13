import {
  EPG_SHARE_COUNTRIES,
  epgShareCountries,
  epgShareCountryOfLabel,
  epgShareCountryOfUrl,
  epgShareFor,
  regionOf,
  suggestedCountry
} from './epgShare';
import { isGuideAddress } from './guideSources';

describe('epgShareFor', () => {
  it('gives Croatia the file and label onboarding always gave it', () => {
    expect(epgShareFor('HR')).toEqual({
      country: 'HR',
      name: 'Croatia',
      file: 'HR1',
      url: 'https://epgshare01.online/epgshare01/epg_ripper_HR1.xml.gz',
      label: 'EPG Share · Croatia',
      files: ['HR1']
    });
  });

  it('takes the code in either case', () => {
    expect(epgShareFor('de')?.url).toBe('https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz');
  });

  it('finds the United Kingdom under GB, its ISO code, and under UK, EPG Share’s', () => {
    expect(epgShareFor('GB')?.file).toBe('UK1');
    expect(epgShareFor('UK')?.country).toBe('GB');
  });

  it('suggests the main file of a country that has several', () => {
    expect(epgShareFor('US')?.file).toBe('US2');
    expect(epgShareFor('IN')?.file).toBe('IN1');
    expect(epgShareFor('PH')?.file).toBe('PH2');
    expect(epgShareFor('TR')?.files).toEqual(['TR3', 'TR1']);
  });

  it('has nothing for a country EPG Share does not cover', () => {
    expect(epgShareFor('SI')).toBeNull();
    expect(epgShareFor('MK')).toBeNull();
    expect(epgShareFor('RU')).toBeNull();
  });

  it('has nothing for no country, or for something that is not a code', () => {
    expect(epgShareFor(null)).toBeNull();
    expect(epgShareFor('')).toBeNull();
    expect(epgShareFor('HRV')).toBeNull();
  });

  it('gives an address the Guides page accepts, for every country', () => {
    for (const code of epgShareCountries()) {
      expect(isGuideAddress(epgShareFor(code)!.url)).toBe(true);
    }
  });

  it('names no file twice', () => {
    const files = Object.values(EPG_SHARE_COUNTRIES).flatMap(entry => entry.files);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe('epgShareCountryOfLabel', () => {
  it('reads the country back from a stored label, the old Croatian one included', () => {
    expect(epgShareCountryOfLabel('EPG Share · Croatia')).toBe('HR');
    expect(epgShareCountryOfLabel('EPG Share · United Kingdom')).toBe('GB');
  });

  it('is null for a label somebody typed', () => {
    expect(epgShareCountryOfLabel('EPG Share')).toBeNull();
    expect(epgShareCountryOfLabel('EPG Share · Atlantis')).toBeNull();
    expect(epgShareCountryOfLabel('My guide')).toBeNull();
  });

  it('round-trips every country', () => {
    for (const code of epgShareCountries()) {
      expect(epgShareCountryOfLabel(epgShareFor(code)!.label)).toBe(code);
    }
  });
});

describe('epgShareCountryOfUrl', () => {
  it('finds the country of any of its files', () => {
    expect(epgShareCountryOfUrl('https://epgshare01.online/epgshare01/epg_ripper_HR1.xml.gz')).toBe('HR');
    expect(epgShareCountryOfUrl(' https://epgshare01.online/epgshare01/epg_ripper_US_LOCALS1.xml.gz ')).toBe('US');
  });

  it('is null for another address, or a file that is not a country’s', () => {
    expect(epgShareCountryOfUrl('https://epgshare01.online/epgshare01/epg_ripper_PLEX1.xml.gz')).toBeNull();
    expect(epgShareCountryOfUrl('https://example.com/epg_ripper_HR1.xml.gz')).toBeNull();
  });
});

describe('regionOf', () => {
  it.each([
    ['hr-HR', 'HR'],
    ['en-us', 'US'],
    ['sr-Latn-RS', 'RS'],
    ['en_GB.UTF-8', 'GB'],
    ['de_AT@euro', 'AT'],
    ['en-UK', 'GB']
  ])('%s → %s', (locale, region) => {
    expect(regionOf(locale)).toBe(region);
  });

  it.each(['hr', 'en-001', 'zh-Hant', 'C', ''])('%s names no region', locale => {
    expect(regionOf(locale)).toBeNull();
  });
});

describe('suggestedCountry', () => {
  it('takes the device’s region first', () => {
    expect(suggestedCountry(['de-AT', 'de'], 'hr-HR')).toBe('AT');
  });

  it('skips locales without a region', () => {
    expect(suggestedCountry(['hr', 'en-GB'], 'de-DE')).toBe('GB');
  });

  it('falls back to the language in use', () => {
    expect(suggestedCountry(['hr'], 'hr-HR')).toBe('HR');
    expect(suggestedCountry([], 'pt-BR')).toBe('BR');
  });

  it('keeps a region EPG Share does not cover, so nothing is suggested rather than the language’s', () => {
    expect(suggestedCountry(['sl-SI'], 'hr-HR')).toBe('SI');
    expect(epgShareFor(suggestedCountry(['sl-SI'], 'hr-HR'))).toBeNull();
  });

  it('is null with nothing to go on', () => {
    expect(suggestedCountry([], null)).toBeNull();
  });
});
