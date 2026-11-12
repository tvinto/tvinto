import { LANGUAGES, setCurrentLanguage, t } from './i18n';
import en from '../i18n/en.json';

/**
 * Every language, kept in step with English.
 *
 * A key missing from a language falls back to English without a word, which
 * is exactly how a half-translated screen ships. These say so instead, for
 * every file in i18n/ (as iptvnator checks its own, 10 November).
 */
describe('the dictionaries', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const folder = path.join(__dirname, '..', 'i18n');
  const files = fs.readdirSync(folder).filter(name => name.endsWith('.json'));
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')) as Record<string, unknown>;
  const english = read('en.json');

  type Tree = string | { [key: string]: Tree };
  const PLURAL = /^(zero|one|two|few|many|other)$/;
  const isPlural = (node: Tree): node is Record<string, string> =>
    typeof node === 'object' && Object.keys(node).length > 0 && Object.keys(node).every(name => PLURAL.test(name));
  /** Each word's key, a plural counted once by the key above its forms. */
  const words = (tree: Tree, at = ''): Map<string, Tree> => {
    const out = new Map<string, Tree>();
    if (typeof tree === 'string' || isPlural(tree)) {
      out.set(at, tree);
      return out;
    }
    for (const [name, inner] of Object.entries(tree)) {
      for (const [key, value] of words(inner, at ? `${at}.${name}` : name)) {
        out.set(key, value);
      }
    }
    return out;
  };
  const englishWords = words(english as Tree);
  const filled = (text: unknown) => [...String(text).matchAll(/\{\{\s*(\w+)\s*\}\}|\{(\d)\}/g)].map(m => m[1] ?? m[2]).sort();
  const LANGUAGE_IDS = LANGUAGES.map(language => language.id);

  it('has a file for every language offered, and offers every file', () => {
    expect(files.map(name => name.replace(/\.json$/, '')).sort()).toEqual([...LANGUAGE_IDS].sort());
  });

  it('never uses an em dash in English either', () => {
    expect(JSON.stringify(english)).not.toContain(String.fromCharCode(0x2014));
  });

  describe.each(files.filter(name => name !== 'en.json'))('%s', name => {
    const language = name.replace(/\.json$/, '');
    const locale = LANGUAGES.find(choice => choice.id === language)?.locale ?? language;
    const theirs = words(read(name) as Tree);

    it('has every word English has, and nothing English lacks', () => {
      expect([...theirs.keys()].sort()).toEqual([...englishWords.keys()].sort());
    });

    it('fills the same values in each word', () => {
      const wrong: string[] = [];
      for (const [key, word] of englishWords) {
        const mine = theirs.get(key);
        const reference = filled(typeof word === 'string' ? word : word['other']);
        const forms = mine === undefined ? [] : typeof mine === 'string' ? [mine] : Object.values(mine);
        for (const form of forms) {
          // A count's own form may leave the number out ("one channel"), never put another in.
          const names = filled(form);
          if (typeof mine === 'string' ? names.join() !== reference.join() : names.some(n => !reference.includes(n))) {
            wrong.push(`${key}: ${form}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it('has every plural form its language uses', () => {
      const rules = new Intl.PluralRules(locale);
      const needed = [...new Set(Array.from({ length: 1001 }, (_, n) => rules.select(n)))];
      const missing: string[] = [];
      for (const [key, word] of theirs) {
        if (typeof word !== 'string') {
          for (const form of needed.filter(form => !(form in word))) {
            missing.push(`${key}.${form}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it('never uses an em dash, which reads as machine-written (26 September)', () => {
      expect(JSON.stringify(read(name))).not.toContain('—');
    });
  });
});

describe('the keys the app asks for', () => {
  // Every literal key in the templates and the code: 'x.y' | t, and t('x.y').
  // A key that is not in the dictionary shows on screen as the key itself.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const root = path.join(__dirname, '..');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
    );

  it('finds every one of them in English', () => {
    const missing: string[] = [];
    for (const file of files(root).filter(name => /\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts'))) {
      const source = fs.readFileSync(file, 'utf8');
      const used = [
        ...source.matchAll(/'([a-z][\w-]*(?:\.[\w-]+)+)'\s*\|\s*t\b/g),
        ...source.matchAll(/\bt\(\s*'([a-z][\w-]*(?:\.[\w-]+)+)'/g),
        ...source.matchAll(/\?\s*'([a-z][\w-]*(?:\.[\w-]+)+)'\s*:\s*'([a-z][\w-]*(?:\.[\w-]+)+)'\s*\)\s*\|\s*t\b/g)
      ].flatMap(match => match.slice(1).filter(Boolean));
      for (const key of used) {
        const leaf = key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], en);
        if (leaf === undefined) {
          missing.push(`${path.relative(root, file)}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('t', () => {
  afterEach(() => setCurrentLanguage('en'));

  it('speaks English with nothing set up, as every other test here relies on', () => {
    expect(t('time.minLeft', { count: 23 })).toBe('23 min left');
  });

  it('speaks Croatian once told to', () => {
    setCurrentLanguage('hr');
    expect(t('account.title')).toBe('Račun');
  });

  it('chooses the Croatian plural by its own rules', () => {
    setCurrentLanguage('hr');
    expect(t('guides.channels', { count: 1 })).toBe('1 kanal');
    expect(t('guides.channels', { count: 3 })).toBe('3 kanala');
    expect(t('guides.channels', { count: 5 })).toBe('5 kanala');
    expect(t('account.subscriptions', { count: 2 })).toBe('2 pretplate');
    expect(t('account.subscriptions', { count: 21 })).toBe('21 pretplata');
  });

  it('writes large numbers the way each language does, and leaves a year alone', () => {
    expect(t('guides.channels', { count: 12500 })).toBe('12,500 channels');
    setCurrentLanguage('hr');
    expect(t('guides.channels', { count: 12500 })).toBe('12.500 kanala');
    expect(t('show.season', { season: 2024 })).toBe('Sezona 2024');
  });

  it('shows the key itself for a word nobody wrote, so it is found by looking', () => {
    expect(t('nowhere.at.all')).toBe('nowhere.at.all');
  });
});
