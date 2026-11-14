import { firstPerTitle, oneCardPerTitle } from '../../utils/one-per-title.utils';
import { setPreferredLanguages } from '../../utils/languages';

/** Recently added as a provider lists it: each title in several copies, together (14 November). */
const added = [
  'EN - The Odyssey HD (2026)',
  'EN - The Odyssey 4K (2026)',
  'DE - The Odyssey (2026)',
  'EN - Fall 2 (2026)',
  'EN - Fall 2 4K (2026)',
  'Dune (2021)',
  '[4K] Dune (2021)',
  'Dune (1984)',
  'Quiet Harbour (2025)'
].map(name => ({ name }));

describe('one card per title', () => {
  afterEach(() => setPreferredLanguages(null));

  it('shows each title once, by the copy Play would choose, where its first copy stood', () => {
    setPreferredLanguages(['en']);
    expect(oneCardPerTitle(added, item => item.name).map(item => item.name)).toEqual([
      'EN - The Odyssey 4K (2026)',
      'EN - Fall 2 4K (2026)',
      '[4K] Dune (2021)',
      'Dune (1984)',
      'Quiet Harbour (2025)'
    ]);
  });

  it("chooses the person's language before the better picture", () => {
    setPreferredLanguages(['de', 'en']);
    expect(oneCardPerTitle(added, item => item.name)[0].name).toBe('DE - The Odyssey (2026)');
  });

  it('keeps the first of each title as given, for a row whose order is its point', () => {
    expect(firstPerTitle(added, item => item.name).map(item => item.name)).toEqual([
      'EN - The Odyssey HD (2026)',
      'EN - Fall 2 (2026)',
      'Dune (2021)',
      'Dune (1984)',
      'Quiet Harbour (2025)'
    ]);
  });
});
