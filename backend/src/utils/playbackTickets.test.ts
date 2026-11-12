import { playbackTickets } from './playbackTickets';

const claim = { type: 'live' as const, streamId: '12345', extension: 'm3u8' };

describe('playbackTickets', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('redeems a ticket back to the stream it was issued for', () => {
    const ticket = playbackTickets.issue('session-token', claim);

    expect(playbackTickets.redeem(ticket)).toEqual({
      sessionToken: 'session-token',
      type: 'live',
      streamId: '12345',
      extension: 'm3u8'
    });
  });

  it('leaks nothing about the session it stands for', () => {
    const ticket = playbackTickets.issue('session-token', claim);

    expect(ticket).toMatch(/^[0-9a-f]{48}$/);
    expect(ticket).not.toContain('session-token');
  });

  it('survives repeated redemption, because players reissue range requests', () => {
    const ticket = playbackTickets.issue('session-token', claim);

    expect(playbackTickets.redeem(ticket)).not.toBeNull();
    expect(playbackTickets.redeem(ticket)).not.toBeNull();
    expect(playbackTickets.redeem(ticket)).not.toBeNull();
  });

  it('returns null for a ticket it never issued', () => {
    expect(playbackTickets.redeem('made-up')).toBeNull();
  });

  it('expires an hour after issue', () => {
    jest.useFakeTimers();
    const ticket = playbackTickets.issue('session-token', claim);

    jest.advanceTimersByTime(59 * 60 * 1000);
    expect(playbackTickets.redeem(ticket)).not.toBeNull();

    jest.advanceTimersByTime(2 * 60 * 1000);
    expect(playbackTickets.redeem(ticket)).toBeNull();
  });

  it('grants exactly one stream, not a session', () => {
    const live = playbackTickets.issue('session-token', claim);
    const vod = playbackTickets.issue('session-token', {
      type: 'vod',
      streamId: '999',
      extension: 'mp4'
    });

    expect(playbackTickets.redeem(live)?.streamId).toBe('12345');
    expect(playbackTickets.redeem(vod)?.streamId).toBe('999');
    expect(live).not.toBe(vod);
  });

  it('sweeps expired tickets out of memory without being asked', async () => {
    // Re-imported under fake timers so the sweep interval it creates at
    // construction is one this test can advance.
    jest.useFakeTimers();
    let store!: typeof playbackTickets;
    await jest.isolateModulesAsync(async () => {
      ({ playbackTickets: store } = await import('./playbackTickets'));
    });

    store.issue('session-token', claim);
    jest.advanceTimersByTime(2 * 60 * 60 * 1000);

    expect((store as unknown as { tickets: Map<string, unknown> }).tickets.size).toBe(0);
  });

  it('carries a claim without an extension', () => {
    const ticket = playbackTickets.issue('session-token', { type: 'series', streamId: '7' });
    expect(playbackTickets.redeem(ticket)?.extension).toBeUndefined();
  });
});
