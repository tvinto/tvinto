import { ChangeSet, countChanges, splitChangeSet } from '@shared/sync';
import { fnv1aHex } from '@shared/xtream/guideSourceId';
import { HeldData, changeSetFrom, syncCursorKey } from './sync-queue.utils';

/**
 * Moving an account to a different server.
 *
 * Both of these are silent when wrong, which is the reason they are separated
 * out far enough to be tested at all. A cursor scoped to the wrong thing loses
 * an entire history without anything failing; a batch built from an incomplete
 * list loses whichever kind was left out. Neither end reports a thing.
 */

const LOCAL = 'http://localhost:3000/api';
const WORKER = 'https://xtream-sync.example.workers.dev/api';

const held = (): HeldData => ({
  favourites: [
    { type: 'live', streamId: '101', name: 'HTV 1', updatedAt: '2026-08-30T10:00:00.000Z' }
  ],
  progress: [
    {
      type: 'vod',
      itemId: '55',
      seriesId: null,
      season: null,
      episodeNum: null,
      name: 'A Film',
      episodeTitle: null,
      icon: null,
      containerExtension: 'mkv',
      positionSeconds: 1902,
      durationSeconds: 3600,
      completed: false,
      updatedAt: '2026-08-30T10:00:00.000Z'
    }
  ],
  arrangements: [
    {
      scope: 'category:live',
      itemIds: ['3', '1'],
      names: {},
      updatedAt: '2026-08-30T10:00:00.000Z'
    }
  ],
  tombstones: [{ kind: 'favourite', key: 'live:99', deletedAt: '2026-08-30T09:00:00.000Z' }],
  guideSources: [
    { id: 'src-1a2b3c4d', payload: 'sb1$aXY=$c2VhbGVk', updatedAt: '2026-08-30T10:00:00.000Z' }
  ],
  channelMappings: [
    {
      streamId: '101',
      sourceId: 'src-1a2b3c4d',
      channelId: 'HTV1.hr',
      updatedAt: '2026-08-30T10:00:00.000Z'
    }
  ]
});

describe('syncCursorKey', () => {
  it('gives two servers two different cursors', () => {
    // The bug this exists to prevent. One cursor for both would have a device
    // ask a service that had never heard of it for changes since last Tuesday,
    // be told there were none, and never send it anything.
    expect(syncCursorKey('cursor', 'petar', LOCAL, fnv1aHex)).not.toBe(
      syncCursorKey('cursor', 'petar', WORKER, fnv1aHex)
    );
  });

  it('gives two accounts on one server two different cursors', () => {
    expect(syncCursorKey('cursor', 'petar', LOCAL, fnv1aHex)).not.toBe(
      syncCursorKey('cursor', 'luigi', LOCAL, fnv1aHex)
    );
  });

  it('gives the same account on the same server the same cursor', () => {
    // Which is what makes going back resume rather than start again.
    expect(syncCursorKey('cursor', 'petar', LOCAL, fnv1aHex)).toBe(
      syncCursorKey('cursor', 'petar', LOCAL, fnv1aHex)
    );
  });

  it('has an answer for nobody signed in', () => {
    expect(syncCursorKey('cursor', null, LOCAL, fnv1aHex)).toContain('none');
  });

  it('says nothing about where the server is', () => {
    // A storage key is readable by anything that can read storage, and an API
    // URL can carry a subdomain worth keeping to oneself.
    expect(syncCursorKey('cursor', 'petar', WORKER, fnv1aHex)).not.toContain('workers.dev');
  });
});

describe('changeSetFrom', () => {
  it('carries every kind the account has', () => {
    const batch = changeSetFrom(held());

    // Counted rather than spot-checked: a kind added to the protocol and
    // forgotten here would be a kind that silently never migrates.
    expect(countChanges(batch)).toBe(6);
    expect(batch.favourites).toHaveLength(1);
    expect(batch.progress).toHaveLength(1);
    expect(batch.arrangements).toHaveLength(1);
    expect(batch.deletions).toHaveLength(1);
    expect(batch.guideSources).toHaveLength(1);
    expect(batch.channelMappings).toHaveLength(1);
  });

  it('keeps the details a resume point needs', () => {
    const [entry] = changeSetFrom(held()).progress;

    expect(entry).toMatchObject({ itemId: '55', positionSeconds: 1902, containerExtension: 'mkv' });
  });

  it('carries removals as well as things', () => {
    // Without the tombstones, a favourite removed on this device would come
    // back the moment the new server heard about it from somewhere else.
    expect(changeSetFrom(held()).deletions).toEqual([
      { kind: 'favourite', key: 'live:99', deletedAt: '2026-08-30T09:00:00.000Z' }
    ]);
  });

  it('gives the same batch every time it is asked', () => {
    // A first push against an unreachable service leaves the cursor unwritten,
    // so the next tick comes straight back here. Rebuilding has to be the same
    // as never having built it, or the queue doubles on every attempt.
    expect(changeSetFrom(held())).toEqual(changeSetFrom(held()));
  });

  it('does not hand out the caller its own arrays', () => {
    const source = held();
    const batch = changeSetFrom(source);
    batch.favourites.push(source.favourites[0]);

    expect(source.favourites).toHaveLength(1);
  });

  it('is empty for a device that has nothing to offer', () => {
    expect(countChanges(changeSetFrom({}))).toBe(0);
  });

  it('splits into pieces a Worker will take, losing nothing', () => {
    const many: HeldData = {
      ...held(),
      favourites: Array.from({ length: 57 }, (_, index) => ({
        type: 'live' as const,
        streamId: String(index),
        name: null,
        updatedAt: '2026-08-30T10:00:00.000Z'
      }))
    };

    const batch = changeSetFrom(many);
    const pieces = splitChangeSet(batch);

    expect(pieces.every(piece => countChanges(piece) <= 20)).toBe(true);
    expect(pieces.reduce((total, piece) => total + countChanges(piece), 0)).toBe(
      countChanges(batch)
    );

    const rejoined = pieces.reduce<ChangeSet>(
      (all, piece) => ({
        favourites: [...all.favourites, ...piece.favourites],
        progress: [...all.progress, ...piece.progress],
        arrangements: [...all.arrangements, ...piece.arrangements],
        settings: [...all.settings, ...piece.settings],
        guideSources: [...all.guideSources, ...piece.guideSources],
        channelMappings: [...all.channelMappings, ...piece.channelMappings],
        deletions: [...all.deletions, ...piece.deletions]
      }),
      changeSetFrom({})
    );

    expect(rejoined).toEqual(batch);
  });
});
