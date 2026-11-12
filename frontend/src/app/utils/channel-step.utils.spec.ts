import { channelAfter, isChannelStep } from './channel-step.utils';

const LIST = ['hrt1', 'hrt2', 'hrt3', 'rtl1'];

describe('channelAfter', () => {
  it('moves one along the list either way', () => {
    expect(channelAfter(LIST, 'hrt2', 'next', null)).toBe('hrt3');
    expect(channelAfter(LIST, 'hrt2', 'previous', null)).toBe('hrt1');
  });

  // As a television's channel keys do: holding Channel Up comes round again.
  it('wraps round both ends', () => {
    expect(channelAfter(LIST, 'rtl1', 'next', null)).toBe('hrt1');
    expect(channelAfter(LIST, 'hrt1', 'previous', null)).toBe('rtl1');
  });

  it('goes back to the channel watched before, in the list or not', () => {
    expect(channelAfter(LIST, 'hrt3', 'last', 'hrt1')).toBe('hrt1');
    expect(channelAfter(LIST, 'hrt3', 'last', 'arena1')).toBe('arena1');
  });

  it('has nowhere to go back to without a previous channel', () => {
    expect(channelAfter(LIST, 'hrt3', 'last', null)).toBeNull();
    expect(channelAfter(LIST, 'hrt3', 'last', 'hrt3')).toBeNull();
  });

  it('starts from the end the key points at when the channel has left the list', () => {
    expect(channelAfter(LIST, 'gone', 'next', null)).toBe('hrt1');
    expect(channelAfter(LIST, 'gone', 'previous', null)).toBe('rtl1');
  });

  it('does nothing in a list of one or none', () => {
    expect(channelAfter(['hrt1'], 'hrt1', 'next', null)).toBeNull();
    expect(channelAfter([], 'hrt1', 'next', null)).toBeNull();
  });
});

describe('isChannelStep', () => {
  it('accepts only the three steps', () => {
    expect(isChannelStep('next')).toBe(true);
    expect(isChannelStep('last')).toBe(true);
    expect(isChannelStep(null)).toBe(false);
    expect(isChannelStep('up')).toBe(false);
  });
});
