import { FAILURE_WINDOW_MS, FailureGroups, failureCode, failureTitle, streamContainer, streamFailure, streamKind } from './failureReports';

const stream = (code = 'ERROR_CODE_IO_BAD_HTTP_STATUS') => ({ kind: 'stream' as const, code, context: { player: 'media3' } });

describe('FailureGroups', () => {
  it('sends the first failure of a kind at once and counts the rest', () => {
    const groups = new FailureGroups();
    expect(groups.note(stream(), 0)).toEqual({ ...stream(), count: 1 });
    for (let i = 1; i <= 200; i++) {
      expect(groups.note(stream(), i * 1000)).toBeNull();
    }
    expect(groups.due(FAILURE_WINDOW_MS - 1)).toEqual([]);
    expect(groups.due(FAILURE_WINDOW_MS)).toEqual([{ ...stream(), count: 200 }]);
    // A new window: the next one goes at once again.
    expect(groups.note(stream(), FAILURE_WINDOW_MS + 1)).toEqual({ ...stream(), count: 1 });
  });

  it('groups each kind on its own', () => {
    const groups = new FailureGroups();
    expect(groups.note(stream(), 0)).not.toBeNull();
    expect(groups.note({ kind: 'sync', code: '503', context: { endpoint: 'pull' } }, 10)).not.toBeNull();
    expect(groups.note(stream(), 20)).toBeNull();
  });

  it('carries a count the timer missed into the next event', () => {
    const groups = new FailureGroups();
    groups.note(stream(), 0);
    groups.note(stream(), 1);
    groups.note(stream(), 2);
    expect(groups.note(stream(), FAILURE_WINDOW_MS + 5)).toEqual({ ...stream(), count: 3 });
  });
});

describe('stream context', () => {
  it('says live, film or episode without the address', () => {
    expect(streamKind('live')).toBe('live');
    expect(streamKind('vod')).toBe('film');
    expect(streamKind('series')).toBe('episode');
    expect(streamKind(null, 'http://panel.test:8080/movie/user/pass/12.mkv')).toBe('film');
    expect(streamKind(null, 'http://127.0.0.1:4000/recording/3.ts')).toBe('recording');
  });

  it('keeps only the container', () => {
    expect(streamContainer('http://panel.test:8080/live/user/pass/12.ts?token=abc')).toBe('ts');
    expect(streamContainer('http://panel.test/play/abc')).toBe('none');
  });

  it('keeps player codes and cuts anything that could name a file', () => {
    expect(failureCode('ERROR_CODE_DECODING_FAILED')).toBe('ERROR_CODE_DECODING_FAILED');
    expect(failureCode('mpv exited with code 2')).toBe('mpv exited with code 2');
    expect(failureCode('could not start mpv: Error: spawn C:\\Users\\Mario\\mpv.exe')).toBe('could');
  });
});

describe('streamFailure', () => {
  it('splits what Media3 and mpv say into code, codec and status', () => {
    expect(streamFailure('no decoder on this device managed hevc 3840x2160 (ERROR_CODE_DECODING_FAILED)')).toEqual({
      code: 'ERROR_CODE_DECODING_FAILED',
      codec: 'hevc',
      http: null,
      waitedSeconds: null
    });
    expect(streamFailure('ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 404)')).toEqual({ code: 'ERROR_CODE_IO_BAD_HTTP_STATUS', codec: null, http: 404, waitedSeconds: null });
    expect(streamFailure('mpv exited with code 2')).toEqual({ code: 'mpv exited with code 2', codec: null, http: null, waitedSeconds: null });
  });
});

describe('failureTitle', () => {
  it('says what failed in plain words, the same every time', () => {
    expect(failureTitle({ kind: 'stream', code: 'mpv exited with code 2', context: { kind: 'live', player: 'tvinto-player' } })).toBe('Stream failed: live, tvinto-player, mpv exit 2');
    expect(failureTitle({ kind: 'stream', code: streamFailure('no picture in 20 s').code, context: { kind: 'live', player: 'media3' } })).toBe('Stream failed: live, media3, no picture');
    expect(failureTitle({ kind: 'sync', code: '503', context: { endpoint: 'changes' } })).toBe('Sync failed: changes, 503');
    expect(failureTitle({ kind: 'guide', code: 'parse', context: {} })).toBe('Guide failed: parse');
    expect(failureTitle({ kind: 'tmdb', code: '0', context: {} })).toBe('TMDB failed: 0');
    expect(failureTitle({ kind: 'opensubtitles', code: '429', context: {} })).toBe('OpenSubtitles failed: 429');
  });

  it('reads how long a channel waited for its picture', () => {
    expect(streamFailure('no picture in 20 s')).toEqual({ code: 'no picture', codec: null, http: null, waitedSeconds: 20 });
  });
});

describe('FailureGroups by title', () => {
  it('sends a different failure of the same kind at once, rather than counting it with the first', () => {
    const groups = new FailureGroups();
    const live = { kind: 'stream' as const, code: 'no picture', context: { kind: 'live', player: 'tvinto-player' } };
    const film = { kind: 'stream' as const, code: 'mpv exited with code 2', context: { kind: 'film', player: 'tvinto-player' } };
    expect(groups.note(live, 0)).toEqual({ ...live, count: 1 });
    expect(groups.note(film, 1000)).toEqual({ ...film, count: 1 });
    expect(groups.note(live, 2000)).toBeNull();
  });
});
