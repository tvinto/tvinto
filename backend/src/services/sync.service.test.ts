import { syncService } from './sync.service';
import { xtreamService } from './xtream.service';
import { progressService } from './progress.service';
import { accountsService } from '../services/accounts.service';
import { resetDatabase } from '../test-utils/seed';
import { db } from '../utils/database';

const PASSWORD = 'a-good-long-password';
let userId: number;

beforeEach(async () => {
  resetDatabase({ withAccount: false });
  userId = (await accountsService.register('petar', PASSWORD)).id;
});

/** A timestamp a given number of minutes ago, for ordering assertions. */
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

describe('pulling changes', () => {
  it('gives a device that has never synced everything at once', () => {
    xtreamService.addFavorite(userId, 'live', '42', 'Channel 42');
    xtreamService.saveManualOrder(userId, 'category:live', ['9', '3']);
    progressService.record(userId, {
      type: 'vod',
      itemId: '100',
      name: 'A Film',
      positionSeconds: 600,
      durationSeconds: 3600
    });
    syncService.saveSettings(userId, { theme: 'dark' });

    const changes = syncService.changesSince(userId);

    expect(changes.favourites).toHaveLength(1);
    expect(changes.arrangements).toHaveLength(1);
    expect(changes.progress).toHaveLength(1);
    expect(changes.settings).toEqual([
      expect.objectContaining({ key: 'theme', value: 'dark' })
    ]);
  });

  it('hands back the server clock, so the next pull does not depend on the device one', () => {
    const before = Date.now();
    const changes = syncService.changesSince(userId);

    expect(Date.parse(changes.serverTime)).toBeGreaterThanOrEqual(before);
  });

  it('returns nothing the second time, when nothing has happened in between', () => {
    xtreamService.addFavorite(userId, 'live', '42');

    const first = syncService.changesSince(userId);
    const second = syncService.changesSince(userId, first.serverTime);

    expect(first.favourites).toHaveLength(1);
    expect(second.favourites).toHaveLength(0);
  });

  it('sends an arrangement whole, because half an ordering is a wrong one', () => {
    xtreamService.saveManualOrder(userId, 'category:live', ['9', '3', '7'], { '9': 'Sport' });

    const [arrangement] = syncService.changesSince(userId).arrangements;

    expect(arrangement.itemIds).toEqual(['9', '3', '7']);
    expect(arrangement.names).toEqual({ '9': 'Sport' });
  });

  it('keeps one account out of another account\'s changes', async () => {
    const other = (await accountsService.register('someone', PASSWORD)).id;
    xtreamService.addFavorite(other, 'live', '42');

    expect(syncService.changesSince(userId).favourites).toHaveLength(0);
  });
});

describe('deletions travel', () => {
  it('reports an unstarred favourite, so another device stops believing in it', () => {
    xtreamService.addFavorite(userId, 'live', '42');
    const afterAdd = syncService.changesSince(userId).serverTime;

    xtreamService.removeFavorite(userId, 'live', '42');

    const changes = syncService.changesSince(userId, afterAdd);
    expect(changes.deletions).toEqual([
      expect.objectContaining({ kind: 'favourite', key: 'live:42' })
    ]);
  });

  it('reports a cleared arrangement, which leaves no rows to speak for itself', () => {
    xtreamService.saveManualOrder(userId, 'category:live', ['9', '3']);
    const afterSave = syncService.changesSince(userId).serverTime;

    xtreamService.saveManualOrder(userId, 'category:live', []);

    const changes = syncService.changesSince(userId, afterSave);
    expect(changes.deletions).toEqual([
      expect.objectContaining({ kind: 'arrangement', key: 'category:live' })
    ]);
  });

  it('reports every episode dropped when a whole show is forgotten', () => {
    for (const itemId of ['901', '902']) {
      progressService.record(userId, {
        type: 'series',
        itemId,
        seriesId: '42',
        name: 'The Show',
        positionSeconds: 300,
        durationSeconds: 2700
      });
    }
    const afterWatching = syncService.changesSince(userId).serverTime;

    progressService.remove(userId, 'series', '42');

    const changes = syncService.changesSince(userId, afterWatching);
    expect(changes.deletions.map(d => d.key).sort()).toEqual(['series:901', 'series:902']);
  });

  it('forgets the deletion once the thing is made again', () => {
    xtreamService.addFavorite(userId, 'live', '42');
    xtreamService.removeFavorite(userId, 'live', '42');
    xtreamService.addFavorite(userId, 'live', '42');

    const changes = syncService.changesSince(userId);

    expect(changes.deletions).toHaveLength(0);
    expect(changes.favourites).toHaveLength(1);
  });
});

