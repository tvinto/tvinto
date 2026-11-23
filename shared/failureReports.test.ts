import { FAILURE_WINDOW_MS, FailureGroups, failureCode, streamContainer, streamFailure, streamKind } from './failureReports';

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
    expect(groups.note(stream('2'), FAILURE_WINDOW_MS + 5)).toEqual({ ...stream('2'), count: 3 });
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
      http: null
    });
    expect(streamFailure('ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 404)')).toEqual({ code: 'ERROR_CODE_IO_BAD_HTTP_STATUS', codec: null, http: 404 });
    expect(streamFailure('mpv exited with code 2')).toEqual({ code: 'mpv exited with code 2', codec: null, http: null });
  });
});
