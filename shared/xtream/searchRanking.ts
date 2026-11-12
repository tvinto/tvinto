import { Stream } from '../types';
import { nameWords } from './channelNames';

/**
 * Search results in the order of how closely they answer what was typed.
 *
 * Alphabetical order is the wrong answer to a search. Type "x-men" and the
 * library has the film itself, four other copies of it, six sequels and a
 * handful of things merely containing the words; sorted by name, the film you
 * asked for sits somewhere in the middle of its own sequels. What a person
 * means by "closest" is the title with the least *else* in it.
 *
 * So the comparison is on words, not characters, and on words with the
 * provider's packaging already thrown away (`nameWords` drops the country tag,
 * `4K`, `HD`, `VIP` and the rest). A release year is dropped here too: "X-Men"
 * and "X-Men 2000" are the same film named twice, while "X-Men 2" is a
 * different film and its number stays.
 *
 * Four ranks, coarse on purpose -- anything finer is a guess dressed as a
 * measurement:
 *
 *   0  the same title, once the packaging is gone: "X-Men", "X-Men 4K"
 *   1  the title carries straight on: "X-Men 2", "X-Men Apocalypse"
 *   2  the words appear together, but with something in front: "The X-Men Story"
 *   3  the words are all there, scattered: "Men of X"
 *
 * Within a rank, fewer extra words first, then alphabetical, so the order is
 * the same every time the same search is run.
 */

/** A year a film was released, as the provider writes it into a name. */
const YEAR = /^(19|20)\d{2}$/;

/**
 * The provider's other way of writing a country tag: `|EN| X-MEN`.
 *
 * `nameWords` knows `EN - X-Men` and `HR| HRT 2`, where the tag comes first and
 * the bar after; it does not know a tag wrapped in bars or brackets, and this
 * library is full of them. Left in, "en" counts as a word of the title and the
 * film ranks below its own sequels.
 */
const WRAPPED_TAG = /^\s*[|[(]\s*[a-z]{2,3}\s*[|\])]\s*/i;

const meaningful = (value: string): string[] =>
  nameWords(value.replace(WRAPPED_TAG, '')).filter(word => !YEAR.test(word));

/**
 * Whether a word of a name answers a word of the query.
 *
 * The same rule search itself uses: a word of three letters or more may match
 * the start of a longer one, so "apoca" answers "Apocalypse" and the film is
 * ranked as the film rather than as something merely containing the words.
 */
const answers = (nameWord: string, wanted: string): boolean =>
  nameWord === wanted || (wanted.length >= 3 && nameWord.startsWith(wanted));

/** Whether `words` begins with `wanted`. */
const startsWith = (words: string[], wanted: string[]): boolean =>
  wanted.every((word, index) => words[index] !== undefined && answers(words[index], word));

/** Where `wanted` appears as a run inside `words`, or -1. */
const runAt = (words: string[], wanted: string[]): number => {
  for (let start = 0; start + wanted.length <= words.length; start += 1) {
    if (wanted.every((word, index) => answers(words[start + index], word))) {
      return start;
    }
  }
  return -1;
};

export interface MatchRank {
  /** 0 is the closest. See the ranks above. */
  rank: number;
  /** Words in the name that the query did not ask for. */
  extra: number;
}

export const matchRank = (name: string, query: string): MatchRank => {
  const wanted = meaningful(query);
  const words = meaningful(name);

  if (!wanted.length) {
    return { rank: 3, extra: words.length };
  }

  const extra = Math.max(0, words.length - wanted.length);

  if (words.length === wanted.length && startsWith(words, wanted)) {
    return { rank: 0, extra: 0 };
  }
  if (startsWith(words, wanted)) {
    return { rank: 1, extra };
  }
  if (runAt(words, wanted) > 0) {
    return { rank: 2, extra };
  }
  return { rank: 3, extra };
};

/**
 * The results, closest first.
 *
 * A copy rather than a sort in place: the list handed in belongs to the store,
 * and a component reordering it underneath would change what every other
 * screen sees.
 */
export const byCloseness = (results: readonly Stream[], query: string): Stream[] =>
  [...results]
    .map(stream => ({ stream, ...matchRank(stream.name ?? '', query) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.extra - b.extra ||
        (a.stream.name ?? '').localeCompare(b.stream.name ?? '', undefined, { sensitivity: 'base' })
    )
    .map(entry => entry.stream);
