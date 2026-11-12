import { channelBanner } from './player-banner.utils';

const at = (hours: number, minutes: number) => Date.UTC(2026, 8, 15, hours, minutes);

const GUIDE = [
  { title: 'Dnevnik', start: at(19, 0), stop: at(19, 45) },
  { title: 'Potrošački kod', start: at(19, 45), stop: at(20, 30) },
  { title: 'Film', start: at(20, 30), stop: at(22, 0) }
];

describe('channelBanner', () => {
  it('names what is on and what follows, in milliseconds', () => {
    expect(channelBanner('HR| HRT 1 ᴴᴰ ⱽᴵᴾ', GUIDE, at(19, 22))).toEqual({
      tags: 'ᴴᴰ ⱽᴵᴾ',
      now: { title: 'Dnevnik', startMs: at(19, 0), stopMs: at(19, 45) },
      next: { title: 'Potrošački kod', startMs: at(19, 45), stopMs: at(20, 30) },
      hasGuide: true
    });
  });

  // The details a second OK shows in the player: what the guide says about
  // the programme on now.
  it('carries what the guide says about the programme, when it says anything', () => {
    const described = [{ ...GUIDE[0], description: '  Vijesti i vrijeme.  ' }, GUIDE[1]];
    const banner = channelBanner('HRT 1', described, at(19, 22));

    expect(banner.now?.description).toBe('Vijesti i vrijeme.');
    expect(banner.next).not.toHaveProperty('description');
  });

  it('reads the guide in seconds as well', () => {
    const inSeconds = GUIDE.map(programme => ({
      title: programme.title,
      start_timestamp: programme.start / 1000,
      stop_timestamp: programme.stop / 1000
    }));
    expect(channelBanner('HRT 1', inSeconds, at(19, 50)).now?.title).toBe('Potrošački kod');
  });

  it('shows only the next programme in a gap, which is not the same as having no guide', () => {
    const gap = [GUIDE[0], GUIDE[2]];
    const banner = channelBanner('HRT 1', gap, at(20, 0));
    expect(banner.now).toBeNull();
    expect(banner.next?.title).toBe('Film');
    expect(banner.hasGuide).toBe(true);
  });

  it('says there is no guide when the channel has none', () => {
    expect(channelBanner('Sportklub 2 HD ⱽᴵᴾ', undefined, at(19, 0))).toEqual({
      tags: 'ⱽᴵᴾ',
      now: null,
      next: null,
      hasGuide: false
    });
  });

  it('gives an untitled programme a word rather than an empty line', () => {
    expect(channelBanner('HRT 1', [{ title: '', start: at(19, 0), stop: at(20, 0) }], at(19, 30)).now?.title).toBe('Programme');
  });
});
