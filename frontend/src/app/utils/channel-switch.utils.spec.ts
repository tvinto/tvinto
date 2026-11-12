import {
  SWITCH_PAUSE_MS,
  SWITCH_RETRY_PAUSE_MS,
  SwitchEvent,
  SwitchState,
  nextSwitch,
  startSwitching
} from './channel-switch.utils';

const LIST = ['hrt1', 'hrt2', 'hrt3', 'rtl'];

/** Runs events in order, returning the last state and every action taken. */
const run = (state: SwitchState, ...events: SwitchEvent[]) => {
  const actions = [];
  for (const event of events) {
    const step = nextSwitch(state, event);
    state = step.state;
    actions.push(step.action);
  }
  return { state, actions };
};

const playing = (current = 'hrt1') => nextSwitch(startSwitching(LIST, current, null), { kind: 'started' }).state;

describe('nextSwitch', () => {
  it('switches to the neighbour after the pause', () => {
    const { state, actions } = run(playing(), { kind: 'requested', step: 'next' });
    expect(actions).toEqual([{ kind: 'switch', to: 'hrt2', waitMs: SWITCH_PAUSE_MS, attempt: 1 }]);
    expect(state).toMatchObject({ current: 'hrt2', started: false, previous: 'hrt1', origin: 'hrt1' });
  });

  it('re-targets when pressed again before the picture arrives, keeping where the run began', () => {
    const { state, actions } = run(
      playing(),
      { kind: 'requested', step: 'next' },
      { kind: 'requested', step: 'next' },
      { kind: 'requested', step: 'next' }
    );
    expect(actions.map(action => (action.kind === 'switch' ? action.to : action.kind))).toEqual(['hrt2', 'hrt3', 'rtl']);
    // hrt2 and hrt3 were skipped past, never watched: not somewhere to go back to.
    expect(state).toMatchObject({ current: 'rtl', previous: 'hrt1', origin: 'hrt1' });
  });

  it('forgets the run once the new channel shows a picture', () => {
    const { state } = run(playing(), { kind: 'requested', step: 'next' }, { kind: 'started' });
    expect(state).toMatchObject({ current: 'hrt2', started: true, origin: null, previous: 'hrt1' });
  });

  it('goes back to the last channel watched', () => {
    const { actions } = run(playing(), { kind: 'requested', step: 'next' }, { kind: 'started' }, { kind: 'requested', step: 'last' });
    expect(actions[2]).toEqual({ kind: 'switch', to: 'hrt1', waitMs: SWITCH_PAUSE_MS, attempt: 1 });
  });

  it('returns to where the run began on Back', () => {
    const { state, actions } = run(
      playing(),
      { kind: 'requested', step: 'next' },
      { kind: 'requested', step: 'next' },
      { kind: 'requested', step: 'cancel' }
    );
    expect(actions[2]).toEqual({ kind: 'switch', to: 'hrt1', waitMs: SWITCH_PAUSE_MS, attempt: 1 });
    expect(state).toMatchObject({ current: 'hrt1', origin: null });
  });

  it('ignores Back when nothing is being switched', () => {
    expect(nextSwitch(playing(), { kind: 'requested', step: 'cancel' }).action).toEqual({ kind: 'none' });
  });

  it('retries a refused stream once, after the longer pause', () => {
    const { state, actions } = run(playing(), { kind: 'requested', step: 'next' }, { kind: 'failed', errorCode: 'ERROR_CODE_IO_BAD_HTTP_STATUS' });
    expect(actions[1]).toEqual({ kind: 'switch', to: 'hrt2', waitMs: SWITCH_RETRY_PAUSE_MS, attempt: 2 });
    expect(state.attempt).toBe(2);
  });

  it('gives up after the second refusal and names where Back goes', () => {
    const { state, actions } = run(
      playing(),
      { kind: 'requested', step: 'next' },
      { kind: 'failed', errorCode: 'ERROR_CODE_IO_BAD_HTTP_STATUS' },
      { kind: 'failed', errorCode: 'ERROR_CODE_IO_BAD_HTTP_STATUS' }
    );
    expect(actions[2]).toEqual({ kind: 'giveUp', backTo: 'hrt1' });
    expect(state.gaveUp).toBe(true);

    // And Back from there returns to it.
    expect(nextSwitch(state, { kind: 'requested', step: 'cancel' }).action).toEqual({
      kind: 'switch',
      to: 'hrt1',
      waitMs: SWITCH_PAUSE_MS,
      attempt: 1
    });
  });

  it('a new key after giving up starts a fresh first attempt', () => {
    const { actions } = run(
      playing(),
      { kind: 'requested', step: 'next' },
      { kind: 'failed', errorCode: 'X' },
      { kind: 'failed', errorCode: 'X' },
      { kind: 'requested', step: 'next' }
    );
    expect(actions[3]).toEqual({ kind: 'switch', to: 'hrt3', waitMs: SWITCH_PAUSE_MS, attempt: 1 });
  });

  it('closes the player for a stream this device cannot decode, so VLC can try it', () => {
    const { actions } = run(playing(), { kind: 'requested', step: 'next' }, { kind: 'failed', errorCode: 'ERROR_CODE_DECODING_FAILED' });
    expect(actions[1]).toEqual({ kind: 'close' });
  });

  it('closes the player when a channel that was playing fails', () => {
    expect(nextSwitch(playing(), { kind: 'failed', errorCode: 'ERROR_CODE_IO_NETWORK_CONNECTION_FAILED' }).action).toEqual({
      kind: 'close'
    });
  });

  it('ignores a second Back for the same cancel', () => {
    const { actions } = run(
      playing(),
      { kind: 'requested', step: 'next' },
      { kind: 'requested', step: 'cancel' },
      { kind: 'requested', step: 'cancel' }
    );
    expect(actions[2]).toEqual({ kind: 'none' });
  });

  it('closes on Back after giving up with nowhere to return to', () => {
    const gaveUp = { ...startSwitching(LIST, 'hrt1', null), gaveUp: true };
    expect(nextSwitch(gaveUp, { kind: 'requested', step: 'cancel' }).action).toEqual({ kind: 'close' });
  });

  it('jumps to a channel chosen by number or in the mini guide, as a key press would', () => {
    const { state, actions } = run(playing(), { kind: 'jump', to: 'rtl' });
    expect(actions[0]).toEqual({ kind: 'switch', to: 'rtl', waitMs: SWITCH_PAUSE_MS, attempt: 1 });
    expect(state).toMatchObject({ current: 'rtl', previous: 'hrt1', origin: 'hrt1' });
  });

  it('ignores a jump to the channel already on, or to one not in the list', () => {
    expect(nextSwitch(playing(), { kind: 'jump', to: 'hrt1' }).action).toEqual({ kind: 'none' });
    expect(nextSwitch(playing(), { kind: 'jump', to: 'elsewhere' }).action).toEqual({ kind: 'none' });
  });

  it('does nothing for a list of one', () => {
    const single = nextSwitch(startSwitching(['hrt1'], 'hrt1', null), { kind: 'started' }).state;
    expect(nextSwitch(single, { kind: 'requested', step: 'next' }).action).toEqual({ kind: 'none' });
  });
});
