import { AFTER_END_MS, LONGEST_MS, UNKNOWN_LENGTH_MS, clashesWith, connectionsAllowedFrom, readVolumes, mayOpenStream, newRecordingId, readBookings, readRecordings, recordUntil } from './recording';

const NOW = Date.UTC(2026, 10, 10, 20, 15);

describe('recording what is on now', () => {
  it('records to the end of the programme and a little after', () => {
    expect(recordUntil(NOW + 45 * 60_000, NOW)).toBe(NOW + 45 * 60_000 + AFTER_END_MS);
  });

  it('records an hour when the guide does not say, or says something already past', () => {
    expect(recordUntil(null, NOW)).toBe(NOW + UNKNOWN_LENGTH_MS);
    expect(recordUntil(NOW - 1, NOW)).toBe(NOW + UNKNOWN_LENGTH_MS);
  });

  it('never records longer than six hours, whatever the guide says', () => {
    expect(recordUntil(NOW + 20 * 60 * 60_000, NOW)).toBe(NOW + LONGEST_MS);
  });

  it('makes ids the recorder takes', () => {
    expect(newRecordingId(NOW, () => 0.5)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("a subscription's allowance", () => {
  it('reads max_connections, and takes one when it says nothing sensible', () => {
    expect(connectionsAllowedFrom({ max_connections: '2' })).toBe(2);
    expect(connectionsAllowedFrom({ max_connections: '0' })).toBe(1);
    expect(connectionsAllowedFrom(null)).toBe(1);
  });
});

describe('the connection a recording holds', () => {
  it('lets nothing else open on a one-connection subscription while it records', () => {
    expect(mayOpenStream(0, 1)).toBe(true);
    expect(mayOpenStream(1, 1)).toBe(false);
  });

  it('lets one more open where the provider allows two', () => {
    expect(mayOpenStream(1, 2)).toBe(true);
    expect(mayOpenStream(2, 2)).toBe(false);
  });
});

describe("the recorder's list", () => {
  it('keeps what is well formed, newest first', () => {
    const listed = readRecordings([
      { id: 'a1', title: 'News', channel: 'HRT 1', startedAt: 1, endsAt: 2, state: 'done', bytes: 10, path: 'file:///r/a1.ts' },
      { id: 'b2', title: 'Match', channel: 'Sport', startedAt: 5, endsAt: 9, state: 'recording', bytes: 3, path: 'file:///r/b2.ts' },
      { id: '../x', path: 'file:///r/x.ts' },
      { id: 'c3', path: 'http://elsewhere/c3.ts' },
      null
    ]);

    expect(listed.map(one => one.id)).toEqual(['b2', 'a1']);
    expect(listed[0].state).toBe('recording');
  });
});

describe('booking a recording', () => {
  const at = (h: number) => NOW + h * 60 * 60_000;
  const news = { title: 'News', startMs: at(1), endsAt: at(2) };

  it('refuses one that overlaps another on a one-connection subscription, naming it', () => {
    expect(clashesWith([news], { title: 'Match', startMs: at(1.5), endsAt: at(3) }, 1)).toEqual([news]);
  });

  it('takes one that only touches another end to start', () => {
    expect(clashesWith([news], { title: 'Film', startMs: at(2), endsAt: at(4) }, 1)).toEqual([]);
  });

  it('takes two at once where the provider allows two', () => {
    expect(clashesWith([news], { title: 'Match', startMs: at(1.5), endsAt: at(3) }, 2)).toEqual([]);
  });

  it("reads the recorder's bookings, soonest first", () => {
    const listed = readBookings([
      { id: 'b2', title: 'Late', channel: 'C', channelId: '2', startMs: 50, endsAt: 60 },
      { id: 'b1', title: 'Early', channel: 'C', channelId: '1', startMs: 10, endsAt: 20 },
      { id: 'bad', startMs: 5, endsAt: 1 }
    ]);
    expect(listed.map(one => one.id)).toEqual(['b1', 'b2']);
  });
});

describe('the drives recordings can go to', () => {
  it('are read as the recorder lists them, leaving out what has no id', () => {
    expect(
      readVolumes([
        { id: '/storage/emulated/0/Android/data/app.tvinto/files/Recordings', label: 'Internal shared storage', removable: false, freeBytes: 5e9, totalBytes: 8e9, chosen: false },
        { id: '/storage/1A2B-3C4D/Android/data/app.tvinto/files/Recordings', label: 'USB drive', removable: true, freeBytes: '6e10', totalBytes: 6.4e10, chosen: true },
        { label: 'nothing' }
      ])
    ).toEqual([
      expect.objectContaining({ label: 'Internal shared storage', removable: false, chosen: false }),
      expect.objectContaining({ label: 'USB drive', removable: true, freeBytes: 6e10, chosen: true })
    ]);
    expect(readVolumes(null)).toEqual([]);
  });
});
