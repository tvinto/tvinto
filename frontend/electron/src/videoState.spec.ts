import { VideoState, VideoStateMessage } from './videoState';

describe('VideoState', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const make = () => {
    const sent: VideoStateMessage[] = [];
    const state = new VideoState(message => sent.push(message), { title: 'Dnevnik', live: true, channels: true });
    return { state, sent, last: () => sent[sent.length - 1] };
  };

  it('says it is open at once, and closed at the end', () => {
    const { state, sent, last } = make();
    expect(sent[0].open).toBe(true);
    state.close();
    expect(last().open).toBe(false);
  });

  it('shows what show-text was asked, once for each $, and takes it down after its time', () => {
    const { state, last } = make();
    state.text('Costs $$5', 3000);
    expect(last().osd).toBe('Costs $5');
    jest.advanceTimersByTime(3001);
    expect(last().osd).toBeNull();
  });

  it('takes a line down when asked with an empty one', () => {
    const { state, last } = make();
    state.text('Reconnecting…', 120_000);
    state.text('', 0);
    expect(last().osd).toBeNull();
  });

  it('splits mpv tracks into audio and subtitles', () => {
    const { state, last } = make();
    state.tracks([
      { id: 1, type: 'video', selected: true },
      { id: 1, type: 'audio', lang: 'eng', title: 'English 2.0', selected: true },
      { id: 2, type: 'audio', lang: 'hrv', selected: false },
      { id: 1, type: 'sub', lang: 'eng', selected: false }
    ]);
    state.paused(true);
    expect(last().audio).toEqual([
      { id: 1, title: 'English 2.0', lang: 'eng', selected: true },
      { id: 2, title: '', lang: 'hrv', selected: false }
    ]);
    expect(last().subtitles).toEqual([{ id: 1, title: '', lang: 'eng', selected: false }]);
  });

  it('sends the badge and the skip offer as they change, and the position with the next tick', () => {
    const { state, sent, last } = make();
    state.badge({ line: 'PAUSED · 0:10', hint: 'Back to live · End' });
    expect(last().badge?.line).toBe('PAUSED · 0:10');
    const count = sent.length;
    state.badge({ line: 'PAUSED · 0:10', hint: 'Back to live · End' });
    expect(sent.length).toBe(count);
    state.skip('Skip intro · Enter');
    expect(last().skip).toBe('Skip intro · Enter');
    state.position(42.5);
    jest.advanceTimersByTime(500);
    expect(last().positionSeconds).toBe(42.5);
  });
});
