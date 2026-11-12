/**
 * What a channel's name says about which channel it is.
 *
 * Its own module because two opposite directions need it: guideSuggestions
 * ranks guide channels for a person to choose from, and guideMatching decides
 * without asking anyone. The first already imports the second, so the second
 * cannot import the first without a cycle.
 */

/** Words that say nothing about which channel this is. */
const NOISE = new Set([
  'hd',
  'fhd',
  'uhd',
  'sd',
  '4k',
  'hq',
  'tv',
  'channel',
  'kanal',
  'raw',
  'vip',
  'backup'
]);

/**
 * A provider name reduced to the words that identify the channel.
 *
 * Providers prefix a country tag -- `HR|`, `BA|`, `US-` -- and suffix quality
 * and packaging. Both are noise here, and leaving them in makes every channel
 * from one country look alike.
 */
export const nameWords = (value: string): string[] => {
  const withoutTag = value.replace(/^\s*[a-z]{2,3}\s*[|:-]\s*/i, '');

  return withoutTag
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word && !NOISE.has(word));
};

/**
 * What a name's words are written with between them, taken out for searching:
 * "X-Men" is "xmen" to somebody typing, and "xmen" found nothing (a user,
 * 21 October).
 */
const SEARCH_SEPARATORS = [' ', '-', ':', '.', "'", '|', '_', ',', '/', '!', '&'];

/** A name as a store matches search words against it: lower case, no separators. */
export const searchable = (name: string): string => {
  let value = name.toLowerCase();
  for (const separator of SEARCH_SEPARATORS) {
    value = value.split(separator).join('');
  }
  return value;
};

/** `searchable` in SQL, over the column named. */
export const searchableSql = (column: string): string =>
  SEARCH_SEPARATORS.reduce(
    (sql, separator) => `REPLACE(${sql}, '${separator === "'" ? "''" : separator}', '')`,
    `LOWER(${column})`
  );

/**
 * The words of a name and every run of up to three of them written together,
 * so a word typed as one ("xmen", "spiderman") meets the name written as two.
 */
export const nameWordsJoined = (value: string): string[] => {
  const words = nameWords(value);
  const joined = [...words];
  for (let start = 0; start < words.length; start++) {
    for (let end = start + 2; end <= Math.min(words.length, start + 3); end++) {
      joined.push(words.slice(start, end).join(''));
    }
  }
  return joined;
};

/**
 * The country a provider has tagged a stream with, lower-cased, or null.
 *
 * `HR| HRT 2` is `hr`. The tag is the one part of a provider's name written
 * for a machine, and the one thing that tells two channels of the same name
 * apart -- there is an RTL 2 in Croatia and an RTL II in Germany.
 */
export const streamCountry = (name: string | undefined | null): string | null =>
  /^\s*([a-z]{2,3})\s*[|:-]/i.exec(name ?? '')?.[1]?.toLowerCase() ?? null;

/**
 * The country a guide channel's id names, or null.
 *
 * Three conventions, all seen in one real pair of guides: a suffix (`Htv2.hr`,
 * the XMLTV habit), a prefix (`mx.History 2`, `la.Nick Jr.`), and a provider's
 * tag carried into the id (`LAT| HISTORY 2 HD`). Reading only the suffix left
 * the other two looking like ids with no country, which the name matcher takes
 * as "does not disagree" -- so a Mexican schedule could have been attached to a
 * Croatian channel purely because nothing said it was Mexican.
 *
 * Plenty of ids name no country at all, which is why no answer is not the same
 * as a different answer.
 */
export const channelCountry = (id: string | undefined | null): string | null => {
  const value = (id ?? '').trim().toLowerCase();
  if (!value) {
    return null;
  }

  const suffix = /\.([a-z]{2})$/.exec(value);
  if (suffix) {
    return suffix[1];
  }

  const prefix = /^([a-z]{2})\./.exec(value);
  if (prefix) {
    return prefix[1];
  }

  return streamCountry(value);
};
