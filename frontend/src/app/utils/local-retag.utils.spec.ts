import { retagCategoryLists, retagGuideSources, retagId, retagLocalData, retagReminders } from './local-retag.utils';

/**
 * A device's first provider, filed without a tag, moving to `pnew` on the
 * account it signs in to; a second provider, `pold`, staying put.
 */
const moves = new Map([['', 'pnew']]);

describe('retagId', () => {
  it('moves an untagged id to the new tag', () => {
    expect(retagId('1234', moves)).toBe('pnew~1234');
  });

  it('leaves an id of a provider that did not move', () => {
    expect(retagId('pold~1234', moves)).toBe('pold~1234');
  });

  it('moves a tagged id to no tag', () => {
    expect(retagId('pold~1234', new Map([['pold', '']]))).toBe('1234');
  });
});

describe('retagLocalData', () => {
  const stored = JSON.stringify({
    favourites: {
      'live:1234': { change: { type: 'live', streamId: '1234', name: 'HRT 1', updatedAt: 't1' }, icon: 'x.png' },
      'live:pold~9': { change: { type: 'live', streamId: 'pold~9', name: 'Other', updatedAt: 't1' }, icon: '' }
    },
    progress: {
      'series:77': { type: 'series', itemId: '77', seriesId: '12', name: 'E1', updatedAt: 't2' }
    },
    arrangements: {
      'category:live': { scope: 'category:live', itemIds: ['5', 'pold~6'], names: { '5': 'Sport' }, updatedAt: 't3' },
      'stream:live:5': { scope: 'stream:live:5', itemIds: ['1234'], names: {}, updatedAt: 't3' }
    },
    tombstones: { 'favourite:live:1': { kind: 'favourite', key: 'live:1', deletedAt: 't0' } },
    pending: { favourites: [] }
  });

  const moved = JSON.parse(retagLocalData(stored, moves));

  it('files favourites under the new tag, keys and ids alike', () => {
    expect(Object.keys(moved.favourites).sort()).toEqual(['live:pnew~1234', 'live:pold~9']);
    expect(moved.favourites['live:pnew~1234'].change.streamId).toBe('pnew~1234');
    expect(moved.favourites['live:pnew~1234'].icon).toBe('x.png');
  });

  it('files history and its show under the new tag', () => {
    expect(moved.progress['series:pnew~77']).toMatchObject({ itemId: 'pnew~77', seriesId: 'pnew~12' });
  });

  it('moves arrangements, their scopes, items and names', () => {
    expect(moved.arrangements['category:live']).toMatchObject({ itemIds: ['pnew~5', 'pold~6'], names: { 'pnew~5': 'Sport' } });
    expect(moved.arrangements['stream:live:pnew~5']).toMatchObject({ scope: 'stream:live:pnew~5', itemIds: ['pnew~1234'] });
  });

  it('drops deletions and the queue, which the sign-in rebuilds', () => {
    expect(moved.tombstones).toEqual({});
    expect(moved.pending).toBeUndefined();
  });
});

describe('the other drawers', () => {
  it('moves guide matches', () => {
    const raw = JSON.stringify({ sources: [{ id: 's1' }], mappings: { '1234': { streamId: '1234', sourceId: 's1', channelId: 'HRT1.hr', mappedAt: 't' } } });
    expect(JSON.parse(retagGuideSources(raw, moves)).mappings).toEqual({
      'pnew~1234': { streamId: 'pnew~1234', sourceId: 's1', channelId: 'HRT1.hr', mappedAt: 't' }
    });
  });

  it('moves reminders', () => {
    const raw = JSON.stringify([{ streamId: '1234', start: 1 }]);
    expect(JSON.parse(retagReminders(raw, moves))).toEqual([{ streamId: 'pnew~1234', start: 1 }]);
  });

  it('moves hidden or locked categories', () => {
    const raw = JSON.stringify({ live: ['5', 'pold~6'], vod: [] });
    expect(JSON.parse(retagCategoryLists(raw, moves))).toEqual({ live: ['pnew~5', 'pold~6'], vod: [] });
  });
});
