import { WatchProgress } from './types';
import { StartingUp, lastChannel, openLastChannelValue, opensLastChannel, shouldOpenLastChannel } from './startup';

const start = (changes: Partial<StartingUp> = {}): StartingUp => ({
  asked: true,
  television: true,
  firstThisRun: true,
  openedByLink: false,
  page: '/for-you',
  ...changes
});

const entry = (changes: Partial<WatchProgress> = {}): WatchProgress => ({
  type: 'live',
  itemId: '101',
  name: 'HRT 1',
  icon: null,
  positionSeconds: 0,
  durationSeconds: 0,
  completed: false,
  updatedAt: '2026-10-06T18:00:00Z',
  ...changes
});

describe('the setting', () => {
  it('is on only when it says so', () => {
    expect(opensLastChannel('on')).toBe(true);
    expect(opensLastChannel('off')).toBe(false);
    expect(opensLastChannel(null)).toBe(false);
    expect(opensLastChannel(undefined)).toBe(false);
    expect(opensLastChannel('true')).toBe(false);
  });

  it('writes what it reads', () => {
    expect(opensLastChannel(openLastChannelValue(true))).toBe(true);
    expect(opensLastChannel(openLastChannelValue(false))).toBe(false);
  });
});

describe('shouldOpenLastChannel', () => {
  it('opens into the channel when a television starts on For You', () => {
    expect(shouldOpenLastChannel(start())).toBe(true);
  });

  it('does not when nobody asked for it', () => {
    expect(shouldOpenLastChannel(start({ asked: false }))).toBe(false);
  });

  it('does not on anything but a television', () => {
    expect(shouldOpenLastChannel(start({ television: false }))).toBe(false);
  });

  it('does not when the page restarted under somebody: a profile switch, an update', () => {
    expect(shouldOpenLastChannel(start({ firstThisRun: false }))).toBe(false);
  });

  it('does not when a link opened the app on something else', () => {
    expect(shouldOpenLastChannel(start({ openedByLink: true }))).toBe(false);
  });

  it('does not on any page but For You: setting up a subscription, a page a restart asked for', () => {
    expect(shouldOpenLastChannel(start({ page: '/subscription' }))).toBe(false);
    expect(shouldOpenLastChannel(start({ page: '/account' }))).toBe(false);
  });
});

describe('lastChannel', () => {
  it('is the newest entry when it is a channel', () => {
    expect(lastChannel([entry(), entry({ itemId: '102' })])?.itemId).toBe('101');
  });

  it('is none when nothing has been watched', () => {
    expect(lastChannel([])).toBeNull();
  });

  it('is none when the newest is a film or an episode, not an older channel', () => {
    expect(lastChannel([entry({ type: 'vod', itemId: '7' }), entry()])).toBeNull();
    expect(lastChannel([entry({ type: 'series', itemId: '8', seriesId: '3' })])).toBeNull();
  });

  it('is none for an entry with no id', () => {
    expect(lastChannel([entry({ itemId: '' })])).toBeNull();
  });
});
