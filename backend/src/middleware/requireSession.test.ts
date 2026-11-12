import { Request, Response } from 'express';
import { readBearerToken, requireSession } from './requireSession';
import { sessionStore } from '../utils/sessions';
import { accountsService } from '../services/accounts.service';
import { resetDatabase } from '../test-utils/seed';

/** An account with a subscription, which is what a usable session needs. */
const signedInUser = async () => {
  const user = await accountsService.register('joe', 'a-good-long-password');
  accountsService.addProviderAccount(user.id, {
    serverUrl: 'http://provider.example',
    username: 'joe-line',
    password: 'hunter2'
  });
  return user.id;
};

beforeEach(() => resetDatabase({ withAccount: false }));

const asRequest = (authorization?: string): Request =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as Request;

const mockResponse = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

describe('readBearerToken', () => {
  it('reads the token from a bearer header', () => {
    expect(readBearerToken(asRequest('Bearer abc123'))).toBe('abc123');
  });

  it('accepts any casing of the scheme', () => {
    expect(readBearerToken(asRequest('bearer abc123'))).toBe('abc123');
    expect(readBearerToken(asRequest('BEARER abc123'))).toBe('abc123');
  });

  it('trims surrounding whitespace', () => {
    expect(readBearerToken(asRequest('Bearer   abc123  '))).toBe('abc123');
  });

  it('rejects a header with no token after the scheme', () => {
    expect(readBearerToken(asRequest('Bearer '))).toBeNull();
    expect(readBearerToken(asRequest('Bearer    '))).toBeNull();
  });

  it('rejects other authentication schemes', () => {
    expect(readBearerToken(asRequest('Basic am9lOmh1bnRlcjI='))).toBeNull();
  });

  it('rejects a missing header', () => {
    expect(readBearerToken(asRequest())).toBeNull();
  });
});

describe('requireSession', () => {
  it('attaches the credentials and continues for a valid token', async () => {
    const token = sessionStore.createForUser(await signedInUser());
    const req = asRequest(`Bearer ${token}`);
    const res = mockResponse();
    const next = jest.fn();

    requireSession(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    // Read from the stored subscription, not carried in the session.
    expect(req.xtream).toEqual({
      username: 'joe-line',
      password: 'hunter2',
      serverUrl: 'http://provider.example'
    });
    expect(req.sessionToken).toBe(token);
  });

  it('rejects a request with no token', () => {
    const res = mockResponse();
    const next = jest.fn();

    requireSession(asRequest(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Authentication required');
  });

  it('rejects a token the store does not know', () => {
    const res = mockResponse();
    const next = jest.fn();

    requireSession(asRequest('Bearer stale-token'), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Session expired or invalid');
  });

  it('rejects a token after its session is destroyed', async () => {
    const token = sessionStore.createForUser(await signedInUser());
    sessionStore.destroy(token);

    const req = asRequest(`Bearer ${token}`);
    const res = mockResponse();
    const next = jest.fn();

    requireSession(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(req.xtream).toBeUndefined();
  });

  it('refuses an account with no subscription, distinctly from being signed out', async () => {
    // Signed in, but nothing to answer a browse request with. Not a 401: the
    // client should send them to add a subscription, not to sign in again.
    const user = await accountsService.register('newcomer', 'a-good-long-password');
    const token = sessionStore.createForUser(user.id);
    const res = mockResponse();
    const next = jest.fn();

    requireSession(asRequest(`Bearer ${token}`), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
  });

  it('never echoes the token back to the caller', () => {
    const res = mockResponse();
    requireSession(asRequest('Bearer stale-token'), res, jest.fn());

    expect(JSON.stringify(res.body)).not.toContain('stale-token');
  });
});
