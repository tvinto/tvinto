import { osdBanner, osdGaveUp, osdMeter, osdSwitching } from './mpv-osd.utils';
import { clockTime } from './channel-display.utils';

const at = (hours: number, minutes: number) => new Date(2026, 8, 15, hours, minutes).getTime();
const HRT1 = { number: '101', name: 'HRT 1' };

describe('mpv on-screen display', () => {
  it('draws the meter as ASCII, as the board does', () => {
    expect(osdMeter(49)).toBe('[###########-----------]  49%');
    expect(osdMeter(0)).toBe('[----------------------]  0%');
    expect(osdMeter(100)).toBe('[######################]  100%');
  });

  it('writes the banner as four lines', () => {
    const banner = {
      tags: 'ᴴᴰ ᵛᴵᴾ ᴿᴬᵂ',
      now: { title: 'Dnevnik', startMs: at(19, 0), stopMs: at(19, 45) },
      next: { title: 'Potrošački kod', startMs: at(19, 45), stopMs: at(20, 30) },
      hasGuide: true
    };
    expect(osdBanner(HRT1, banner, at(19, 22)).split('\n')).toEqual([
      '101  HRT 1  ᴴᴰ ᵛᴵᴾ ᴿᴬᵂ',
      `Dnevnik   ${clockTime(at(19, 0))}-${clockTime(at(19, 45))}   23 min left`,
      '[###########-----------]  49%',
      `Next ${clockTime(at(19, 45))}  Potrošački kod`
    ]);
  });

  it('says there is no guide, in the same slot', () => {
    expect(osdBanner(HRT1, { tags: '', now: null, next: null, hasGuide: false }, at(19, 0))).toBe(
      '101  HRT 1\nNo programme guide for this channel'
    );
  });

  it('shows the name alone while the guide has not answered', () => {
    expect(osdBanner({ number: '', name: 'HRT 1' }, null, at(19, 0))).toBe('HRT 1');
  });

  it('puts the switch in the first line, where the channel name was', () => {
    expect(osdSwitching({ number: '112', name: 'RTL LIVING' }, 'HRT 1 · 101', 1).split('\n')[0]).toBe(
      'Changing to 112  RTL LIVING'
    );
    expect(osdSwitching({ number: '112', name: 'RTL LIVING' }, 'HRT 1', 2)).toContain('attempt 2 of 2');
  });

  it('names where Backspace goes after giving up', () => {
    expect(osdGaveUp({ number: '112', name: 'RTL LIVING' }, 'HRT 1')).toBe(
      'Could not start 112  RTL LIVING\nBackspace returns to HRT 1'
    );
  });
});
