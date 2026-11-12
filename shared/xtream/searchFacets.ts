import { Category, Stream } from '../types';

/**
 * Where a set of search results came from, as something to look at and filter by.
 *
 * Search reaches across the whole library, which is what makes it useful and
 * also what makes a hundred results confusing: this provider files the same
 * film in half a dozen places, so "x-men" answers with X-Men four times over
 * and nothing on screen says which copy is which. The results carry a
 * `category_id`; this turns that into the two questions worth asking of them --
 * *which category is this one in* and *show me only the ones like it*.
 *
 * Two levels, because the categories themselves are too many and too finely
 * cut to scan: 364 of them, with "4K NETFLIX MOVIES", "|EN| 4K MOVIES" and
 * "|EN| 4K CHILDREN" all separate. A family gathers those into the words
 * somebody would actually use -- 4K, Netflix, Kids -- while the categories
 * stay available underneath for anyone who knows the line.
 */

export interface CategoryFacet {
  categoryId: string;
  name: string;
  count: number;
}

export interface FamilyFacet {
  /** A stable key for the chip; `4k`, `netflix`, `kids`. */
  key: string;
  label: string;
  count: number;
  /** Which categories fed it, so a chip can filter without re-deriving anything. */
  categoryIds: string[];
}

export interface SearchFacets {
  categories: CategoryFacet[];
  families: FamilyFacet[];
  /** Results whose category is not in the list any more -- rare, and never hidden. */
  uncategorised: number;
}

/**
 * The families, in the order they are offered.
 *
 * Ordered by what decides whether somebody can watch a thing at all. Language
 * first: an English film is no use to a viewer who wants Croatian, whatever
 * else is true of it. Then where it came from, then who it is for, and quality
 * last -- 4K is a preference, not a requirement, and it is also the tag most
 * likely to be in a name for marketing reasons.
 *
 * Each is a word somebody would say. Nothing here invents a genre the provider
 * did not name.
 */
const FAMILIES: readonly { key: string; label: string; test: RegExp }[] = [
  { key: 'hr', label: 'Croatian', test: /\b(hr|hrv|croat)\b|doma[cć]/i },
  { key: 'exyu', label: 'Ex-YU', test: /\b(ex[- ]?yu|srb|srp|bih|bos|mne|mkd|slo)\b/i },
  { key: 'en', label: 'English', test: /\b(en|eng|uk|usa)\b/i },
  { key: 'netflix', label: 'Netflix', test: /netflix/i },
  { key: 'disney', label: 'Disney+', test: /disney/i },
  { key: 'apple', label: 'Apple TV+', test: /apple\s*\+?/i },
  { key: 'hbo', label: 'HBO / Max', test: /\bhbo\b|\bmax\b/i },
  { key: 'prime', label: 'Prime', test: /\bprime\b|amazon/i },
  { key: 'kids', label: 'Kids', test: /\b(kids|children|family|cartoon|djeca|dje[cč]ji)\b/i },
  { key: 'anime', label: 'Anime', test: /\banime\b|\bmanga\b/i },
  { key: 'documentary', label: 'Documentary', test: /\bdocu|dokument/i },
  { key: '4k', label: '4K', test: /\b(4k|uhd|2160p?)\b/i }
];

/** Every family a category name belongs to, in the order above. */
export const familiesOf = (categoryName: string): { key: string; label: string }[] =>
  FAMILIES.filter(family => family.test.test(categoryName)).map(({ key, label }) => ({ key, label }));

/**
 * What the results are made of: their categories, and the families those fall in.
 *
 * Categories are ordered by how many results they hold, because that is the
 * order somebody scans them in; ties keep the library's own order, so the same
 * search twice does not shuffle. A family counts a result once however many of
 * its categories match -- a film in "4K NETFLIX MOVIES" is one Netflix result
 * and one 4K result, not two of either.
 */
export const searchFacets = (results: Stream[], categories: Category[]): SearchFacets => {
  const names = new Map<string, string>();
  const order = new Map<string, number>();
  categories.forEach((category, index) => {
    const id = String(category.category_id);
    names.set(id, category.category_name);
    order.set(id, index);
  });

  const counts = new Map<string, number>();
  let uncategorised = 0;

  for (const result of results) {
    const id = String((result as unknown as Record<string, unknown>)['category_id'] ?? '');
    if (!id || !names.has(id)) {
      uncategorised += 1;
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const categoryFacets: CategoryFacet[] = [...counts.entries()]
    .map(([categoryId, count]) => ({ categoryId, name: names.get(categoryId) ?? '', count }))
    .sort((a, b) => b.count - a.count || (order.get(a.categoryId) ?? 0) - (order.get(b.categoryId) ?? 0));

  const families = new Map<string, FamilyFacet>();
  for (const facet of categoryFacets) {
    for (const { key, label } of familiesOf(facet.name)) {
      const family = families.get(key) ?? { key, label, count: 0, categoryIds: [] };
      family.count += facet.count;
      family.categoryIds.push(facet.categoryId);
      families.set(key, family);
    }
  }

  return {
    categories: categoryFacets,
    // A family that holds everything separates nothing, and one that holds a
    // single result is a chip nobody needs.
    families: [...families.values()]
      .filter(family => family.count > 1 && family.count < results.length)
      .sort((a, b) => b.count - a.count || FAMILIES.findIndex(f => f.key === a.key) - FAMILIES.findIndex(f => f.key === b.key)),
    uncategorised
  };
};

/** The results in one category, or one family, keeping the order they arrived in. */
export const resultsIn = (results: Stream[], categoryIds: readonly string[]): Stream[] => {
  const wanted = new Set(categoryIds.map(String));
  return results.filter(result =>
    wanted.has(String((result as unknown as Record<string, unknown>)['category_id'] ?? ''))
  );
};
