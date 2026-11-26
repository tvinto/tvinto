import crypto from 'crypto';
import { ChangeSet, PullResult, PushResult } from '../../shared/sync';
import { FamilyView } from '../../shared/family';
import { ACCOUNT_TMDB_KEY_PATH } from '../../shared/tmdb/accountKey';

/**
 * The sync service, as the CLI talks to it: the same paths and the same
 * envelope the app uses (worker/src/index.ts).
 *
 * `fetch` is handed in, so the tests drive the real Worker in-process and a
 * person's run drives the real service, through the same code.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Something the service said no to, with what it said. */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** What `POST /api/accounts/login` answers. */
export interface SignedIn {
  token: string;
  user: { id: number; username: string };
  scope?: string;
}

/** A sealed subscription row, as `GET /api/accounts/me` lists them. */
export interface ProviderRow {
  id: string;
  payload: string;
  active: boolean;
}

export class SyncService {
  constructor(
    readonly apiUrl: string,
    private readonly fetch: Fetch,
    private readonly token: string | null = null
  ) {}

  /** `/api/health`'s data, or null when what answered is not a sync service at all. */
  async health(): Promise<{ service?: string; tools?: boolean; toolApproval?: boolean } | null> {
    try {
      const response = await this.fetch(`${this.apiUrl}/health`);
      const body = (await response.json()) as { success?: boolean; data?: { service?: string; tools?: boolean; toolApproval?: boolean } };
      return body?.success === true && body.data?.service === 'sync' ? body.data : null;
    } catch {
      return null;
    }
  }

  salt(username: string): Promise<{ salt: string; cost: number; blockSize: number; parallelism: number }> {
    return this.call('GET', `/accounts/salt?username=${encodeURIComponent(username)}`);
  }

  login(username: string, auth: string, tool: { name: string; history: boolean }): Promise<SignedIn> {
    return this.call('POST', '/accounts/login', { username, auth, tool });
  }

  /** Asks to be let in, for a device of the account to allow (worker/src/toolRequests.ts). */
  requestSignIn(username: string, name: string, history: boolean, publicKey: string): Promise<{ id: string; code: string; secret: string }> {
    return this.call('POST', '/tools/requests', { username, name, history, publicKey });
  }

  /** How that went. Answered once; after that, 404. */
  async pollSignIn(
    id: string,
    secret: string,
    confirm?: string
  ): Promise<{ status: string; wrong?: boolean; sealedToken?: string; sealedEnc?: string; username?: string }> {
    const headers: Record<string, string> = { 'X-Tool-Secret': secret };
    if (confirm) {
      headers['X-Tool-Confirm'] = confirm;
    }
    const response = await this.fetch(`${this.apiUrl}/tools/requests/${id}`, { headers });
    const answer = (await response.json().catch(() => null)) as { data?: { status: string }; message?: string } | null;
    if (!response.ok) {
      throw new ServiceError(answer?.message ?? `The sync service answered ${response.status}`, response.status);
    }
    return answer!.data as never;
  }

  me(): Promise<{
    user: { id: number; username: string; role?: string; createdAt?: string };
    providers: ProviderRow[];
  }> {
    return this.call('GET', '/accounts/me');
  }

  /** Everything the session may see, from the beginning. */
  pull(): Promise<PullResult> {
    return this.call('GET', '/devices/changes');
  }

  /** Sends changes through the feed, as any device does. */
  push(changes: ChangeSet): Promise<PushResult> {
    return this.call('POST', '/devices/changes', changes);
  }

  /** Asks the app to do what only a person may (worker/src/toolActions.ts). */
  askApp(kind: string, details: object): Promise<{ id: string }> {
    return this.call('POST', '/accounts/tools/actions', { kind, details });
  }

  /** How that went: pending, done or refused. */
  askedStatus(id: string): Promise<{ status: string }> {
    return this.call('GET', `/accounts/tools/actions/${id}`);
  }

  /** How this talks to the service, for a session made from this one. */
  get fetchFn(): Fetch {
    return this.fetch;
  }

  /** A session for setting a family member up: setup, never the member's own. */
  setUpMember(memberId: number): Promise<{ token: string }> {
    return this.call('POST', `/family/members/${memberId}/session`, { scope: 'setup' });
  }

  /** A member's role, or whether it is a profile on its managers' devices. */
  changeMember(memberId: number, change: { role?: string; household?: boolean; picture?: string | null }): Promise<unknown> {
    return this.call('POST', `/family/members/${memberId}`, change);
  }

  /** This account's own profile picture (shared/profilePicture.ts). */
  setPicture(picture: string | null): Promise<unknown> {
    return this.call('POST', '/accounts/picture', { picture });
  }

  /** The account's own TMDB key, sealed (shared/tmdb/accountKey.ts). */
  setTmdbKey(payload: string): Promise<unknown> {
    return this.call('POST', ACCOUNT_TMDB_KEY_PATH, { payload });
  }

  forgetTmdbKey(): Promise<unknown> {
    return this.call('DELETE', ACCOUNT_TMDB_KEY_PATH);
  }

  family(): Promise<FamilyView> {
    return this.call('GET', '/family');
  }

  /** Ends this tool's own session. */
  signOut(): Promise<unknown> {
    if (!this.token) {
      return Promise.resolve(null);
    }
    return this.call('DELETE', `/accounts/tools/${sessionIdOf(this.token)}`);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new ServiceError(`The sync service could not be reached (${(error as Error).message})`, 0);
    }
    const answer = (await response.json().catch(() => null)) as { data?: T; message?: string; error?: string } | null;
    if (!response.ok) {
      throw new ServiceError(answer?.message ?? answer?.error ?? `The sync service answered ${response.status}`, response.status);
    }
    return answer?.data as T;
  }
}

/**
 * A session's public id, as the service names it: the start of the token's
 * SHA-256 (worker/src/sessions.ts). Worked out here, so the CLI can sign
 * itself out without being able to list anything.
 */
export const sessionIdOf = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
