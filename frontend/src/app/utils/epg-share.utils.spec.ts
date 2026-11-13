import { countryName, deviceCountry, epgShareName } from './epg-share.utils';
import { setCurrentLanguage } from './i18n';

describe('EPG Share in the app', () => {
  afterEach(() => setCurrentLanguage('en'));

  it('names the country in the language in use', () => {
    setCurrentLanguage('fr');
    expect(countryName('HR')).toBe('Croatie');
    expect(epgShareName('DE')).toBe('EPG Share · Allemagne');
  });

  it("takes the device's region before the language's", () => {
    const languages = jest.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-AT', 'de']);
    setCurrentLanguage('hr');
    expect(deviceCountry()).toBe('AT');
    languages.mockRestore();
  });

  it("takes the desktop's own region before its languages: an English Windows in Croatia", () => {
    const languages = jest.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US', 'hr-HR']);
    (globalThis as { xtreamDesktop?: unknown }).xtreamDesktop = { region: 'HR' };
    try {
      expect(deviceCountry()).toBe('HR');
    } finally {
      delete (globalThis as { xtreamDesktop?: unknown }).xtreamDesktop;
      languages.mockRestore();
    }
  });
});
