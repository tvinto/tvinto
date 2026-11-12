import {
  channelDisplay,
  channelMonogram,
  clockTime,
  guideDateLabel,
  minutesLeft,
  percentThrough,
  withoutTags
} from './channel-display.utils';

describe('channelDisplay', () => {
  it('drops the country tag and moves the superscript tags aside', () => {
    expect(channelDisplay('HR| ARENA SPORT 1 ⱽᴵᴾ ᴿᴬᵂ')).toEqual({
      title: 'ARENA SPORT 1',
      tags: 'ⱽᴵᴾ ᴿᴬᵂ'
    });
  });

  it('keeps a name with neither untouched', () => {
    expect(channelDisplay('Eurosport 1 Hrvatska')).toEqual({ title: 'Eurosport 1 Hrvatska', tags: '' });
  });

  it('keeps the separator rows providers put between groups readable', () => {
    expect(channelDisplay('##### CROATIA ⱽᴵᴾ ᴿᴬᵂ #####').title).toBe('##### CROATIA #####');
  });

  it('keeps Croatian letters, which are not superscripts', () => {
    expect(channelDisplay('HR| DOMA TV ŠPORT Č').title).toBe('DOMA TV ŠPORT Č');
  });

  it('falls back to the raw name rather than drawing nothing', () => {
    expect(channelDisplay('ᴿᴬᵂ').title).toBe('ᴿᴬᵂ');
    expect(channelDisplay(null)).toEqual({ title: '', tags: '' });
  });
});

describe('withoutTags', () => {
  it('keeps a category its country and drops its packaging', () => {
    expect(withoutTags('HR| CROATIA ⱽᴵᴾ ᴿᴬᵂ')).toBe('HR| CROATIA');
  });
});

describe('channelMonogram', () => {
  it('takes initials and the channel number, as the boards draw them', () => {
    expect(channelMonogram('Arena Sport 1')).toBe('AS1');
    expect(channelMonogram('Sportklub 2 HD')).toBe('S2');
    expect(channelMonogram('Eurosport')).toBe('EU');
    expect(channelMonogram('HRT 1')).toBe('H1');
  });

  it('never ends a monogram in the quality tag', () => {
    expect(channelMonogram('Nova TV HD')).toBe('NT');
  });

  it('is at most three characters', () => {
    expect(channelMonogram('RTL Croatia World 123').length).toBeLessThanOrEqual(3);
  });

  it('has something to show for a name with no letters', () => {
    expect(channelMonogram('24/7')).toBe('24');
    expect(channelMonogram('')).toBe('?');
  });

  it('keeps the channel number whole', () => {
    expect(channelMonogram('Channel number 10 of four hundred')).toBe('C10');
    expect(channelMonogram('Channel number 1 of four hundred')).toBe('CN1');
    expect(channelMonogram('RTL Croatia World 123')).toBe('123');
    expect(channelMonogram('Super Channel 1234567890')).toBe('SC');
  });

  it('draws the first emoji of a name made only of emoji', () => {
    expect(channelMonogram('📺🔥⚽')).toBe('📺');
    expect(channelMonogram('👨‍👩‍👧🎬')).toBe('👨‍👩‍👧');
  });
});

describe('guide times', () => {
  const at = (h: number, m: number) => new Date(2026, 8, 8, h, m).getTime();

  it('writes a 24-hour clock whatever the locale prefers', () => {
    expect(clockTime(at(18, 30))).toBe('18:30');
    expect(clockTime(at(9, 5))).toBe('09:05');
  });

  it('writes the date the way the time header does', () => {
    expect(guideDateLabel(at(20, 0))).toBe('TUE 8 SEP');
  });

  it('counts minutes left, and nothing once a programme is over', () => {
    expect(minutesLeft(at(22, 45), at(21, 37))).toBe('68 min left');
    expect(minutesLeft(at(21, 0), at(21, 37))).toBeNull();
  });

  it('says how far through a programme is', () => {
    expect(percentThrough(at(20, 0), at(22, 0), at(21, 0))).toBe(50);
    expect(percentThrough(at(20, 0), at(22, 0), at(23, 0))).toBe(100);
    expect(percentThrough(Number.NaN, at(22, 0), at(21, 0))).toBe(0);
  });
});
