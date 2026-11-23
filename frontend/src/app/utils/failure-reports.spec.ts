import { Failure } from '@shared/failureReports';
import { reportFailure, reportingFetch, setFailureSink } from './failure-reports';

describe('failure reports', () => {
  const seen: Failure[] = [];
  beforeEach(() => {
    seen.length = 0;
    setFailureSink(failure => seen.push(failure));
  });
  afterAll(() => setFailureSink(null));

  it('reports a failing TMDB or OpenSubtitles answer by its status only', async () => {
    const answers = [500, 200, 404, 429];
    const fetch = reportingFetch('tmdb', async (_url: string, _init: object) => ({ status: answers.shift() ?? 200 }));
    for (let i = 0; i < 4; i++) {
      await fetch('https://api.themoviedb.org/3/movie/1?api_key=secret', {});
    }
    expect(seen).toEqual([
      { kind: 'tmdb', code: '500', context: {} },
      { kind: 'tmdb', code: '429', context: {} }
    ]);
  });

  it('reports no answer at all as 0, and still throws', async () => {
    const fetch = reportingFetch('opensubtitles', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetch('https://api.opensubtitles.com/api/v1/login', {})).rejects.toThrow('Failed to fetch');
    expect(seen).toEqual([{ kind: 'opensubtitles', code: '0', context: {} }]);
  });

  it('never lets a sink that throws reach the caller', () => {
    setFailureSink(() => {
      throw new Error('broken');
    });
    expect(() => reportFailure('sync', 503, { endpoint: 'pull' })).not.toThrow();
  });
});
