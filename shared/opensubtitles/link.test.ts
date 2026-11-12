import { open, seal } from '../auth/secretBox';
import {
  SESSION_TRUST_MS,
  allowanceReset,
  linkPayload,
  parseLink,
  retryAfterSignIn,
  sessionUsable,
  userAgentFor,
  usernameProblem
} from './link';

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

describe('the sealed link', () => {
  it('round-trips through a box and cannot be read in it', async () => {
    const sealed = await seal(linkPayload(' marko.hr ', 'tajna lozinka', new Date('2026-09-15T20:00:00Z')), KEY);

    expect(sealed).not.toContain('marko');
    expect(sealed).not.toContain('tajna');
    expect(parseLink(await open(sealed, KEY))).toEqual({
      username: 'marko.hr',
      password: 'tajna lozinka',
      linkedAt: '2026-09-15T20:00:00.000Z'
    });
  });

  it('is nothing when the account key has changed since it was sealed', async () => {
    const sealed = await seal(linkPayload('marko.hr', 'tajna'), KEY);

    expect(parseLink(await open(sealed, OTHER_KEY))).toBeNull();
  });

  it('is nothing when it does not hold a username and password', () => {
    expect(parseLink(null)).toBeNull();
    expect(parseLink('not json')).toBeNull();
    expect(parseLink(JSON.stringify({ username: 'marko.hr' }))).toBeNull();
    expect(parseLink(JSON.stringify({ username: '', password: 'x' }))).toBeNull();
  });
});

describe('what can be signed in with', () => {
  it('turns away an email before asking OpenSubtitles, and says what to type instead', () => {
    expect(usernameProblem('marko@example.com')).toContain('username');
    expect(usernameProblem(' marko.hr ')).toBeNull();
    expect(usernameProblem('marko@home')).toBeNull();
  });
});

describe('when to sign in', () => {
  const NOW = 1_800_000_000_000;

  it('uses a token for most of its day, and not in its last hour', () => {
    expect(sessionUsable(null, NOW)).toBe(false);
    expect(sessionUsable({ token: 't', host: 'api.opensubtitles.com', obtainedAt: NOW - 60_000 }, NOW)).toBe(true);
    expect(sessionUsable({ token: 't', host: 'api.opensubtitles.com', obtainedAt: NOW - SESSION_TRUST_MS }, NOW)).toBe(false);
    expect(sessionUsable({ token: '', host: 'api.opensubtitles.com', obtainedAt: NOW }, NOW)).toBe(false);
  });

  it('signs in again once for an expired session, and never for a wrong password', () => {
    expect(retryAfterSignIn('signed-out', false)).toBe(true);
    expect(retryAfterSignIn('signed-out', true)).toBe(false);
    expect(retryAfterSignIn('bad-login', false)).toBe(false);
    expect(retryAfterSignIn('allowance-used', false)).toBe(false);
  });

  it('names the app and its version', () => {
    expect(userAgentFor('1.0.33')).toBe('Xtream v1.0.33');
  });
});

describe('when the downloads come back', () => {
  it('is midnight UTC, shown in local time: 02:00 in Zagreb in summer', () => {
    const reset = allowanceReset(null, new Date('2026-09-15T21:37:00Z'), 'hr-HR', 'Europe/Zagreb');

    expect(reset.at.toISOString()).toBe('2026-09-16T00:00:00.000Z');
    expect(reset.clock).toBe('02:00');
    expect(reset.left).toBe('2 h 23 m');
  });

  it('is 01:00 in Zagreb in winter', () => {
    expect(allowanceReset(null, new Date('2026-12-01T10:00:00Z'), 'hr-HR', 'Europe/Zagreb').clock).toBe('01:00');
  });

  it('takes the time OpenSubtitles gave when there is one in the future', () => {
    const reset = allowanceReset('2026-09-16T00:00:00.000Z', new Date('2026-09-15T23:50:00Z'), 'en-GB', 'UTC');

    expect(reset.clock).toBe('00:00');
    expect(reset.left).toBe('10 m');
  });

  it('ignores a given time that has already passed', () => {
    const reset = allowanceReset('2026-09-14T00:00:00.000Z', new Date('2026-09-15T12:00:00Z'), 'en-GB', 'UTC');

    expect(reset.at.toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });
});
