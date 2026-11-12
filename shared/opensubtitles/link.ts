/**
 * An app account's link to an OpenSubtitles account, and the decisions around
 * signing it in.
 *
 * The username and password are sealed on the device under the account's own
 * key (`shared/auth/secretBox.ts`) and kept by the sync service as a blob it
 * cannot read, the way the subscription is. They have to be kept: a token lasts
 * 24 hours, and without the password every device would ask the person to link
 * again every day -- a television, where typing is the worst part, most of all.
 *
 * Pure, so the rules can be tested without a network or a WebView.
 */

export interface SubtitleLink {
  username: string;
  password: string;
  linkedAt: string;
}

/**
 * Why a username cannot be used, or null when it can.
 *
 * OpenSubtitles' website signs in with an email or a username, but their API
 * takes only the username: an email comes back as "invalid username/password -
 * remember to use your username and not your email". Caught here so the person
 * is told what to type instead of being told their password is wrong -- and so
 * a sign-in that cannot succeed does not count against their 30 an hour.
 */
export const usernameProblem = (username: string): string | null =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username.trim())
    ? 'Use your OpenSubtitles username here, not your email: apps can only sign in with the username. ' +
      'It is shown on opensubtitles.com when you are signed in, under your profile.'
    : null;

/** A token in memory, and when it was obtained. */
export interface HeldSession {
  token: string;
  host: string;
  obtainedAt: number;
}

/**
 * How long a token is trusted before logging in again unprompted.
 *
 * Theirs last 24 hours. An hour short of that, so a token is not used in the
 * minute it runs out; an expired one is still caught and retried once.
 */
export const SESSION_TRUST_MS = 23 * 60 * 60 * 1000;

/** What goes inside the sealed blob. */
export const linkPayload = (username: string, password: string, now: Date = new Date()): string =>
  JSON.stringify({ username: username.trim(), password, linkedAt: now.toISOString() } satisfies SubtitleLink);

/** The link out of an opened blob, or null for anything that is not one. */
export const parseLink = (opened: string | null): SubtitleLink | null => {
  if (!opened) {
    return null;
  }
  try {
    const value = JSON.parse(opened) as Partial<SubtitleLink>;
    if (typeof value.username !== 'string' || !value.username || typeof value.password !== 'string' || !value.password) {
      return null;
    }
    return {
      username: value.username,
      password: value.password,
      linkedAt: typeof value.linkedAt === 'string' ? value.linkedAt : ''
    };
  } catch {
    return null;
  }
};

/** Whether a held token can be used, or a login is needed first. */
export const sessionUsable = (session: HeldSession | null, now: number): session is HeldSession =>
  !!session && !!session.token && now - session.obtainedAt < SESSION_TRUST_MS;

/**
 * Whether signing in again is worth trying after a failure.
 *
 * Only for an expired session, and only once per request. A wrong password is
 * never retried: OpenSubtitles limits logins to 30 an hour and asks clients to
 * stop after a 401, and the same password will not become right. The person is
 * asked to link again instead.
 */
export const retryAfterSignIn = (problem: string, alreadyRetried: boolean): boolean =>
  problem === 'signed-out' && !alreadyRetried;

/** The User-Agent OpenSubtitles asks for: the app's name and version. */
export const userAgentFor = (version: string): string => `Xtream v${version || '0'}`;

/**
 * When today's downloads come back, as a local clock time and a time left.
 *
 * Their counters reset at midnight UTC -- 02:00 in Croatia in summer, 01:00 in
 * winter -- so a fixed hour on a screen would be wrong half the year. Taken from
 * `reset_time_utc` when OpenSubtitles gave one, otherwise the next midnight UTC.
 */
export const allowanceReset = (
  resetTimeUtc: string | null,
  now: Date = new Date(),
  locale?: string,
  timeZone?: string
): { at: Date; clock: string; left: string } => {
  const given = resetTimeUtc ? new Date(resetTimeUtc) : null;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const at = given && !Number.isNaN(given.getTime()) && given.getTime() > now.getTime() ? given : next;

  const clock = new Intl.DateTimeFormat(locale ?? 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {})
  }).format(at);

  const minutes = Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  const left = hours > 0 ? `${hours} h ${minutes % 60} m` : `${minutes} m`;

  return { at, clock, left };
};
