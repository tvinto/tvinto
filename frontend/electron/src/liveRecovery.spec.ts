import { LiveRecovery, REOPEN_DELAYS_MS, STEADY_MS } from './liveRecovery';

describe('a live channel that mpv ends by itself', () => {
  const clock = () => {
    let now = 1_000_000;
    return { now: () => now, pass: (ms: number) => (now += ms) };
  };

  it('is opened again a few times, waiting longer each time, then given up', () => {
    const time = clock();
    const recovery = new LiveRecovery(time.now);
    recovery.playing();

    const answers = REOPEN_DELAYS_MS.map(() => {
      time.pass(2_000);
      const answer = recovery.ended();
      recovery.playing();
      return answer;
    });

    expect(answers).toEqual(REOPEN_DELAYS_MS.map((delayMs, at) => ({ kind: 'reopen', delayMs, attempt: at + 1 })));
    expect(recovery.ended()).toEqual({ kind: 'giveUp', attempts: REOPEN_DELAYS_MS.length });
  });

  it('starts counting again once the channel has played steadily', () => {
    const time = clock();
    const recovery = new LiveRecovery(time.now);
    recovery.playing();
    REOPEN_DELAYS_MS.forEach(() => {
      recovery.ended();
      recovery.playing();
    });

    time.pass(STEADY_MS);

    expect(recovery.ended()).toEqual({ kind: 'reopen', delayMs: REOPEN_DELAYS_MS[0], attempt: 1 });
  });

  it('does not count a reopen that never showed a picture as steady', () => {
    const time = clock();
    const recovery = new LiveRecovery(time.now);
    recovery.playing();
    REOPEN_DELAYS_MS.forEach(() => {
      recovery.ended();
      time.pass(STEADY_MS);
    });

    expect(recovery.ended().kind).toBe('giveUp');
  });

  it('tries again from the start when the viewer asks', () => {
    const recovery = new LiveRecovery();
    recovery.playing();
    REOPEN_DELAYS_MS.forEach(() => recovery.ended());
    recovery.reset();

    expect(recovery.ended()).toEqual({ kind: 'reopen', delayMs: REOPEN_DELAYS_MS[0], attempt: 1 });
  });

  it('knows whether the channel ever showed a picture, which a new channel forgets', () => {
    const recovery = new LiveRecovery();
    expect(recovery.played).toBe(false);
    recovery.playing();
    expect(recovery.played).toBe(true);
    recovery.forget();
    expect(recovery.played).toBe(false);
  });
});
