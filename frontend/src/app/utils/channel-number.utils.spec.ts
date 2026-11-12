import { bestNumberMatch, numberRange } from './channel-number.utils';

const CHANNELS = [
  { itemId: 'as1', number: '101' },
  { itemId: 'sk1', number: '121' },
  { itemId: 'sk2', number: '12' },
  { itemId: 'hrt', number: '2' },
  { itemId: 'none', number: '' },
  { itemId: 'far', number: '486' }
];

describe('bestNumberMatch', () => {
  it('takes the channel with exactly that number', () => {
    expect(bestNumberMatch(CHANNELS, '12')?.itemId).toBe('sk2');
    expect(bestNumberMatch(CHANNELS, '2')?.itemId).toBe('hrt');
  });

  it('reads leading zeros as the number they spell', () => {
    expect(bestNumberMatch(CHANNELS, '002')?.itemId).toBe('hrt');
  });

  it('otherwise takes the lowest number that starts with the digits so far', () => {
    expect(bestNumberMatch(CHANNELS, '10')?.itemId).toBe('as1');
    expect(bestNumberMatch(CHANNELS, '1')?.itemId).toBe('sk2');
    expect(bestNumberMatch(CHANNELS, '48')?.itemId).toBe('far');
  });

  it('finds nothing for a number no channel has or begins with', () => {
    expect(bestNumberMatch(CHANNELS, '999')).toBeNull();
    expect(bestNumberMatch(CHANNELS, '')).toBeNull();
  });
});

describe('numberRange', () => {
  it('spans the lowest and highest numbers, ignoring channels without one', () => {
    expect(numberRange(CHANNELS)).toBe('2 – 486');
  });

  it('is one number for one channel and empty for none', () => {
    expect(numberRange([{ itemId: 'a', number: '7' }])).toBe('7');
    expect(numberRange([{ itemId: 'a', number: '' }])).toBe('');
  });
});
