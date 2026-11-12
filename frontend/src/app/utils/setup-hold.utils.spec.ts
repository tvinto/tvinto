import { HeldRequest, isHeldWrite, readHeldRequests, withHeld } from './setup-hold.utils';

const added = (id: string, active = false): HeldRequest => ({
  method: 'POST',
  path: '/accounts/providers',
  body: { id, payload: `sealed-${id}`, active }
});

describe('what a member setup keeps back', () => {
  it('is a subscription added, replaced or removed, and the OpenSubtitles login', () => {
    expect(isHeldWrite('POST', '/accounts/providers')).toBe(true);
    expect(isHeldWrite('DELETE', '/accounts/providers/abc')).toBe(true);
    expect(isHeldWrite('POST', '/subtitles/account')).toBe(true);
    expect(isHeldWrite('DELETE', '/subtitles/account')).toBe(true);
  });

  it('is not the sync feed, which is held where it is queued, nor any read', () => {
    expect(isHeldWrite('POST', '/devices/changes')).toBe(false);
    expect(isHeldWrite('GET', '/accounts/providers')).toBe(false);
    expect(isHeldWrite('DELETE', '/accounts/providers')).toBe(false);
  });
});

describe('a read during a member setup', () => {
  const server = { success: true, data: [{ id: 'old', payload: 'sealed-old', active: true }] };

  it('shows a subscription added, newest first, as the active one when it was made so', () => {
    const shown = withHeld('/accounts/providers', server, [added('new', true)]) as typeof server;
    expect(shown.data.map(row => [row.id, row.active])).toEqual([
      ['new', true],
      ['old', false]
    ]);
  });

  it('leaves out a subscription removed', () => {
    const removed: HeldRequest = { method: 'DELETE', path: '/accounts/providers/old', body: null };
    expect((withHeld('/accounts/providers', server, [removed]) as typeof server).data).toEqual([]);
  });

  it('answers "which is active" with the one made active while held', () => {
    expect(withHeld('/accounts/providers/active', { success: true, data: null }, [added('new', true)])).toEqual({
      success: true,
      data: { id: 'new', payload: 'sealed-new', active: true }
    });
  });

  it('shows the OpenSubtitles login as it was last set, or taken away', () => {
    const linked: HeldRequest = { method: 'POST', path: '/subtitles/account', body: { payload: 'sealed-login' } };
    const unlinked: HeldRequest = { method: 'DELETE', path: '/subtitles/account', body: null };
    expect((withHeld('/subtitles/account', { data: null }, [linked]) as { data: { payload: string } }).data.payload).toBe('sealed-login');
    expect(withHeld('/subtitles/account', { data: { payload: 'x' } }, [linked, unlinked])).toEqual({ data: null });
  });

  it('is the server answer as it is when nothing held bears on it', () => {
    expect(withHeld('/accounts/providers', server, [])).toEqual(server);
    expect(withHeld('/subtitles/account', { data: null }, [added('new')])).toEqual({ data: null });
  });
});

describe('the held requests, read back', () => {
  it('keeps only what a setup holds, and survives damage', () => {
    expect(readHeldRequests(JSON.stringify([added('a'), { method: 'GET', path: '/x' }]))).toHaveLength(1);
    expect(readHeldRequests('{nope')).toEqual([]);
  });
});
