import { cleanReport } from './errorReports';
import { removeTitles, titleFilter } from './heldTitles';

// Titles the person only browsed past: in the library or the guide, never played.
const BROWSED = ['Ein Fall für Zwei', 'HR: RTL Kockica HD', '(500) Days of Summer', 'Doctor Who', 'Doctor Who: Flux', 'Up'];

describe('titleFilter', () => {
  const filter = titleFilter(BROWSED);

  it('takes out a browsed title wherever it stands, in any case', () => {
    expect(filter("Cannot read properties of undefined (reading 'ein fall für zwei')")).toBe(
      "Cannot read properties of undefined (reading '[title]')"
    );
    expect(filter('No poster for HR: RTL Kockica HD in row 3')).toBe('No poster for [title] in row 3');
  });

  it('takes a title whose first character is not a letter, and the longer of two', () => {
    expect(filter('(500) Days of Summer failed')).toBe('[title] failed');
    expect(filter('Doctor Who: Flux, then Doctor Who')).toBe('[title], then [title]');
  });

  it('leaves words that only contain a title, and titles too short to take out', () => {
    expect(filter('Doctor Whom is not a show')).toBe('Doctor Whom is not a show');
    expect(filter('Speed up the parser')).toBe('Speed up the parser');
  });

  it('leaves text alone when there are no titles', () => {
    expect(titleFilter([])('anything at all')).toBe('anything at all');
  });

  it('is fast enough for a whole library', () => {
    const library = Array.from({ length: 50_000 }, (_, i) => `Film Number ${i} (20${i % 25})`);
    const many = titleFilter(library);
    const text = 'TypeError: x is undefined at row Film Number 49999 (2024) '.repeat(200);
    const started = Date.now();
    const out = many(text);
    expect(Date.now() - started).toBeLessThan(500);
    expect(out).not.toContain('Film Number 49999');
  });
});

describe('removeTitles with cleanReport', () => {
  it('leaves no browsed title in any part of a report', () => {
    const event = {
      event_id: 'abcdef0123456789abcdef0123456789',
      message: 'Episode list for Ein Fall für Zwei is empty',
      exception: { values: [{ type: 'Error', value: 'Doctor Who: Flux has no seasons', stacktrace: { frames: [{ function: 'show', filename: 'main.js' }] } }] },
      extra: { rows: ['HR: RTL Kockica HD'] },
      tags: { failure: 'stream' }
    };
    const cleaned = removeTitles(cleanReport(event, []), titleFilter(BROWSED));
    const text = JSON.stringify(cleaned);
    for (const title of BROWSED.filter(title => title.length >= 3)) {
      expect(text.toLowerCase()).not.toContain(title.toLowerCase());
    }
    expect(cleaned.event_id).toBe(event.event_id);
    expect(cleaned.tags.failure).toBe('stream');
  });
});
