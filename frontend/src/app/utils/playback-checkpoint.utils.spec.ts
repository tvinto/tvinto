import { PlayingRecord, readPlayingRecord, recoveredProgress } from './playback-checkpoint.utils';

describe('a viewing that never closed', () => {
  const record: PlayingRecord = {
    at: 1_000,
    entries: {
      e1: { type: 'series', itemId: 'e1', seriesId: 's', season: 1, episodeNum: 1, name: 'Severance', episodeTitle: 'One', icon: null, containerExtension: 'mkv' },
      e2: { type: 'series', itemId: 'e2', seriesId: 's', season: 1, episodeNum: 2, name: 'Severance', episodeTitle: 'Two', icon: null, containerExtension: 'mkv' }
    }
  };

  it('is saved as the entry the page wrote down, at the position the player kept', () => {
    expect(recoveredProgress(record, { itemId: 'e2', positionSeconds: 1200, durationSeconds: 3000, at: 5_000 })).toEqual({
      ...record.entries['e2'],
      positionSeconds: 1200,
      durationSeconds: 3000
    });
  });

  it('is not saved when the player kept nothing, or nothing useful', () => {
    expect(recoveredProgress(record, null)).toBeNull();
    expect(recoveredProgress(record, {})).toBeNull();
    expect(recoveredProgress(record, { itemId: 'e1', positionSeconds: 0, durationSeconds: 3000, at: 5_000 })).toBeNull();
  });

  it('is not saved for an item the page did not write down, or from an older play', () => {
    expect(recoveredProgress(record, { itemId: 'film', positionSeconds: 60, durationSeconds: 3000, at: 5_000 })).toBeNull();
    expect(recoveredProgress(record, { itemId: 'e1', positionSeconds: 60, durationSeconds: 3000, at: 500 })).toBeNull();
    expect(recoveredProgress(null, { itemId: 'e1', positionSeconds: 60, durationSeconds: 3000, at: 5_000 })).toBeNull();
  });

  it('reads back only a record it wrote', () => {
    expect(readPlayingRecord(JSON.stringify(record))).toEqual(record);
    expect(readPlayingRecord(null)).toBeNull();
    expect(readPlayingRecord('{"at":"x"}')).toBeNull();
    expect(readPlayingRecord('not json')).toBeNull();
  });
});
