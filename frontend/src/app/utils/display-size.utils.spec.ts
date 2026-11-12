import { DISPLAY_SIZES, displaySizeFrom } from './display-size.utils';

describe('displaySizeFrom', () => {
  it('reads each stored size back', () => {
    for (const option of DISPLAY_SIZES) {
      expect(displaySizeFrom(option.id)).toBe(option);
    }
  });

  it('starts at standard when nothing was chosen', () => {
    expect(displaySizeFrom(null).factor).toBe(1);
  });

  it('falls back to standard for a value it does not know', () => {
    // A size from a later build, or storage somebody edited: never a blank or giant screen.
    expect(displaySizeFrom('enormous').id).toBe('standard');
  });

  it('offers sizes either side of standard, in order', () => {
    const factors = DISPLAY_SIZES.map(option => option.factor);
    expect(factors).toEqual([...factors].sort((a, b) => a - b));
    expect(factors.some(factor => factor < 1)).toBe(true);
    expect(factors.some(factor => factor > 1)).toBe(true);
  });
});
