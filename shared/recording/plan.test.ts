import {
  PlannedRecording,
  RecordingRule,
  episodeId,
  episodesToBook,
  readRules,
  ruleKey,
  ruleOf,
  writeRule,
  RECORDING_DEFAULTS,
  bookingKey,
  expiredRecordings,
  readPlanned,
  readRecorders,
  readRecordingSettings,
  reconcile,
  recorderKey,
  recorderNamed,
  recordingWindow,
  writePlanned,
  writeRecorder,
  writeRecordingSettings
} from './plan';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 20, 0);

const planned = (over: Partial<PlannedRecording> = {}): PlannedRecording => ({
  id: 'b1',
  device: 'tv',
  channelId: '7',
  channel: 'HRT 1',
  title: 'Dnevnik',
  startMs: NOW + HOUR,
  stopMs: NOW + 2 * HOUR,
  ...over
});

describe('bookings kept for the account', () => {
  it('travel one key each, and are read back soonest first', () => {
    const later = planned({ id: 'b2', startMs: NOW + 3 * HOUR, stopMs: NOW + 4 * HOUR });
    const settings = {
      [bookingKey('b2')]: writePlanned(later),
      [bookingKey('b1')]: writePlanned(planned()),
      theme: 'dark'
    };
    expect(readPlanned(settings).map(one => one.id)).toEqual(['b1', 'b2']);
  });

  it('leave out what nobody could act on', () => {
    expect(
      readPlanned({
        [bookingKey('b1')]: '{',
        [bookingKey('b2')]: writePlanned(planned({ id: 'b2', device: '' })),
        [bookingKey('b3')]: writePlanned(planned({ id: 'other' })),
        [bookingKey('b4')]: writePlanned(planned({ id: 'b4', stopMs: NOW }))
      })
    ).toEqual([]);
  });

  it('carry no address', () => {
    const written = writePlanned({ ...planned(), url: 'http://p/live/u/secret/7.ts' } as PlannedRecording);
    expect(written).not.toContain('secret');
  });
});

describe('the devices that record', () => {
  const settings = {
    [recorderKey('tv')]: writeRecorder({ key: 'tv', name: 'Living room', kind: 'tv', seenAt: NOW }),
    [recorderKey('pc')]: writeRecorder({ key: 'pc', name: 'Desktop', kind: 'desktop', seenAt: NOW - HOUR })
  };

  it('are listed most recently heard from first', () => {
    expect(readRecorders(settings).map(one => one.key)).toEqual(['tv', 'pc']);
  });

  it('are found by key or by name, ignoring case', () => {
    const recorders = readRecorders(settings);
    expect(recorderNamed(recorders, 'living ROOM')?.key).toBe('tv');
    expect(recorderNamed(recorders, 'pc')?.key).toBe('pc');
    expect(recorderNamed(recorders, 'kitchen')).toBeNull();
  });
});

describe('recording settings', () => {
  it('default to a minute before and two after, kept until deleted', () => {
    expect(readRecordingSettings(null)).toEqual(RECORDING_DEFAULTS);
  });

  it('keep to sensible numbers', () => {
    expect(readRecordingSettings(JSON.stringify({ beforeMin: -3, afterMin: 500, keepDays: 0 }))).toEqual({ beforeMin: 0, afterMin: 60, keepDays: null });
    expect(readRecordingSettings(writeRecordingSettings({ beforeMin: 5, afterMin: 10, keepDays: 30 }))).toEqual({ beforeMin: 5, afterMin: 10, keepDays: 30 });
  });

  it('widen the window a recording runs for', () => {
    expect(recordingWindow(planned(), { beforeMin: 5, afterMin: 10, keepDays: null })).toEqual({ startMs: NOW + HOUR - 5 * 60_000, endsAt: NOW + 2 * HOUR + 10 * 60_000 });
  });
});

describe('what a recording device does with the bookings', () => {
  it('books what is for it and not booked yet, and leaves the others', () => {
    const result = reconcile([planned(), planned({ id: 'b2', device: 'phone' })], 'tv', [], [], NOW, RECORDING_DEFAULTS);
    expect(result).toEqual({ book: [planned()], cancel: [], forget: [] });
  });

  it('cancels its own booking once the account no longer has it', () => {
    expect(reconcile([], 'tv', [{ id: 'b1' }], [], NOW, RECORDING_DEFAULTS).cancel).toEqual(['b1']);
  });

  it('forgets a booking once it has recorded it, rather than booking it again', () => {
    expect(reconcile([planned()], 'tv', [], [{ id: 'b1' }], NOW + HOUR, RECORDING_DEFAULTS)).toEqual({ book: [], cancel: [], forget: ['b1'] });
  });

  it("clears away another device's booking only long after it is over", () => {
    const over = planned({ device: 'phone', startMs: NOW - 3 * HOUR, stopMs: NOW - 2 * HOUR });
    expect(reconcile([over], 'tv', [], [], NOW, RECORDING_DEFAULTS).forget).toEqual([]);
    expect(reconcile([over], 'tv', [], [], NOW + 30 * HOUR, RECORDING_DEFAULTS).forget).toEqual(['b1']);
  });
});

describe('recordings past keeping', () => {
  const DAY = 24 * HOUR;
  const made = (id: string, daysAgo: number, state = 'done') => ({ id, state, startedAt: NOW - daysAgo * DAY });

  it('are those made longer ago than the days kept, never one still recording', () => {
    const all = [made('new', 2), made('old', 10), made('running', 10, 'recording'), made('broken', 10, 'failed')];
    expect(expiredRecordings(all, 7, NOW).map(one => one.id)).toEqual(['old', 'broken']);
  });

  it('are none while recordings are kept until deleted', () => {
    expect(expiredRecordings([made('old', 400)], null, NOW)).toEqual([]);
  });
});

describe('recording every episode', () => {
  const rule: RecordingRule = { id: 'rule1', device: 'tv', channelId: '7', channel: 'HRT 1', guideId: 'HRT1.hr', title: 'Dnevnik', skip: [] };
  const airing = (title: string, hoursAhead: number) => ({ title, start: NOW + hoursAhead * HOUR, stop: NOW + (hoursAhead + 0.5) * HOUR });

  it('books each airing still to come of the same title, whatever its case and spacing', () => {
    const found = episodesToBook(rule, [airing('Dnevnik', -1), airing(' DNEVNIK  ', 2), airing('Vijesti', 3), airing('Dnevnik', 26)], [], NOW);
    expect(found.map(one => one.startMs)).toEqual([NOW + 2 * HOUR, NOW + 26 * HOUR]);
    expect(found[0]).toEqual(expect.objectContaining({ id: episodeId('rule1', NOW + 2 * HOUR), device: 'tv', channelId: '7', title: 'DNEVNIK' }));
    expect(ruleOf(found[0].id)).toBe('rule1');
  });

  it('does not book again what is booked already, or what was cancelled one by one', () => {
    const booked = { id: episodeId('rule1', NOW + 2 * HOUR) };
    const skipped = { ...rule, skip: [episodeId('rule1', NOW + 26 * HOUR)] };
    expect(episodesToBook(skipped, [airing('Dnevnik', 2), airing('Dnevnik', 26)], [booked], NOW)).toEqual([]);
  });

  it('travels as one key per rule, and reads back only what is well formed', () => {
    const settings = { [ruleKey('rule1')]: writeRule(rule), [ruleKey('bad_id')]: writeRule({ ...rule, id: 'bad_id' }) };
    expect(readRules(settings)).toEqual([rule]);
    expect(ruleOf('rmwb3ryo8cdfk')).toBeNull();
  });
});
