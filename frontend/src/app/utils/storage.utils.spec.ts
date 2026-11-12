import { BANNER_FREE_BYTES, bannerDue, elapsed, finishedSince, freed, size } from './storage.utils';
import { setCurrentLanguage } from './i18n';

const MB = 1024 * 1024;

describe('storage', () => {
  afterEach(() => setCurrentLanguage('en'));

  it('says sizes in MB, and GB from a thousand MB', () => {
    expect(size(640 * MB)).toBe('640 MB');
    expect(size(1.2 * 1024 * MB)).toBe('1.2 GB');
    setCurrentLanguage('hr');
    expect(size(1.2 * 1024 * MB)).toBe('1,2 GB');
  });

  it('counts seconds, then minutes', () => {
    expect(elapsed(42)).toBe('42 s');
    expect(elapsed(435)).toBe('7:15');
  });

  it('asks with a banner only past the line, and not while put off', () => {
    expect(bannerDue(BANNER_FREE_BYTES - 1, 0, 10)).toBe(false);
    expect(bannerDue(BANNER_FREE_BYTES, 0, 10)).toBe(true);
    expect(bannerDue(BANNER_FREE_BYTES, 11, 10)).toBe(false);
  });

  it('takes only a finished clean started after the press as the answer', () => {
    expect(finishedSince({ state: 'done', startedAt: 100 }, 5000)).toBe(false);
    expect(finishedSince({ state: 'running', startedAt: 6000 }, 5000)).toBe(false);
    expect(finishedSince({ state: 'stopped', startedAt: 6000 }, 5000)).toBe(true);
    expect(freed({ beforeBytes: 900 * MB, afterBytes: 100 * MB })).toBe(800 * MB);
  });
});
