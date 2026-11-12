import { isOnAt, parseXmltvTime } from './xmltvTime';

const utc = (iso: string) => Date.parse(iso);

describe('parseXmltvTime', () => {
  it('reads the full form with an offset', () => {
    expect(parseXmltvTime('20260827180000 +0200')).toBe(utc('2026-08-27T16:00:00Z'));
  });

  it('reads a negative offset', () => {
    expect(parseXmltvTime('20260827180000 -0500')).toBe(utc('2026-08-27T23:00:00Z'));
  });

  it('reads an offset with minutes in it', () => {
    expect(parseXmltvTime('20260827180000 +0530')).toBe(utc('2026-08-27T12:30:00Z'));
  });

  it('accepts the offset without a space before it', () => {
    expect(parseXmltvTime('20260827180000+0200')).toBe(utc('2026-08-27T16:00:00Z'));
  });

  it('accepts Z for UTC', () => {
    expect(parseXmltvTime('20260827180000Z')).toBe(utc('2026-08-27T18:00:00Z'));
  });

  // The specification says the offset is always there. Real feeds disagree,
  // and UTC is the only answer that is not a coincidence -- the device's own
  // timezone is not the feed's.
  it('reads a timestamp with no offset as UTC', () => {
    expect(parseXmltvTime('20260827180000')).toBe(utc('2026-08-27T18:00:00Z'));
  });

  it('fills in missing seconds and minutes', () => {
    expect(parseXmltvTime('202608271800')).toBe(utc('2026-08-27T18:00:00Z'));
    expect(parseXmltvTime('2026082718')).toBe(utc('2026-08-27T18:00:00Z'));
    expect(parseXmltvTime('20260827')).toBe(utc('2026-08-27T00:00:00Z'));
  });

  it('ignores surrounding whitespace', () => {
    expect(parseXmltvTime('  20260827180000 +0200  ')).toBe(utc('2026-08-27T16:00:00Z'));
  });

  it('returns null for nothing at all', () => {
    expect(parseXmltvTime('')).toBeNull();
    expect(parseXmltvTime(undefined)).toBeNull();
    expect(parseXmltvTime(null)).toBeNull();
  });

  it('returns null for text that is not a timestamp', () => {
    expect(parseXmltvTime('tomorrow')).toBeNull();
    expect(parseXmltvTime('2026-08-27T18:00:00Z')).toBeNull();
  });

  // A year alone would place a programme at midnight on the first of January,
  // which is a wrong answer wearing the clothes of a right one.
  it('returns null for a year with no month or day', () => {
    expect(parseXmltvTime('2026')).toBeNull();
    expect(parseXmltvTime('202608')).toBeNull();
  });

  // Date.UTC rolls the 32nd forward into the next month rather than objecting,
  // which would put a programme on a day it is not on.
  it('returns null for a date that does not exist', () => {
    expect(parseXmltvTime('20260832180000')).toBeNull();
    expect(parseXmltvTime('20260231180000')).toBeNull();
    expect(parseXmltvTime('20261301180000')).toBeNull();
  });

  it('accepts the leap day in a leap year and rejects it otherwise', () => {
    expect(parseXmltvTime('20240229120000')).toBe(utc('2024-02-29T12:00:00Z'));
    expect(parseXmltvTime('20260229120000')).toBeNull();
  });

  it('handles a programme that crosses midnight in its own zone', () => {
    expect(parseXmltvTime('20260827233000 +0200')).toBe(utc('2026-08-27T21:30:00Z'));
    expect(parseXmltvTime('20260828003000 +0200')).toBe(utc('2026-08-27T22:30:00Z'));
  });
});

describe('isOnAt', () => {
  const start = utc('2026-08-27T18:00:00Z');
  const stop = utc('2026-08-27T19:00:00Z');

  it('is on at its start', () => {
    expect(isOnAt(start, stop, start)).toBe(true);
  });

  it('is on in the middle', () => {
    expect(isOnAt(start, stop, utc('2026-08-27T18:30:00Z'))).toBe(true);
  });

  // Otherwise the programme that has just ended and the one just starting are
  // both "now", and the guide shows two current programmes on one channel.
  it('is not on at its stop', () => {
    expect(isOnAt(start, stop, stop)).toBe(false);
  });

  it('is not on before it starts', () => {
    expect(isOnAt(start, stop, utc('2026-08-27T17:59:59Z'))).toBe(false);
  });
});
