import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * One design system, and only one.
 *
 * Every control is one of the player's pieces since 1 November: the pill, the
 * chip, the setting row, the panel, the glass field, the dialog shell. The
 * old pieces are gone from the UI kit, but a template can still be written
 * the old way by hand -- a browser select, a blue word, a black backdrop --
 * and nothing else would notice, since the build accepts all of them. This
 * reads every template and fails on them, as sourceEncoding.test.ts does for
 * encodings.
 */

const APP = join(__dirname, '..');

/** Every template: component HTML, and the TypeScript holding inline ones. Not specs. */
function templates(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return templates(path);
    }
    return (name.endsWith('.html') || name.endsWith('.component.ts')) && !name.includes('.spec.') ? [path] : [];
  });
}

const RULES: { what: string; pattern: RegExp }[] = [
  // The panel (ChoicePanelService) does this; on a television a select opens Android's own list.
  { what: 'a browser <select>', pattern: /<select\b/ },
  // Setting rows and groups, not boxed cards; the card is no longer in the kit.
  { what: 'hlmCard', pattern: /\bhlmCard\b/ },
  // The pill's names are primary, secondary (the default), quiet and destructive.
  { what: "a button variant helm shipped (default, outline, ghost, link)", pattern: /\bvariant="(default|outline|ghost|link)"/ },
  { what: "a bound button variant helm shipped", pattern: /\[variant\]="[^"]*'(default|outline|ghost|link)'/ },
  // A choice is a chip, which is outlined and checked when on. A button whose
  // fill follows a state looked exactly like the main action beside it (the
  // welcome page's language, 1 November).
  {
    what: 'a choice drawn as a button whose fill follows its state (use a chip)',
    pattern: /\[variant\]="[^"]*\?\s*'(primary|secondary|quiet)'\s*:\s*'(primary|secondary|quiet)'/
  },
  // Secondary words are grey, never blue: blue text was most of why the settings looked like another app.
  { what: 'blue words (text-primary-bright)', pattern: /\btext-primary-bright\b/ },
  // A filled blue control: chosen is a check, focus is the white fill.
  { what: 'a blue fill (bg-primary)', pattern: /\bbg-primary(?![-\w])/ },
  // The page's own dim behind a dialog, not black. Things that sit on a picture
  // stay black -- a progress track, a label over video -- and are not fixed.
  { what: 'a black backdrop (a fixed bg-black/..)', pattern: /\bfixed\b[^"]*\bbg-black\/(60|70|80)\b/ }
];

describe('one design system', () => {
  const files = templates(APP);

  it('finds the templates', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const rule of RULES) {
    it(`has no ${rule.what}`, () => {
      const found = files.flatMap(file =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, index) => (rule.pattern.test(line) ? `${relative(APP, file)}:${index + 1}: ${line.trim()}` : null))
          .filter((hit): hit is string => hit !== null)
      );
      expect(found).toEqual([]);
    });
  }
});
