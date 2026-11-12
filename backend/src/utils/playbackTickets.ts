import crypto from 'crypto';
import { StreamType } from '../../../shared/types';

export interface PlaybackClaim {
  sessionToken: string;
  type: StreamType;
  streamId: string;
  extension?: string;
}

interface Ticket extends PlaybackClaim {
  expiresAt: number;
}

const TICKET_TTL_MS = 60 * 60 * 1000; // long enough to watch, short enough to expire
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Short-lived, single-stream handles used in playback URLs.
 *
 * A media element cannot attach an Authorization header, so something has to
 * live in the URL. A ticket is the least dangerous option: it grants one
 * stream, expires on its own, and leaks nothing if it turns up in a log.
 */
class PlaybackTicketStore {
  private readonly tickets = new Map<string, Ticket>();

  constructor() {
    const sweep = setInterval(() => this.removeExpired(), SWEEP_INTERVAL_MS);
    sweep.unref?.();
  }

  issue(sessionToken: string, claim: Omit<PlaybackClaim, 'sessionToken'>): string {
    const ticket = crypto.randomBytes(24).toString('hex');
    this.tickets.set(ticket, {
      sessionToken,
      ...claim,
      expiresAt: Date.now() + TICKET_TTL_MS
    });
    return ticket;
  }

  /**
   * Looks up a ticket. Deliberately not consumed on first use: players reissue
   * range requests and follow redirects more than once for a single stream.
   */
  redeem(ticket: string): PlaybackClaim | null {
    const found = this.tickets.get(ticket);
    if (!found) {
      return null;
    }

    if (Date.now() > found.expiresAt) {
      this.tickets.delete(ticket);
      return null;
    }

    return {
      sessionToken: found.sessionToken,
      type: found.type,
      streamId: found.streamId,
      extension: found.extension
    };
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [ticket, value] of this.tickets) {
      if (now > value.expiresAt) {
        this.tickets.delete(ticket);
      }
    }
  }
}

export const playbackTickets = new PlaybackTicketStore();
