import crypto from 'crypto';
import { db } from './database';

export interface XtreamCredentials {
  username: string;
  password: string;
  serverUrl?: string;
}

/**
 * What a token stands for: an account, and nothing else.
 *
 * The subscription behind it is read fresh on every request, so renewing
 * credentials takes effect at once rather than at the next sign-in.
 */
export interface SessionSubject {
  userId: number;
}

interface Session {
  subject: SessionSubject;
  createdAt: number;
  lastUsedAt: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours idle
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Holds who a caller is, keyed by an opaque token handed to the client.
 * Requests carry the token rather than any password, so credentials stay out of
 * URLs, access logs and browser storage.
 *
 * Sessions are written to disk, so a restart does not sign everyone out. That
 * is only safe because a session stopped being a copy of the credentials and
 * became the name of an account -- there is nothing secret in one any more.
 * The token is stored hashed even so: whoever holds it is signed in, and a
 * copy of the database should not hand out live sessions.
 */
class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor() {
    const sweep = setInterval(() => this.removeExpired(), SWEEP_INTERVAL_MS);
    // Do not hold the process open just for the sweep.
    sweep.unref?.();
  }

  /** Starts a session for a signed-in account, and remembers it across restarts. */
  createForUser(userId: number): string {
    const token = this.store({ userId });
    const now = new Date().toISOString();

    try {
      db.prepare(
        'INSERT OR REPLACE INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)'
      ).run(hashToken(token), userId, now, now);
    } catch (error) {
      // Worth continuing without: the session works for as long as this process
      // lives, which is what it did before it was written down at all.
      console.warn('Could not persist the session', error);
    }

    return token;
  }

  /** Who the token stands for, refreshing its idle timer. */
  resolve(token: string): SessionSubject | null {
    const session = this.sessions.get(token) ?? this.recover(token);
    if (!session) {
      return null;
    }

    if (Date.now() - session.lastUsedAt > SESSION_TTL_MS) {
      this.sessions.delete(token);
      return null;
    }

    session.lastUsedAt = Date.now();
    return session.subject;
  }

  /** The user behind a token, or null when there is no live session for it. */
  resolveUserId(token: string): number | null {
    return this.resolve(token)?.userId ?? null;
  }

  destroy(token: string): boolean {
    const known = this.sessions.delete(token);
    const stored = db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return known || stored.changes > 0;
  }

  /** Ends every session for a user, so a password change signs other devices out. */
  destroyForUser(userId: number): number {
    let ended = 0;
    for (const [token, session] of this.sessions) {
      if (session.subject.userId === userId) {
        this.sessions.delete(token);
        ended++;
      }
    }

    // Devices that have not been seen since the last restart hold tokens this
    // process has never had in memory, and are exactly the ones a password
    // change most needs to reach.
    const stored = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return Math.max(ended, stored.changes);
  }

  /**
   * Reinstates a session this process has not seen, from disk.
   *
   * How a device stays signed in across a restart. The idle timer applies just
   * as it does in memory, so an old row is not a way around expiry.
   */
  private recover(token: string): Session | null {
    const row = db
      .prepare('SELECT user_id, created_at, last_used_at FROM sessions WHERE token_hash = ?')
      .get(hashToken(token)) as
      | { user_id: number; created_at: string; last_used_at: string }
      | undefined;

    if (!row) {
      return null;
    }

    const lastUsedAt = Date.parse(row.last_used_at);
    if (!Number.isFinite(lastUsedAt) || Date.now() - lastUsedAt > SESSION_TTL_MS) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      return null;
    }

    const session: Session = {
      subject: { userId: row.user_id },
      createdAt: Date.parse(row.created_at) || Date.now(),
      lastUsedAt
    };

    this.sessions.set(token, session);
    return session;
  }

  private store(subject: SessionSubject): string {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.sessions.set(token, { subject, createdAt: now, lastUsedAt: now });
    return token;
  }

  private removeExpired(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [token, session] of this.sessions) {
      if (session.lastUsedAt < cutoff) {
        this.sessions.delete(token);
      }
    }

    try {
      db.prepare('DELETE FROM sessions WHERE last_used_at < ?').run(
        new Date(cutoff).toISOString()
      );
    } catch {
      // The in-memory sweep has already done the part that matters now.
    }
  }
}

/**
 * A token is 256 bits of randomness, so a plain digest is enough: there is
 * nothing to guess and so nothing for a slow hash to slow down.
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export const sessionStore = new SessionStore();
