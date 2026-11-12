import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CacheState, LivePause, MAX_FILE_BYTES, MIN_FREE_BYTES, MpvLink, badgeAss, clockOf, limitReached, stepTo } from './livePause';

describe('stepTo', () => {
  const at = { start: 100, live: 200, newest: 199 };

  it('steps back ten seconds', () => {
    expect(stepTo({ ...at, from: 150, by: -10 })).toEqual({ kind: 'seek', to: 140 });
  });

  it('never goes before where the pause began', () => {
    expect(stepTo({ ...at, from: 104, by: -10 })).toEqual({ kind: 'seek', to: 100 });
  });

  it('steps forward within what was read', () => {
    expect(stepTo({ ...at, from: 150, by: 30 })).toEqual({ kind: 'seek', to: 180 });
  });

  it('is live within five seconds of it', () => {
    expect(stepTo({ ...at, from: 186, by: 10 })).toEqual({ kind: 'live' });
    expect(stepTo({ ...at, from: 184, by: 10 })).toEqual({ kind: 'seek', to: 194 });
  });

  it('goes no further than was read when reading stopped at a limit', () => {
    expect(stepTo({ start: 100, live: 900, newest: 300, from: 295, by: 10 })).toEqual({ kind: 'seek', to: 300 });
  });

  it('steps back from live without knowing what was read', () => {
    expect(stepTo({ start: 100, live: 200, newest: null, from: 190, by: -10 })).toEqual({ kind: 'seek', to: 180 });
  });
});

describe('clockOf', () => {
  it('reads like the Android badge', () => {
    expect(clockOf(0)).toBe('0:00');
    expect(clockOf(83.9)).toBe('1:23');
    expect(clockOf(725)).toBe('12:05');
    expect(clockOf(3723)).toBe('1:02:03');
    expect(clockOf(-4)).toBe('0:00');
  });
});

describe('limitReached', () => {
  const gb = 1024 ** 3;
  it('is nothing under the limits', () => {
    expect(limitReached(gb, 50 * gb)).toBeNull();
    expect(limitReached(null, null)).toBeNull();
  });
  it('stops reading ahead at 4 GB or 500 MB free', () => {
    expect(limitReached(MAX_FILE_BYTES, 50 * gb)).toBe('soft');
    expect(limitReached(gb, MIN_FREE_BYTES - 1)).toBe('soft');
  });
  it('ends the pause well past either', () => {
    expect(limitReached(MAX_FILE_BYTES + gb, 50 * gb)).toBe('hard');
    expect(limitReached(gb, 100 * 1024 ** 2)).toBe('hard');
  });
});

describe('badgeAss', () => {
  it('keeps the words out of ASS override blocks', () => {
    const ass = badgeAss('PAUSED {\\b0} · 1:23', 'Back to live · End', 1280);
    expect(ass).toContain('PAUSED b0 · 1:23');
    expect(ass.split('\n')).toHaveLength(3);
  });

  it('sits in the top right corner', () => {
    expect(badgeAss('3:20 behind live', '', 1280)).toContain('\\pos(1230,41)');
  });
});

