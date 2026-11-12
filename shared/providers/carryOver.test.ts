import { Category, Stream } from '../types';
import { idMoves, movedScope } from './carryOver';

const category = (id: string, name: string): Category => ({ category_id: id, category_name: name, parent_id: '0' });
const stream = (id: string, name: string, categoryId?: string): Stream =>
  ({ stream_id: id, name, icon: '', ...(categoryId ? { category_id: categoryId } : {}) }) as Stream;

describe('idMoves', () => {
  it('moves nothing when the new provider has the same ids', () => {
    const listing = { categories: [category('1', 'HR| CROATIA')], streams: [stream('10', 'HR| HRT 1', '1')] };
    const moves = idMoves(listing, listing);
    expect(moves.categories.size + moves.streams.size).toBe(0);
  });

  it('finds a category and a channel by name when the ids changed', () => {
    const moves = idMoves(
      { categories: [category('1', 'HR| CROATIA')], streams: [stream('10', 'HR| HRT 1 ᴴᴰ')] },
      { categories: [category('77', 'hr | croatia')], streams: [stream('900', 'HRT 1 HD', '77'), stream('901', 'HRT 2', '77')] }
    );
    expect([...moves.categories]).toEqual([['1', '77']]);
    expect([...moves.streams]).toEqual([['10', '900']]);
  });

  it('tells two channels of one name apart by the category the old one was in', () => {
    const moves = idMoves(
      { categories: [category('1', 'Sport')], streams: [stream('10', 'Arena Sport 1', '1')] },
      {
        categories: [category('5', 'Sport'), category('6', 'Sport backup')],
        streams: [stream('50', 'Arena Sport 1', '5'), stream('60', 'Arena Sport 1', '6')]
      }
    );
    expect(moves.streams.get('10')).toBe('50');
  });

  it('leaves an id where it is when the name is ambiguous or missing', () => {
    const moves = idMoves(
      { categories: [category('1', 'Netflix')], streams: [stream('10', 'Arena Sport 1'), stream('11', 'Gone')] },
      {
        categories: [category('5', 'Netflix'), category('6', 'netflix')],
        streams: [stream('50', 'Arena Sport 1', '5'), stream('60', 'Arena Sport 1', '6')]
      }
    );
    expect(moves.categories.size).toBe(0);
    expect(moves.streams.size).toBe(0);
  });
});

describe('movedScope', () => {
  it("moves a category's arrangement with it, and leaves the rest alone", () => {
    const moved = new Map([['p1x~1', 'p1x~77']]);
    expect(movedScope('stream:live:p1x~1', moved)).toBe('stream:live:p1x~77');
    expect(movedScope('stream:live:2', moved)).toBe('stream:live:2');
    expect(movedScope('category:live', moved)).toBe('category:live');
  });
});
