import { NO_AGE_LOCK, ageLocks, loosens, ratingAge, readAgeLock, writeAgeLock } from './age';

describe('Age-rating lock', () => {
  it('reads ages and the words countries use', () => {
    expect(ratingAge('16')).toBe(16);
    expect(ratingAge('FSK 16')).toBe(16);
    expect(ratingAge('18+')).toBe(18);
    expect(ratingAge('R')).toBe(17);
    expect(ratingAge('PG-13')).toBe(13);
    expect(ratingAge('TV-MA')).toBe(17);
    expect(ratingAge('12A')).toBe(12);
    expect(ratingAge('U')).toBe(0);
    expect(ratingAge('')).toBeNull();
    expect(ratingAge('Unrated')).toBeNull();
  });

  it("locks by the chosen country's rating, then Germany's, then the United States'", () => {
    const lock = { limit: 16, country: 'HR' };
    expect(ageLocks(lock, { HR: '15', DE: '16' })).toBe(false);
    expect(ageLocks(lock, { DE: '16', US: 'PG-13' })).toBe(true);
    expect(ageLocks(lock, { US: 'R' })).toBe(true);
    expect(ageLocks({ limit: 16, country: 'GB' }, { GB: '15', DE: '16' })).toBe(false);
  });

  it('leaves open what has no rating, and everything when off', () => {
    expect(ageLocks({ limit: 12, country: 'HR' }, {})).toBe(false);
    expect(ageLocks({ limit: 12, country: 'HR' }, { FR: '16' })).toBe(false);
    expect(ageLocks(NO_AGE_LOCK, { DE: '18' })).toBe(false);
  });

  it('reads the stored setting leniently and writes it back the same', () => {
    expect(readAgeLock(writeAgeLock({ limit: 16, country: 'DE' }))).toEqual({ limit: 16, country: 'DE' });
    expect(readAgeLock('')).toEqual(NO_AGE_LOCK);
    expect(readAgeLock('{"limit":"x","country":"croatia"}')).toEqual(NO_AGE_LOCK);
  });

  it('needs the PIN only for a change that opens something up', () => {
    const sixteen = { limit: 16, country: 'HR' };
    expect(loosens(NO_AGE_LOCK, sixteen)).toBe(false);
    expect(loosens(sixteen, { limit: 12, country: 'HR' })).toBe(false);
    expect(loosens(sixteen, { limit: 18, country: 'HR' })).toBe(true);
    expect(loosens(sixteen, NO_AGE_LOCK)).toBe(true);
    expect(loosens(sixteen, { limit: 16, country: 'US' })).toBe(true);
  });
});