describe('LivePause', () => {
  let folder: string;
  let sent: unknown[];
  let named: Record<string, unknown>[];
  let position: { seconds: number; at: number } | null;
  let cache: CacheState | null;
  let pause: LivePause;
  let now: number;

  const mpv: MpvLink = {
    send: command => void sent.push(command),
    sendNamed: command => void named.push(command),
    position: () => position,
    cacheState: () => cache,
    osdSize: () => ({ width: 1920, height: 1080 })
  };
  const message = (...args: string[]) => pause.onEvent({ event: 'client-message', args: ['xtream', ...args] });
  const paused = (value: boolean) => pause.onEvent({ event: 'property-change', name: 'pause', data: value });
  const sets = () => sent.filter((c): c is unknown[] => Array.isArray(c) && c[0] === 'set_property').map(c => `${c[1]}=${c[2]}`);
  const seeks = () => sent.filter((c): c is unknown[] => Array.isArray(c) && c[0] === 'seek').map(c => c[1]);
  const badge = () => String(named[named.length - 1]?.['data'] ?? '');

  beforeEach(() => {
    jest.useFakeTimers();
    now = 1_000_000;
    jest.setSystemTime(now);
    folder = mkdtempSync(join(tmpdir(), 'live-pause-'));
    sent = [];
    named = [];
    position = { seconds: 50, at: now };
    cache = { 'seekable-ranges': [{ start: 30, end: 51 }] };
    pause = new LivePause(mpv, 'http://provider/live/1.ts', { paused: 'PAUSED', behind: '{0} behind live', backToLive: 'Back to live' }, folder, () => 100 * 1024 ** 3);
  });

  afterEach(() => {
    pause.stop();
    jest.useRealTimers();
    rmSync(folder, { recursive: true, force: true });
  });

  const later = (ms: number) => {
    // The fake timers move Date.now() along with them.
    now += ms;
    jest.advanceTimersByTime(ms);
  };

  it('watches the pause property once the pipe is there', () => {
    pause.connected();
    pause.connected();
    expect(sent).toEqual([['observe_property', 4242, 'pause']]);
  });

  it('does nothing on Left and Right while live', () => {
    message('step', '-10');
    expect(sent).toEqual([]);
  });

  it('moves the cache to disk at the pause and counts behind live', () => {
    paused(true);
    expect(pause.active).toBe(true);
    expect(sets()).toEqual(
      expect.arrayContaining(['cache-on-disk=true', 'demuxer-max-bytes=1GiB', 'cache-secs=5400', `demuxer-cache-dir=${folder}`])
    );
    later(83_000);
    expect(badge()).toContain('PAUSED · 1:23');
    expect(badge()).toContain('Back to live · End');
  });

  it('plays on behind live by the pause', () => {
    paused(true);
    later(200_000);
    paused(false);
    position = { seconds: 50, at: now };
    later(5000);
    position = { seconds: 55, at: now };
    later(1000);
    expect(badge()).toContain('3:20 behind live');
  });

  it('steps within the pause, never before its start, and stays paused', () => {
    paused(true);
    later(60_000);
    cache = { 'seekable-ranges': [{ start: 30, end: 110 }] };
    message('step', '10');
    expect(seeks()).toEqual([60]);
    expect(badge()).toContain('PAUSED · 0:50');
    message('step', '-10');
    message('step', '-10');
    expect(seeks()).toEqual([60, 50, 50]);
    expect(sent).not.toContainEqual(['set_property', 'pause', false]);
  });

  it('is back to live when a step forward reaches it, opening the channel again', () => {
    paused(true);
    later(20_000);
    cache = { 'seekable-ranges': [{ start: 30, end: 70 }] };
    message('step', '30');
    expect(pause.active).toBe(false);
    expect(sets()).toEqual(expect.arrayContaining(['cache-on-disk=false', 'demuxer-max-bytes=150MiB', 'pause=false']));
    expect(sent[sent.length - 1]).toEqual(['loadfile', 'http://provider/live/1.ts', 'replace']);
    expect(named[named.length - 1]).toMatchObject({ format: 'none' });
  });

  it('goes back to live on End', () => {
    paused(true);
    message('live');
    expect(sent[sent.length - 1]).toEqual(['loadfile', 'http://provider/live/1.ts', 'replace']);
  });

  it('ends with another channel without opening anything', () => {
    paused(true);
    pause.leave('http://provider/live/2.ts');
    expect(pause.active).toBe(false);
    expect(sent.some(c => Array.isArray(c) && c[0] === 'loadfile')).toBe(false);
    paused(false);
    message('live');
    expect(sent.some(c => Array.isArray(c) && c[0] === 'loadfile')).toBe(false);
  });

  it('refuses a stream mpv cannot seek in', () => {
    cache = { 'seekable-ranges': [] };
    paused(true);
    expect(pause.active).toBe(false);
    expect(sent).toContainEqual(['set_property', 'pause', false]);
  });

  it('goes back to live when what was read runs out', () => {
    paused(true);
    expect(pause.onEvent({ event: 'end-file', reason: 'eof' })).toBe(true);
    expect(sent[sent.length - 1]).toEqual(['loadfile', 'http://provider/live/1.ts', 'replace']);
  });

  it('stops reading ahead at the disk limit', () => {
    paused(true);
    cache = { 'seekable-ranges': [{ start: 30, end: 80 }], 'file-cache-bytes': MAX_FILE_BYTES, 'cache-duration': 2000 };
    later(1000);
    expect(sets()).toContain('cache-secs=2000');
  });

  it('clears what an earlier mpv left in its folder', () => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'mpv-cache-left'), 'x');
    new LivePause(mpv, 'http://provider/live/1.ts', {}, folder).stop();
    expect(existsSync(join(folder, 'mpv-cache-left'))).toBe(false);
  });
});
