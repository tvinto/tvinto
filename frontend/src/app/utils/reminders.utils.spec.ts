import { Reminder, current, due, readReminders, reminderKey, toggled } from './reminders.utils';

const AT = Date.parse('2026-10-03T20:00:00Z');
const MIN = 60 * 1000;

const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  streamId: '7',
  channel: 'HRT 1',
  icon: null,
  title: 'Dnevnik',
  start: AT,
  stop: AT + 30 * MIN,
  ...over
});

describe('reminders', () => {
  it('go off a minute before the start, not earlier', () => {
    expect(due([reminder()], AT - 2 * MIN)).toEqual([]);
    expect(due([reminder()], AT - MIN)).toHaveLength(1);
  });

  it('still go off on a device that was asleep at the start, while the programme lasts', () => {
    expect(due([reminder()], AT + 10 * MIN)).toHaveLength(1);
    expect(due([reminder()], AT + 30 * MIN)).toEqual([]);
  });

  it('go off once', () => {
    expect(due([reminder({ firedAt: '2026-10-03T19:59:00Z' })], AT)).toEqual([]);
  });

  it('are dropped once the programme is over', () => {
    expect(current([reminder(), reminder({ start: AT - 60 * MIN, stop: AT - MIN })], AT)).toHaveLength(1);
  });

  it('are set by pressing a programme, and taken away by pressing it again', () => {
    const set = toggled([], reminder());
    expect(set).toHaveLength(1);
    expect(toggled(set, reminder())).toEqual([]);
  });

  it('are one per programme on a channel', () => {
    expect(reminderKey('pabc~7', AT)).not.toBe(reminderKey('7', AT));
    expect(toggled([reminder()], reminder({ streamId: '8' }))).toHaveLength(2);
  });

  it('read damaged storage as none', () => {
    expect(readReminders('{nope')).toEqual([]);
    expect(readReminders(JSON.stringify([reminder(), { streamId: 3 }]))).toHaveLength(1);
  });
});
