import { readLanguages, writeLanguages } from './languages';

describe('Your languages', () => {
  it("is the app's language, then English, until chosen", () => {
    expect(readLanguages('', 'hr')).toEqual(['hr', 'en']);
    expect(readLanguages(null, 'en')).toEqual(['en']);
  });

  it('keeps a chosen order, at most three, known codes once', () => {
    expect(readLanguages('["de","hr","de","xx","en","fr"]', 'hr')).toEqual(['de', 'hr', 'en']);
    expect(readLanguages('not json', 'hr')).toEqual(['hr', 'en']);
    expect(readLanguages('[]', 'hr')).toEqual(['hr', 'en']);
  });

  it('stores the order, or nothing for the default', () => {
    expect(readLanguages(writeLanguages(['en', 'hr']), 'hr')).toEqual(['en', 'hr']);
    expect(writeLanguages([])).toBe('');
  });
});
