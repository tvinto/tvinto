import { Category, Stream } from '../types';
import { familiesOf, resultsIn, searchFacets } from './searchFacets';

/**
 * Facets over search results, against this provider's own category names --
 * which is the whole difficulty: "4K NETFLIX MOVIES", "|EN| 4K MOVIES" and
 * "|EN| 4K CHILDREN" are three categories and one idea.
 */

const categories: Category[] = [
  { category_id: '1', category_name: '4K NETFLIX MOVIES' },
  { category_id: '2', category_name: '|EN| 4K MOVIES' },
  { category_id: '3', category_name: '|EN| 4K CHILDREN' },
  { category_id: '4', category_name: 'HR| DOMAĆI FILMOVI' },
  { category_id: '5', category_name: 'NETFLIX MOVIES' }
] as unknown as Category[];

const film = (id: string, name: string, categoryId: string): Stream =>
  ({ stream_id: id, name, category_id: categoryId }) as unknown as Stream;

describe('what a set of results is made of', () => {
  const results = [
    film('10', 'X-Men 4K', '1'),
    film('11', 'X-Men: Apocalypse 4K', '2'),
    film('12', 'X-Men: First Class 4K', '2'),
    film('13', 'X-Men Kids 4K', '3'),
    film('14', 'X-Men', '5'),
    film('15', 'Tko pjeva zlo ne misli', '4')
  ];

  it('counts the categories, most first', () => {
    const facets = searchFacets(results, categories);

    expect(facets.categories.map(facet => [facet.name, facet.count])).toEqual([
      ['|EN| 4K MOVIES', 2],
      ['4K NETFLIX MOVIES', 1],
      ['|EN| 4K CHILDREN', 1],
      ['HR| DOMAĆI FILMOVI', 1],
      ['NETFLIX MOVIES', 1]
    ]);
  });

  it('gathers the categories into words somebody would say', () => {
    const facets = searchFacets(results, categories);
    const families = Object.fromEntries(facets.families.map(family => [family.key, family.count]));

    // Four 4K results across three categories, two Netflix, three English.
    expect(families['4k']).toBe(4);
    expect(families['netflix']).toBe(2);
    expect(families['en']).toBe(3);
    // One kids result, which is a chip worth nothing, so it is not offered.
    expect(families['kids']).toBeUndefined();
  });

  it('leaves out a family that separates nothing', () => {
    const everything = [film('1', 'a', '1'), film('2', 'b', '1')];

    // Both results are 4K and Netflix, so neither chip would narrow anything.
    expect(searchFacets(everything, categories).families).toEqual([]);
  });

  it('counts a result once per family, not once per category', () => {
    const facets = searchFacets(results, categories);
    const netflix = facets.families.find(family => family.key === 'netflix');

    expect(netflix?.categoryIds.sort()).toEqual(['1', '5']);
    expect(netflix?.count).toBe(2);
  });

  it('does not hide results whose category it cannot name', () => {
    const facets = searchFacets([...results, film('99', 'Orphan', '404')], categories);

    expect(facets.uncategorised).toBe(1);
    expect(facets.categories.reduce((total, facet) => total + facet.count, 0)).toBe(results.length);
  });

  it('filters to one category or a whole family, keeping the order', () => {
    expect(resultsIn(results, ['2']).map(result => result.stream_id)).toEqual(['11', '12']);
    expect(resultsIn(results, ['1', '5']).map(result => result.stream_id)).toEqual(['10', '14']);
  });
});

describe('which families a category name belongs to', () => {
  it('reads the provider’s tags', () => {
    expect(familiesOf('|EN| 4K MOVIES').map(family => family.key)).toEqual(['en', '4k']);
    expect(familiesOf('HR| DOMAĆI FILMOVI').map(family => family.key)).toEqual(['hr']);
    expect(familiesOf('DISNEY+ KIDS').map(family => family.key)).toEqual(['disney', 'kids']);
    expect(familiesOf('|EN| ANIME').map(family => family.key)).toEqual(['en', 'anime']);
  });

  it('says nothing about a name it does not recognise', () => {
    expect(familiesOf('TOP IMDB/OSCAR MOVIES')).toEqual([]);
  });
});
