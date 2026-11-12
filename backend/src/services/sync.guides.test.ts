import { syncService } from './sync.service';
import { accountsService } from './accounts.service';
import { resetDatabase } from '../test-utils/seed';
import { db } from '../utils/database';

/**
 * Guides and channel mappings travelling with the account.
 *
 * The same two kinds the Worker carries, tested here as well because both
 * servers have to speak them for as long as both exist -- a device moved to
 * one and back would otherwise lose the mappings it made in between.
 *
 * The asymmetry between them is the interesting part. A source is opaque: its
 * URL is `xmltv.php?username=...&password=...` and this server holds no key to
 * it. A mapping is not: a stream id and `HTV1.hr` give nothing away, and
 * keeping it readable is what lets it be a row per entry with tombstones,
 * which is what stops two devices discarding each other's work.
 */

const PASSWORD = 'a-good-long-password';
let userId: number;

beforeEach(async () => {
  resetDatabase({ withAccount: false });
  userId = (await accountsService.register('petar', PASSWORD)).id;
});

const SEALED = 'sb1$bm9uY2U=$Y2lwaGVydGV4dA==';

const source = (id: string, updatedAt: string, payload = SEALED) => ({ id, payload, updatedAt });

const mapping = (streamId: string, channelId: string, updatedAt: string) => ({
  streamId,
  sourceId: 'src-1a2b3c4d',
  channelId,
  updatedAt
});

describe('guide sources', () => {
  it('carries one from device to device', () => {
    syncService.applyChanges(userId, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z')]
    });

    expect(syncService.changesSince(userId).guideSources).toEqual([
      { id: 'src-1a2b3c4d', payload: SEALED, updatedAt: '2026-08-30T10:00:00.000Z' }
    ]);
  });

  it('holds nothing it could read', () => {
    syncService.applyChanges(userId, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z')]
    });

    const row = db.prepare('SELECT * FROM guide_sources').get() as Record<string, unknown>;

    expect(Object.keys(row)).not.toContain('url');
    expect(Object.keys(row)).not.toContain('label');
    expect(row['payload']).toBe(SEALED);
  });

  it('keeps the newer of two versions', () => {
    syncService.applyChanges(userId, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T12:00:00.000Z', 'sb1$new$new')]
    });
    const older = syncService.applyChanges(userId, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z')]
    });

    expect(older).toEqual({ applied: 0, superseded: 1 });
    expect(syncService.changesSince(userId).guideSources[0].payload).toBe('sb1$new$new');
  });

  it('makes a removal stick against a device still holding the old one', () => {
    syncService.applyChanges(userId, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z')]
    });
    syncService.applyChanges(userId, {
      deletions: [
        { kind: 'guideSource', key: 'src-1a2b3c4d', deletedAt: '2026-08-30T11:00:00.000Z' }
      ]
    });
    syncService.applyChanges(userId, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T10:30:00.000Z')]
    });

    expect(syncService.changesSince(userId).guideSources).toEqual([]);
  });

  it('lets one be added again afterwards', () => {
    syncService.applyChanges(userId, {
      deletions: [
        { kind: 'guideSource', key: 'src-1a2b3c4d', deletedAt: '2026-08-30T11:00:00.000Z' }
      ]
    });
    syncService.applyChanges(userId, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T12:00:00.000Z')]
    });

    const changes = syncService.changesSince(userId);
    expect(changes.guideSources).toHaveLength(1);
    // The tombstone is forgotten, or the next pull would remove it again on
    // the device that just added it back.
    expect(changes.deletions).toEqual([]);
  });

  it('refuses one with nothing to identify it', () => {
    const result = syncService.applyChanges(userId, {
      guideSources: [
        { id: '', payload: SEALED, updatedAt: '2026-08-30T10:00:00.000Z' },
        { id: 'src-1a2b3c4d', payload: '', updatedAt: '2026-08-30T10:00:00.000Z' }
      ]
    });

    expect(result).toEqual({ applied: 0, superseded: 2 });
  });
});

describe('channel mappings', () => {
  it('carries the work somebody did by hand', () => {
    syncService.applyChanges(userId, {
      channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')]
    });

    expect(syncService.changesSince(userId).channelMappings).toEqual([
      {
        streamId: '101',
        sourceId: 'src-1a2b3c4d',
        channelId: 'HTV1.hr',
        updatedAt: '2026-08-30T10:00:00.000Z'
      }
    ]);
  });

  it('keeps one per stream', () => {
    syncService.applyChanges(userId, {
      channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')]
    });
    syncService.applyChanges(userId, {
      channelMappings: [mapping('101', 'HTV1.HD.hr', '2026-08-30T11:00:00.000Z')]
    });

    const mappings = syncService.changesSince(userId).channelMappings;
    expect(mappings).toHaveLength(1);
    expect(mappings[0].channelId).toBe('HTV1.HD.hr');
  });

  it('does not let a later push of an older choice undo a newer one', () => {
    syncService.applyChanges(userId, {
      channelMappings: [mapping('101', 'HTV1.HD.hr', '2026-08-30T12:00:00.000Z')]
    });
    const late = syncService.applyChanges(userId, {
      channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')]
    });

    expect(late).toEqual({ applied: 0, superseded: 1 });
    expect(syncService.changesSince(userId).channelMappings[0].channelId).toBe('HTV1.HD.hr');
  });

  it('makes unmapping stick', () => {
    syncService.applyChanges(userId, {
      channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')]
    });
    syncService.applyChanges(userId, {
      deletions: [{ kind: 'channelMapping', key: '101', deletedAt: '2026-08-30T11:00:00.000Z' }]
    });
    syncService.applyChanges(userId, {
      channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:30:00.000Z')]
    });

    expect(syncService.changesSince(userId).channelMappings).toEqual([]);
  });

  it('refuses one missing a stream, a guide or a channel', () => {
    const result = syncService.applyChanges(userId, {
      channelMappings: [
        { streamId: '', sourceId: 'src-1', channelId: 'a', updatedAt: '2026-08-30T10:00:00.000Z' },
        { streamId: '1', sourceId: '', channelId: 'a', updatedAt: '2026-08-30T10:00:00.000Z' },
        { streamId: '1', sourceId: 'src-1', channelId: '', updatedAt: '2026-08-30T10:00:00.000Z' }
      ]
    });

    // Counted rather than thrown: one bad entry should not cost a device the
    // rest of its batch.
    expect(result).toEqual({ applied: 0, superseded: 3 });
  });
});

describe('both kinds together', () => {
  it('appear in a first pull, for a device that has never synced', () => {
    syncService.applyChanges(userId, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z')],
      channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')]
    });

    const changes = syncService.changesSince(userId);
    expect(changes.guideSources).toHaveLength(1);
    expect(changes.channelMappings).toHaveLength(1);
  });

  it('are not shown to another account', async () => {
    const other = (await accountsService.register('luigi', PASSWORD)).id;

    syncService.applyChanges(userId, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z')],
      channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')]
    });

    const theirs = syncService.changesSince(other);
    expect(theirs.guideSources).toEqual([]);
    expect(theirs.channelMappings).toEqual([]);
  });

  it('stop being sent once a device has caught up', () => {
    syncService.applyChanges(userId, {
      guideSources: [source('src-1a2b3c4d', '2026-08-30T10:00:00.000Z')],
      channelMappings: [mapping('101', 'HTV1.hr', '2026-08-30T10:00:00.000Z')]
    });

    const first = syncService.changesSince(userId);
    const second = syncService.changesSince(userId, first.serverTime);

    expect(second.guideSources).toEqual([]);
    expect(second.channelMappings).toEqual([]);
  });
});