describe('pushing changes', () => {
  it('applies what a device sends', () => {
    const result = syncService.applyChanges(userId, {
      favourites: [
        { type: 'live', streamId: '42', name: 'Channel 42', updatedAt: minutesAgo(1) }
      ]
    });

    expect(result.applied).toBe(1);
    expect(xtreamService.getFavoriteIds(userId, 'live')).toEqual(['42']);
  });

  it('keeps the newer of two versions, whichever arrives second', () => {
    syncService.applyChanges(userId, {
      progress: [progressChange({ positionSeconds: 1800, updatedAt: minutesAgo(1) })]
    });

    // An older reading from a device that had been offline.
    const stale = syncService.applyChanges(userId, {
      progress: [progressChange({ positionSeconds: 60, updatedAt: minutesAgo(30) })]
    });

    expect(stale.superseded).toBe(1);
    expect(stale.applied).toBe(0);
    expect(progressService.get(userId, 'vod', '100')?.positionSeconds).toBe(1800);
  });

  it('accepts a newer reading over an older stored one', () => {
    syncService.applyChanges(userId, {
      progress: [progressChange({ positionSeconds: 60, updatedAt: minutesAgo(30) })]
    });
    syncService.applyChanges(userId, {
      progress: [progressChange({ positionSeconds: 1800, updatedAt: minutesAgo(1) })]
    });

    expect(progressService.get(userId, 'vod', '100')?.positionSeconds).toBe(1800);
  });

  it('treats a resend of the same change as a no-op rather than a write', () => {
    const change = progressChange({ positionSeconds: 600, updatedAt: minutesAgo(5) });

    syncService.applyChanges(userId, { progress: [change] });
    const again = syncService.applyChanges(userId, { progress: [change] });

    expect(again.applied).toBe(0);
    expect(again.superseded).toBe(1);
  });

  it('replaces an arrangement outright rather than merging two orderings', () => {
    xtreamService.saveManualOrder(userId, 'category:live', ['1', '2', '3']);

    // Later than what is stored, which is what makes it win. Taken from the
    // stored value rather than the wall clock, because the two need not agree.
    const [stored] = syncService.changesSince(userId).arrangements;
    const later = new Date(Date.parse(stored.updatedAt) + 1000).toISOString();

    syncService.applyChanges(userId, {
      arrangements: [{ scope: 'category:live', itemIds: ['9', '8'], names: {}, updatedAt: later }]
    });

    expect(xtreamService.getManualOrder(userId, 'category:live')).toEqual(['9', '8']);
  });

  it('applies a deletion a device pushes', () => {
    xtreamService.addFavorite(userId, 'live', '42');

    syncService.applyChanges(userId, {
      deletions: [{ kind: 'favourite', key: 'live:42', deletedAt: new Date().toISOString() }]
    });

    expect(xtreamService.getFavoriteIds(userId, 'live')).toEqual([]);
  });

  it('does not delete something that was re-added after the deletion happened', () => {
    // The phone deleted it at noon; the laptop starred it again at one.
    xtreamService.addFavorite(userId, 'live', '42');

    syncService.applyChanges(userId, {
      deletions: [{ kind: 'favourite', key: 'live:42', deletedAt: minutesAgo(60) }]
    });

    expect(xtreamService.getFavoriteIds(userId, 'live')).toEqual(['42']);
  });

  it('ignores an add that a later deletion has already overtaken', () => {
    xtreamService.addFavorite(userId, 'live', '42');
    xtreamService.removeFavorite(userId, 'live', '42');

    // An offline device pushing the add it made before hearing about the removal.
    syncService.applyChanges(userId, {
      favourites: [{ type: 'live', streamId: '42', name: null, updatedAt: minutesAgo(120) }]
    });

    expect(xtreamService.getFavoriteIds(userId, 'live')).toEqual([]);
  });

  it('applies a whole batch or none of it', () => {
    const before = syncService.changesSince(userId);

    expect(() =>
      syncService.applyChanges(userId, {
        favourites: [{ type: 'live', streamId: '42', name: null, updatedAt: minutesAgo(1) }],
        // A progress entry with no type violates NOT NULL; the favourite in
        // the same batch must not survive on its own.
        progress: [progressChange({ type: null as unknown as string, updatedAt: minutesAgo(1) })]
      })
    ).toThrow();

    expect(syncService.changesSince(userId).favourites).toEqual(before.favourites);
  });

  it('ignores a deletion of a kind it does not recognise', () => {
    const result = syncService.applyChanges(userId, {
      deletions: [
        { kind: 'nonsense' as never, key: 'live:42', deletedAt: new Date().toISOString() }
      ]
    });

    expect(result.applied).toBe(0);
  });
});

