import { IDLE_MINUTES, decideInstall } from './installWhen';

const idle = IDLE_MINUTES * 60;
const base = { ready: '1.0.15', playing: false, pageBusy: null, idleSeconds: idle };

describe('decideInstall', () => {
  it('installs a waiting update on a machine nobody is using', () => {
    expect(decideInstall(base)).toEqual({ install: true, reason: 'idle' });
  });

  it('has nothing to install when nothing has downloaded', () => {
    expect(decideInstall({ ...base, ready: null })).toEqual({ install: false, reason: 'nothing-ready' });
  });

  // A film is watched without touching anything, so idleness alone would
  // restart the app in the middle of one.
  it('never installs while mpv is playing, however long nobody has touched anything', () => {
    expect(decideInstall({ ...base, playing: true, idleSeconds: 10 * idle })).toEqual({
      install: false,
      reason: 'playing'
    });
  });

  it('waits for whatever the page says it is doing', () => {
    expect(decideInstall({ ...base, pageBusy: 'loading-guide' })).toEqual({
      install: false,
      reason: 'loading-guide'
    });
  });

  it('waits while somebody is using the machine', () => {
    expect(decideInstall({ ...base, idleSeconds: idle - 1 })).toEqual({ install: false, reason: 'in-use' });
  });

  it('treats an unreadable idle time as in use', () => {
    expect(decideInstall({ ...base, idleSeconds: Number.NaN })).toEqual({ install: false, reason: 'in-use' });
  });

  it('takes a shorter idle time when told one', () => {
    expect(decideInstall({ ...base, idleSeconds: 0 }, 0)).toEqual({ install: true, reason: 'idle' });
  });
});
