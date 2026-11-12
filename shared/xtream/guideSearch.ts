/**
 * Finding a programme in the guide by its title:
 * the matching every store shares, so "sport" finds "Šport", "dnevnik" finds
 * "Dnevnik" and "Đir" finds "dir" whichever store holds the guide.
 */

/** Lower case, accents and the Croatian đ folded away, spaces collapsed. */
export const foldText = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** The shortest query worth searching: two letters match half the guide. */
export const MIN_QUERY = 3;

/** Whether a title holds the query, folded alike. */
export const titleMatches = (title: string, query: string): boolean => {
  const wanted = foldText(query);
  return wanted.length >= MIN_QUERY && foldText(title).includes(wanted);
};

/**
 * A SQLite LIKE pattern that finds at least every title `titleMatches` would,
 * for a store that cannot fold text itself. LIKE ignores case only in ASCII,
 * so every letter that has an accented form in the guides' languages -- and
 * every letter that is not ASCII -- becomes the one-character wildcard. What it
 * lets through besides is checked with `titleMatches` afterwards.
 */
export const likePattern = (query: string): string => {
  const pattern = [...foldText(query)]
    .map(character => {
      if (/[%_\\]/.test(character)) {
        return `\\${character}`;
      }
      if (/[csz]/.test(character) || /[^\x20-\x7e]/.test(character)) {
        return '_';
      }
      // A d may stand for đ, which folds to d but is one character in the title.
      return character === 'd' ? '_' : character;
    })
    .join('');
  return `%${pattern}%`;
};