describe('two devices', () => {
  /**
   * The whole point, played out: a phone and a laptop reconciling through the
   * server without either losing what the other did.
   */
  it('converge on the same state after exchanging changes', async () => {
    // The laptop stars something and arranges its categories.
    xtreamService.addFavorite(userId, 'live', '42', 'Channel 42');
    xtreamService.saveManualOrder(userId, 'category:live', ['9', '3']);

    // The phone pulls, and now knows both.
    const phonePull = syncService.changesSince(userId);
    expect(phonePull.favourites).toHaveLength(1);
    expect(phonePull.arrangements[0].itemIds).toEqual(['9', '3']);

    // The phone watches something and pushes it back, stamped later than
    // anything the server has seen.
    const phoneTime = new Date(Date.parse(phonePull.serverTime) + 1000).toISOString();
    syncService.applyChanges(userId, {
      progress: [progressChange({ positionSeconds: 900, updatedAt: phoneTime })]
    });

    // The laptop pulls only what happened since its own last look.
    const laptopPull = syncService.changesSince(userId, phonePull.serverTime);

    expect(laptopPull.progress).toHaveLength(1);
    expect(laptopPull.progress[0].positionSeconds).toBe(900);
    // And is not handed back the things it already had.
    expect(laptopPull.favourites).toHaveLength(0);
    expect(laptopPull.arrangements).toHaveLength(0);
  });

  it('a device gone a long time still gets everything by asking from the start', () => {
    xtreamService.addFavorite(userId, 'live', '42');
    xtreamService.saveManualOrder(userId, 'category:live', ['9']);

    const fromScratch = syncService.changesSince(userId);

    expect(fromScratch.favourites).toHaveLength(1);
    expect(fromScratch.arrangements).toHaveLength(1);
  });
});

describe('settings', () => {
  it('round-trips preferences that used to live in one browser', () => {
    syncService.saveSettings(userId, { theme: 'dark', categorySort: 'manual' });

    expect(syncService.getSettings(userId)).toEqual({ theme: 'dark', categorySort: 'manual' });
  });

  it('updates a setting rather than accumulating copies', () => {
    syncService.saveSettings(userId, { theme: 'dark' });
    syncService.saveSettings(userId, { theme: 'light' });

    expect(syncService.getSettings(userId)).toEqual({ theme: 'light' });
    const rows = db.prepare('SELECT COUNT(*) c FROM user_settings WHERE user_id = ?').get(userId) as {
      c: number;
    };
    expect(rows.c).toBe(1);
  });
});

describe('pruneTombstones', () => {
  it('drops records of deletions too old for any device to still need', () => {
    syncService.recordDeletion(userId, 'favourite', 'live:1', minutesAgo(200 * 24 * 60));
    syncService.recordDeletion(userId, 'favourite', 'live:2', minutesAgo(1));

    expect(syncService.pruneTombstones(90)).toBe(1);
    expect(syncService.changesSince(userId).deletions.map(d => d.key)).toEqual(['live:2']);
  });
});

/** A progress change with sensible defaults, overridable per test. */
function progressChange(overrides: Record<string, unknown> = {}) {
  return {
    type: 'vod' as const,
    itemId: '100',
    seriesId: null,
    season: null,
    episodeNum: null,
    name: 'A Film',
    episodeTitle: null,
    icon: null,
    containerExtension: null,
    positionSeconds: 600,
    durationSeconds: 3600,
    completed: false,
    updatedAt: new Date().toISOString(),
    ...overrides
  } as Parameters<typeof syncService.applyChanges>[1] extends { progress?: (infer P)[] }
    ? P
    : never;
}
